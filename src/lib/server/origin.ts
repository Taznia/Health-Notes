import { WorkflowError } from "./errors";

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return; // Non-browser clients are still subject to request validation and deployment rate limits.
  let matches = false;
  try {
    const url = new URL(origin);
    // Next.js can use an internal localhost URL; the Host header is the public
    // host that a browser used to reach this route (including the local port).
    matches = ["http:", "https:"].includes(url.protocol) && url.host === request.headers.get("host");
  } catch { /* Opaque or malformed origins are rejected. */ }
  if (!matches) throw new WorkflowError(403, "INVALID_ORIGIN", "Please send your message from this app's page.");
}
