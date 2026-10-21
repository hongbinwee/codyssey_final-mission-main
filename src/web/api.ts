// 서버 API 호출 래퍼. 응답은 공통 ToolResult 봉투다.
// transport/timeout 실패는 throw — 기존 호출자(CancelSheet의 lostResult 복구 등)가
// catch로 '응답 유실'을 구분하므로 이 계약을 유지한다. 봉투가 필요한 경로는 apiSafe.
export type ApiResult<T> =
  | { ok: true; data: T; operation_id?: string; replayed?: boolean }
  | { ok: false; error: { code: string; message: string }; operation_id?: string };

const API_TIMEOUT_MS = 30_000;
// provider 180초 / tool loop 240초 뒤 응답을 받을 여유를 둔다.
const AGENT_TIMEOUT_MS = 270_000;

// 응답 없는 fetch가 영구 busy를 만들지 않게 bounded timeout을 건다.
// 호출자가 넘긴 signal은 보존해 둘 중 먼저 오는 쪽으로 취소한다 [Project].
function withTimeout(signal: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs);
  if (!signal) return t;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, t]);
  const c = new AbortController();
  const relay = (s: AbortSignal) => () => c.abort(s.reason);
  if (signal.aborted) c.abort(signal.reason);
  else signal.addEventListener("abort", relay(signal), { once: true });
  t.addEventListener("abort", relay(t), { once: true });
  return c.signal;
}

// 서버는 /api/*에 항상 봉투를 돌려준다. 봉투가 아닌 유효 JSON(프록시·미들웨어 응답
// 등)은 형식 이상으로 throw한다 — transport 실패와 같은 '결과 불확정'으로 다뤄야
// CancelSheet의 catch→lostResult처럼 throw 기반 복구 경로가 유지된다.
const isEnvelope = (j: unknown): j is ApiResult<unknown> => {
  if (!j || typeof j !== "object") return false;
  const o = j as {
    ok?: unknown;
    error?: { code?: unknown; message?: unknown };
  };
  if (o.ok === true) return "data" in (j as Record<string, unknown>);
  return (
    o.ok === false &&
    !!o.error &&
    typeof o.error.code === "string" &&
    typeof o.error.message === "string"
  );
};

export async function api<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const r = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
    signal: withTimeout(init?.signal, (path === "/api/agent/turn" || /^\/api\/brain\/conversations\/[^/]+\/turn$/.test(path)) ? AGENT_TIMEOUT_MS : API_TIMEOUT_MS),
  });
  const j: unknown = await r.json();
  if (!isEnvelope(j)) throw new Error("BAD_ENVELOPE");
  return j as ApiResult<T>;
}

const MAX_TURN_RESPONSE_BYTES = 4 * 1024 * 1024;
const badTurnResponse = (): ApiResult<never> => ({
  ok: false,
  error: { code: "BAD_RESPONSE", message: "서버 응답 형식을 확인하지 못했어요." },
});

function turnConversationId<T>(result: ApiResult<T>): string | undefined {
  if (!result.ok || !result.data || typeof result.data !== "object") return;
  const id = (result.data as { conversation_id?: unknown }).conversation_id;
  return typeof id === "string" && id.trim() ? id : undefined;
}

