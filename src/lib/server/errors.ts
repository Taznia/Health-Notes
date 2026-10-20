export class WorkflowError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "WorkflowError";
  }
}

export class ProviderHttpError extends Error {
  constructor(public provider: "openrouter" | "huggingface", public status: number, public retryAfterHeader: string | null) {
    super(`${provider} request failed with status ${status}`);
    this.name = "ProviderHttpError";
  }
}

export function publicError(error: unknown): { status: number; code: string; message: string; retryAfter?: number } {
  if (error instanceof WorkflowError) return { status: error.status, code: error.code, message: error.message };
  if (error instanceof ProviderHttpError) {
    const name = error.provider === "openrouter" ? "OpenRouter" : "Hugging Face";
    if (error.status === 429) {
      const seconds = Number(error.retryAfterHeader);
      return { status: 429, code: "RATE_LIMIT", message: `${name}'s usage limit was reached. Wait, then retry this step; completed results are still available.`, retryAfter: Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.ceil(seconds), 86400) : 60 };
    }
    if (error.status === 402) return { status: 503, code: "PROVIDER_CREDITS", message: `${name} has no available inference credits. Add credits or configure OpenRouter as a fallback.` };
    if (error.status === 401 || error.status === 403) return { status: 503, code: "PROVIDER_AUTH", message: `${name} could not be accessed. Check its server-side API token and model permissions.` };
    if (error.status === 400 || error.status === 422) return { status: 502, code: "MODEL_RESPONSE", message: `${name} could not return the required JSON format. Check that the chosen model supports structured output.` };
    return { status: 502, code: "PROVIDER_UNAVAILABLE", message: `${name} could not finish this step. Try again shortly; completed results are still available.` };
  }
  const value = error as { status?: number; name?: string; code?: string; headers?: { get?: (key: string) => string | null } };
  if (value?.status === 429) {
    const seconds = Number(value.headers?.get?.("retry-after"));
    return { status: 429, code: "RATE_LIMIT", message: "Groq's usage limit was reached. Wait a little, then retry this step. Your completed results are still here.", retryAfter: Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.ceil(seconds), 86400) : 60 };
  }
  if (value?.status === 401 || value?.status === 403) return { status: 503, code: "PROVIDER_AUTH", message: "The app could not access Groq. Check the server's GROQ_API_KEY and model permissions." };
  if (value?.name?.includes("Timeout") || value?.name === "AbortError") return { status: 504, code: "TIMEOUT", message: "This step took too long. Retry it to continue from the last completed step." };
  if (value?.status === 400) return { status: 502, code: "MODEL_RESPONSE", message: "Groq could not return a complete response. Retry this step; completed results are saved in this tab." };
  return { status: 502, code: "PROVIDER_UNAVAILABLE", message: "This step couldn't finish. Check your connection or try again shortly. Your completed results are still here." };
}
