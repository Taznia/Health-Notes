// A setup command, not part of the browser app. Never prints the API key.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

const target = fileURLToPath(new URL("../.env.local", import.meta.url));
if (existsSync(target)) {
  console.log(".env.local already exists; it was not changed. Edit that file if you need to update your key.");
  process.exit(0);
}
const parentEnv = new URL("../../.env", import.meta.url);
let key = process.env.GROQ_API_KEY;
if (!key && existsSync(parentEnv)) key = parseEnv(readFileSync(parentEnv, "utf8")).GROQ_API_KEY;
const usable = !!key && !/^(your_|replace)/i.test(key);
const contents = [
  "# Local server secrets. Never commit this file.",
  `GROQ_API_KEY=${JSON.stringify(usable ? key : "your_groq_api_key")}`,
  "GROQ_MODEL=openai/gpt-oss-20b",
  "OPENROUTER_API_KEY=",
  "OPENROUTER_MODEL=openai/gpt-oss-20b",
  "HF_TOKEN=",
  "HF_MODEL=Qwen/Qwen3.8-27B:cerebras",
  `WORKFLOW_STATE_SECRET=${randomBytes(32).toString("hex")}`,
  "LANGSMITH_TRACING=false",
  "LANGCHAIN_TRACING_V2=false",
  "",
].join("\n");
writeFileSync(target, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
console.log(usable
  ? "Created .env.local with your existing Groq key and a new signing secret. No keys were printed. You can now run npm run dev."
  : "Created .env.local with a new signing secret. Replace the GROQ_API_KEY placeholder in that file, then run npm run dev.");