async function readTurnResponse<T>(response: Response, onPreview?: (value: T) => void): Promise<ApiResult<T>> {
  const ndjson = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "application/x-ndjson";
  const reader = response.body?.getReader();
  if (!reader) return badTurnResponse();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let buffer = "";
  let complete: ApiResult<T> | undefined;
  let conversationId: string | undefined;
  let sawPreview = false;
  let sawComplete = false;

  const readEvent = (line: string) => {
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!normalized.trim()) throw new Error("BAD_RESPONSE");
    let event: unknown;
    try {
      event = JSON.parse(normalized);
    } catch {
      throw new Error("BAD_RESPONSE");
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("BAD_RESPONSE");
    const row = event as Record<string, unknown>;
    if (Object.keys(row).length !== 2 || !("type" in row) || !("response" in row) ||
      (row.type !== "preview" && row.type !== "complete") || !isEnvelope(row.response)) throw new Error("BAD_RESPONSE");

    if (row.type === "preview") {
      if (sawPreview || sawComplete || !row.response.ok) throw new Error("BAD_RESPONSE");
      const id = turnConversationId(row.response as ApiResult<T>);
      if (!id || (conversationId && conversationId !== id)) throw new Error("BAD_RESPONSE");
      conversationId = id;
      sawPreview = true;
      onPreview?.((row.response as { ok: true; data: T }).data);
      return;
    }

    if (sawComplete) throw new Error("BAD_RESPONSE");
    if (row.response.ok) {
      const id = turnConversationId(row.response as ApiResult<T>);
      if (!id || (conversationId && conversationId !== id)) throw new Error("BAD_RESPONSE");
      conversationId = id;
    }
    complete = row.response as ApiResult<T>;
    sawComplete = true;
  };

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > MAX_TURN_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        return badTurnResponse();
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      if (!ndjson) continue;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        readEvent(line);
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (!ndjson) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(buffer);
      } catch {
        return badTurnResponse();
      }
      return isEnvelope(parsed) ? (parsed as ApiResult<T>) : badTurnResponse();
    }
    if (buffer.length) readEvent(buffer);
    return sawComplete && complete ? complete : badTurnResponse();
  } catch {
    await reader.cancel().catch(() => {});
    return badTurnResponse();
  } finally {
    reader.releaseLock();
  }
}

/** One-fetch turn request that accepts preview events while retaining JSON fallback. */
export async function apiTurnSafe<T>(path: string, init?: RequestInit, onPreview?: (value: T) => void): Promise<ApiResult<T>> {
  try {
    const headers = new Headers({ "content-type": "application/json" });
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.set("accept", "application/x-ndjson");
    const response = await fetch(path, {
      ...init,
      headers,
      signal: withTimeout(init?.signal, AGENT_TIMEOUT_MS),
    });
    return await readTurnResponse<T>(response, onPreview);
  } catch {
    return {
      ok: false,
      error: { code: "NETWORK", message: "서버에 연결하지 못했어요. 결과를 확인해 주세요." },
    };
  }
}

// transport·timeout·JSON 파싱/봉투 형식 실패를 NETWORK 봉투로 변환한다.
// 쓰기 경로는 이 코드를 OUTCOME_UNKNOWN처럼 '결과 확인(복구)'으로 처리해야 하고,
// 읽기 경로는 재시도 UI로 처리한다.
export async function apiSafe<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    return await api<T>(path, init);
  } catch {
    return {
      ok: false,
      error: { code: "NETWORK", message: "서버에 연결하지 못했어요. 결과를 확인해 주세요." },
    };
  }
}

// 유실 응답 복구로 처리할 에러 코드 — 서버 커밋 여부가 불확정인 경우만.
// 서버 outer catch의 500 INTERNAL은 write의 commit 여부가 불확정하므로
// 확정 거절(VERSION_CONFLICT/OUT_OF_STOCK/VALIDATION)과 구분해 intent를 유지한다.
export const AMBIGUOUS_CODES = new Set([
  "OUTCOME_UNKNOWN",
  "NETWORK",
  "BAD_RESPONSE",
  "INTERNAL",
]);

export const fmtWon = (n: number) => n.toLocaleString("ko-KR") + "원";

// 배송비 표시 — 정확히 0이면 '무료배송', 양의 안전 정수면 실제 금액,
// undefined/NaN/음수/비정수 등 부재·비정상 값은 '배송비 정보 없음'으로
// 구분한다 [PMQA-068 — >0 비교만으로는 NaN·음수·부재를 무료로 오표기].
export const shipFeeLabel = (fee: number | null | undefined): string => {
  if (fee === 0) return "무료배송";
  if (typeof fee === "number" && Number.isSafeInteger(fee) && fee > 0)
    return "배송비 " + fmtWon(fee);
  return "배송비 정보 없음";
};

// 어느 Brain과 대화할지. 서버는 user:brain 단위로 Tool 목록과 히스토리를 나눈다.
export type AgentBrain = "shopping" | "cs";

// 카트 변경은 같은 사용자 행동에 같은 키를 쓴다. 재시도 시 이 키를 재사용한다.
export const newActionKey = () => crypto.randomUUID();
