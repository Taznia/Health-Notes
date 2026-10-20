// Check that configured private values were not embedded in browser assets.
// Logs counts only, never secret values or asset contents.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

const config = existsSync(".env.local") ? parseEnv(readFileSync(".env.local", "utf8")) : {};
const secrets = [process.env.GROQ_API_KEY || config.GROQ_API_KEY, process.env.WORKFLOW_STATE_SECRET || config.WORKFLOW_STATE_SECRET].filter((value) => value && value.length >= 16 && !/^(your_|replace)/i.test(value));
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
}
assert.ok(existsSync(".next/static"), "Run npm run build first.");
const assets = files(".next/static").filter((file) => /\.(js|css|json)$/.test(file));
for (const file of assets) {
  const data = readFileSync(file, "utf8");
  for (const secret of secrets) assert.equal(data.includes(secret), false, "A private value appeared in a browser asset.");
}
console.log(`Checked ${assets.length} browser assets: no configured private values found.`);
