import type { Stage } from "../schemas";
import { ProviderHttpError } from "./errors";

export type Provider = "groq" | "openrouter" | "huggingface";

function configured(key: string | undefined): boolean {
  return !!key?.trim() && !/^(your_|replace)/i.test(key.trim());
}

export function providerForStage(stage: Stage, env: { OPENROUTER_API_KEY?: string; HF_TOKEN?: string }): Provider {
  if (stage === "summary" && configured(env.OPENROUTER_API_KEY)) return "openrouter";
  if ((stage === "diet" || stage === "questions") && configured(env.HF_TOKEN)) return "huggingface";
  return "groq";
}

export function shouldFallbackFromHuggingFace(error: unknown): boolean {
  if (error instanceof ProviderHttpError) return [402, 429, 500, 502, 503, 504].includes(error.status);
  return error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError");
}
