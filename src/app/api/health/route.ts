import "server-only";
import { requestSchema } from "@/lib/schemas";
import { requireSecret } from "@/lib/server/checkpoint";
import { publicError, WorkflowError } from "@/lib/server/errors";
import { runModel } from "@/lib/server/model";
import { runStage } from "@/lib/server/workflow";
import { assertSameOrigin } from "@/lib/server/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const PRIVATE_HEADERS = { "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" };
const MAX_BODY = 260000;

async function readBody(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json")) throw new WorkflowError(415, "INVALID_REQUEST", "Send a JSON request.");
  if (!request.body || Number(request.headers.get("content-length")) > MAX_BODY) throw new WorkflowError(413, "INPUT_TOO_LARGE", "This request is too large. Start a new report with fewer details.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY) {
      await reader.cancel();
      throw new WorkflowError(413, "INPUT_TOO_LARGE", "This request is too large. Start a new report with fewer details.");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new WorkflowError(400, "INVALID_REQUEST", "The request could not be read. Please try again.");
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const result = requestSchema.safeParse(await readBody(request));
    if (!result.success) throw new WorkflowError(400, "INVALID_REQUEST", "Please send a valid message of at most 8,000 characters or restart the report.");
    const response = await runStage(result.data, { secret: requireSecret(), runModel });
    return Response.json(response, { headers: PRIVATE_HEADERS });
  } catch (error) {
    const { status, ...details } = publicError(error);
    return Response.json({ error: details }, {
      status, headers: { ...PRIVATE_HEADERS, ...(details.retryAfter ? { "Retry-After": String(details.retryAfter) } : {}) },
    });
  }
}
