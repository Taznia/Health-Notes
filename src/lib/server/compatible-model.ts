import { z } from "zod";
import type { Stage } from "../schemas";
import { ProviderHttpError, WorkflowError } from "./errors";
import { parseModelOutput } from "./model-output";
import type { Provider } from "./provider-routing";

type CompatibleProvider = Exclude<Provider, "groq">;
type Options = {
  provider: CompatibleProvider;
  apiKey: string;
  model: string;
  stage: Stage;
  system: string;
  input: unknown;
  schema: z.ZodType;
  fetcher?: typeof fetch;
};

class InvalidProviderOutput extends Error {
  constructor(readonly fields: string[]) {
    super("Provider output did not match the expected schema");
  }
}

export async function runCompatibleModel<T>(options: Options & { schema: z.ZodType<T> }): Promise<T> {
  const { provider, apiKey, model, stage, system, input, schema } = options;
  const fetcher = options.fetcher ?? fetch;
  const endpoint = provider === "openrouter"
    ? "https://openrouter.ai/api/v1/chat/completions"
    : "https://router.huggingface.co/v1/chat/completions";
  const jsonSchema = z.toJSONSchema(schema);

  async function invoke(repairFields?: string[]): Promise<T> {
    const instructions = repairFields
      ? `${system}\nReturn one complete JSON object matching this schema. Do not omit required safety fields. Correct these fields: ${repairFields.join(", ")}.\n${JSON.stringify(jsonSchema)}`
      : system;
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: instructions },
          { role: "user", content: `Untrusted reported information as JSON:\n${JSON.stringify(input)}` },
        ],
        temperature: 0,
        max_tokens: stage === "questions" ? 900 : 3200,
        response_format: repairFields
          ? { type: "json_object" }
          : { type: "json_schema", json_schema: { name: `health_${stage}`, schema: jsonSchema, strict: true } },
        ...(provider === "openrouter" ? { provider: { ignore: ["groq"], require_parameters: true, data_collection: "deny" } } : {}),
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) throw new ProviderHttpError(provider, response.status, response.headers.get("retry-after"));
    let candidate: unknown;
    try {
      const result = await response.json() as { choices?: { message?: { content?: string } }[] };
      const content = result.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("missing content");
      candidate = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    } catch {
      throw new InvalidProviderOutput(["invalid_json"]);
    }
    const parsed = parseModelOutput(stage, schema, candidate);
    if (parsed.success) return parsed.data;
    throw new InvalidProviderOutput(parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}:${issue.code}`).slice(0, 12));
  }

  try {
    return await invoke();
  } catch (error) {
    if (!(error instanceof InvalidProviderOutput) && !(error instanceof ProviderHttpError && [400, 422].includes(error.status))) throw error;
    try {
      return await invoke(error instanceof InvalidProviderOutput ? error.fields : ["response_format"]);
    } catch (repairError) {
      if (repairError instanceof InvalidProviderOutput) {
        throw new WorkflowError(502, "INVALID_MODEL_OUTPUT", `${provider === "openrouter" ? "OpenRouter" : "Hugging Face"} returned an incomplete response after one repair attempt. Retry this step; completed results are still available.`);
      }
      throw repairError;
    }
  }
}
