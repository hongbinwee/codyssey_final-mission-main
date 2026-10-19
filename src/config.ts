// .env를 읽어 process.env를 채운다. 이미 있는 환경 변수는 덮어쓰지 않는다
// (테스트가 DATABASE_URL 등을 주입할 수 있게 하기 위함).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { databaseUrlWithPasswordFile } from "./db-url.ts";

try {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || m[1] in process.env) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  // .env가 없으면 실제 환경 변수만 사용한다.
}

if (process.env.DATABASE_PASSWORD_FILE) {
  const passwordFile = process.env.DATABASE_PASSWORD_FILE;
  process.env.DATABASE_URL = databaseUrlWithPasswordFile(
    process.env.DATABASE_URL,
    passwordFile,
  );
  if (process.env.SCRATCH_ADMIN_URL)
    process.env.SCRATCH_ADMIN_URL = databaseUrlWithPasswordFile(
      process.env.SCRATCH_ADMIN_URL,
      passwordFile,
    );

  // Child processes inherit the resolved URL only; the local path is not propagated.
  delete process.env.DATABASE_PASSWORD_FILE;
}

export { databaseUrlForName } from "./db-url.ts";

const configuredSessionSecret = process.env.SESSION_SECRET?.trim();
if (process.env.NODE_ENV === "production" && !configuredSessionSecret)
  throw new Error("SESSION_SECRET is required in production");

const llmApiFormat = process.env.LLM_API_FORMAT ?? "responses";
if (llmApiFormat !== "responses" && llmApiFormat !== "chat_completions" && llmApiFormat !== "anthropic_messages")
  throw new Error("LLM_API_FORMAT must be responses, chat_completions or anthropic_messages");
const llmAnthropicThinking = process.env.LLM_ANTHROPIC_THINKING ?? "";
const llmAnthropicEffort = process.env.LLM_ANTHROPIC_EFFORT ?? "";
if ((llmAnthropicThinking || llmAnthropicEffort) &&
    (llmAnthropicThinking !== "adaptive" || !["low","medium","high"].includes(llmAnthropicEffort)))
  throw new Error("Anthropic thinking requires LLM_ANTHROPIC_THINKING=adaptive and LLM_ANTHROPIC_EFFORT=low, medium or high");

export const config = {
  port: Number(process.env.PORT ?? 3000),
  // 개발용 fallback은 프로세스마다 달라 예측 가능한 고정 키를 쓰지 않는다.
  sessionSecret: configuredSessionSecret || randomBytes(32).toString("base64url"),
  llmBaseUrl: process.env.LLM_BASE_URL ?? "https://api.openai.com/v1",
  llmApiFormat,
  llmAnthropicThinking,
  llmAnthropicEffort,
  llmApiKey: process.env.LLM_API_KEY ?? "",
  llmModel: process.env.LLM_MODEL ?? "",
  llmReasoningEffort: process.env.LLM_REASONING_EFFORT ?? "xhigh",
  llmApiTimeoutMs: Number(process.env.LLM_API_TIMEOUT_MS ?? 180000),
  // "code=auth_subject" 쌍, 콤마 구분. 코드는 서버 비밀 설정이다.
  testUserCodes: Object.fromEntries(
    (process.env.TEST_USER_CODES ?? "")
      .split(",")
      .filter(Boolean)
      .map((p) => p.split("=")),
  ),
  // 키가 없으면 조회만 수행하는 로컬 stub provider로 동작한다.
  llmProvider: process.env.LLM_PROVIDER ?? (process.env.LLM_API_KEY ? "live" : "stub"),
};
