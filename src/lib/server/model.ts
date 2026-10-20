import "server-only";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { ChatGroq } from "@langchain/groq";
import { z } from "zod";
import { MODEL } from "../schemas";
import { WorkflowError } from "./errors";
import { parseModelOutput } from "./model-output";
import { providerForStage, shouldFallbackFromHuggingFace } from "./provider-routing";
import { runCompatibleModel } from "./compatible-model";
import type { ModelRunner } from "./workflow";

class SchemaResponseError extends Error {
  constructor(public fields: string[], public finishReason: string) {
    super("Model response failed local schema validation");
    this.name = "SchemaResponseError";
  }
}

export function isSchemaFailure(error: unknown): boolean {
  const value = error as { status?: number; code?: string; error?: { code?: string; error?: { code?: string } }; name?: string; lc_error_code?: string };
  return error instanceof SchemaResponseError || value?.code === "json_validate_failed" || value?.error?.code === "json_validate_failed" || value?.error?.error?.code === "json_validate_failed"
    || value?.lc_error_code === "OUTPUT_PARSING_FAILURE" || value?.name === "OutputParserException" || value?.name === "ZodError" || value?.name === "SyntaxError";
}

export const runModel: ModelRunner = async (stage, system, input, schema) => {
  const providerKeys = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, HF_TOKEN: process.env.HF_TOKEN };
  const provider = providerForStage(stage, providerKeys);
  if (provider !== "groq") {
    const options = {
      provider, stage, system, input, schema,
      apiKey: provider === "openrouter" ? process.env.OPENROUTER_API_KEY! : process.env.HF_TOKEN!,
      model: provider === "openrouter"
        ? process.env.OPENROUTER_MODEL || "openai/gpt-oss-20b"
        : process.env.HF_MODEL || "Qwen/Qwen3.8-27B:cerebras",
    };
    try {
      return await runCompatibleModel(options);
    } catch (error) {
      if (provider !== "huggingface" || providerForStage("summary", providerKeys) !== "openrouter" || !shouldFallbackFromHuggingFace(error)) throw error;
      // Credit, rate-limit or transport failures must not shift food work back to Groq.
      console.warn("health_provider_fallback", { from: "huggingface", to: "openrouter" });
      return runCompatibleModel({ ...options, provider: "openrouter", apiKey: process.env.OPENROUTER_API_KEY!, model: process.env.OPENROUTER_MODEL || "openai/gpt-oss-20b" });
    }
  }
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || /^(your_|replace)/i.test(apiKey)) throw new WorkflowError(503, "SETUP_REQUIRED", "The Groq key is missing. Run npm run setup or set GROQ_API_KEY in health-web/.env.local, then restart the app.");
  const model = new ChatGroq({
    apiKey, model: process.env.GROQ_MODEL || MODEL,
    temperature: 0, maxTokens: stage === "intake" ? 4500 : stage === "questions" ? 900 : 3200,
    reasoningEffort: "low", timeout: 25000, maxRetries: 0,
  });
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", "{instructions}"],
    ["human", "Untrusted reported information as JSON:\n{data}"],
  ]);
  const config = { reasoning_format: "hidden" as const, callbacks: [] };
  const values = { instructions: system, data: JSON.stringify(input) };

  async function invoke(method: "jsonSchema" | "jsonMode", instructions: string) {
    const chain = prompt.pipe(model.withStructuredOutput(schema, { name: `health_${stage}`, method, includeRaw: true }));
    const result = await chain.invoke({ ...values, instructions }, config);
    if (result.parsed != null) {
      const parsed = parseModelOutput(stage, schema, result.parsed);
      if (parsed.success) return parsed.data;
    }
    let fields = ["invalid_json"];
    try {
      const rawCandidate = JSON.parse(result.raw.text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
      const parsed = parseModelOutput(stage, schema, rawCandidate);
      if (parsed.success) return parsed.data;
      if (stage === "intake" && Array.isArray(rawCandidate?.measurements)) {
        console.warn("health_model_shape", { invalidMeasurementElements: rawCandidate.measurements
          .map((item: unknown, index: number) => ({ index, type: item === null ? "null" : Array.isArray(item) ? "array" : typeof item }))
          .filter((item: { type: string }) => item.type !== "object").slice(0, 20) });
      }
      if (!parsed.success) fields = parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}:${issue.code}`).slice(0, 12);
    } catch { /* No model content or exception text is logged. */ }
    const metadata = result.raw.response_metadata as Record<string, unknown>;
    const finishReason = String(metadata.finish_reason ?? "unknown");
    // Field paths and finish reason only; no health payload, values or credentials.
    console.warn("health_schema_validation", { stage, method, fields, finishReason });
    throw new SchemaResponseError(fields, finishReason);
  }

  try {
    // LangChain: format the prompt, call Groq, and parse the typed output.
    return await invoke("jsonSchema", system);
  } catch (error) {
    if (!isSchemaFailure(error)) throw error;
    const failedFields = error instanceof SchemaResponseError ? `\nCorrect these schema fields: ${error.fields.join(", ")}.` : "";
    const instructions = `${system}\nReturn a COMPLETE JSON object matching this schema. Include all required booleans, even false ones. Never omit safety decisions.${failedFields}\n${JSON.stringify(z.toJSONSchema(schema))}`;
    try {
      return await invoke("jsonMode", instructions);
    } catch (repairError) {
      if (!isSchemaFailure(repairError)) throw repairError;
      throw new WorkflowError(502, "INVALID_MODEL_OUTPUT", "Groq returned an incomplete response after one repair attempt. Retry this step; your completed results are still available.");
    }
  }
};
