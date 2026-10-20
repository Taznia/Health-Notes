import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { stateSchema, type HealthState } from "../schemas";
import { WorkflowError } from "./errors";

const TTL = 30 * 60 * 1000;

export function requireSecret(secret = process.env.WORKFLOW_STATE_SECRET): string {
  if (!secret || secret.length < 32 || /^(replace|your_|change)/i.test(secret)) {
    throw new WorkflowError(503, "SETUP_REQUIRED", "Run npm run setup in health-web to create the local configuration, then restart the server.");
  }
  return secret;
}

export function newState(now = Date.now()): HealthState {
  return { version: 2, sessionId: randomUUID(), expiresAt: now + TTL, revision: 0, phase: "waiting", sources: [], intake: null, summary: null, diet: null, alerts: [], emergencyNow: false };
}

export function signCheckpoint(state: HealthState, secret: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify(stateSchema.parse({ ...state, expiresAt: now + TTL }))).toString("base64url");
  const signature = createHmac("sha256", requireSecret(secret)).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function readCheckpoint(token: string, secret: string, now = Date.now()): HealthState {
  requireSecret(secret);
  try {
    if (token.length > 220000) throw new Error("size");
    const parts = token.split(".");
    if (parts.length !== 2 || !/^[\w-]+$/.test(parts[0]) || !/^[\w-]+$/.test(parts[1])) throw new Error("format");
    const expected = createHmac("sha256", secret).update(parts[0]).digest();
    const supplied = Buffer.from(parts[1], "base64url");
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new Error("signature");
    const state = stateSchema.parse(JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")));
    if (state.expiresAt <= now) throw new Error("expiry");
    return state;
  } catch {
    throw new WorkflowError(409, "SESSION_EXPIRED", "This conversation checkpoint is invalid or has expired. Start a new report to continue.");
  }
}
