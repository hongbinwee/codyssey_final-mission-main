// LLM Provider Adapter. Supports Responses, Chat Completions and Anthropic Messages.
// 모델/SDK를 이 한 파일에 격리한다. live 키가 없으면 read-only stub을 쓴다.
import { config } from "./config.ts";

export type ToolCallReq = { id: string; name: string; arguments: string };
// Keep opaque reasoning/encrypted content and every output field intact.
export type ResponsesOutputItem = { type: string; [key: string]: unknown };
export type ChatMsg = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCallReq[];
  tool_call_id?: string;
  name?: string;
  responses_output?: ResponsesOutputItem[];
  anthropic_content?: unknown[];
};
export type ChatResponse = {
  content: string | null;
  tool_calls?: ToolCallReq[];
  responses_output?: ResponsesOutputItem[];
  anthropic_content?: unknown[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};
export interface Provider {
  name: string;
  chat(messages: ChatMsg[], tools: unknown[], options?: { signal?: AbortSignal }): Promise<ChatResponse>;
}

function responsesInput(messages: ChatMsg[]): unknown[] {
  const input: unknown[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.tool_call_id, output: message.content ?? "" });
    } else if (message.role === "assistant" && message.responses_output?.length) {
      // These items already contain assistant text and function calls. Rebuilding
      // either would duplicate them and discard the reasoning needed by the model.
      input.push(...message.responses_output);
    } else {
      if (message.content != null)
        input.push({ role: message.role, content: message.content });
      for (const call of message.tool_calls ?? []) {
        input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments });
      }
    }
  }
  return input;
}

function responsesTools(tools: unknown[]): unknown[] {
  return tools.map((tool) => {
    const definition = tool as { type?: string; function?: Record<string, unknown> };
    if (definition.type !== "function") return tool;
    return { ...(definition.function ?? definition), type: "function", strict: false };
  });
}

function parseResponse(value: unknown): ChatResponse {
  if (!value || typeof value !== "object") throw new Error("LLM invalid response");
  const response = value as {
    status?: string;
    output?: ResponsesOutputItem[];
    usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  };
  if (response.status === "failed" || response.status === "incomplete" || response.status === "cancelled")
    throw new Error("LLM response failed");
  if (!Array.isArray(response.output)) throw new Error("LLM invalid response");
  const text: string[] = [];
  const calls: ToolCallReq[] = [];
  for (const item of response.output) {
    if (!item || typeof item !== "object" || typeof item.type !== "string")
      throw new Error("LLM invalid response");
    if (item.type === "function_call") {
      if (typeof item.call_id !== "string" || typeof item.name !== "string" || typeof item.arguments !== "string")
        throw new Error("LLM invalid response");
      calls.push({ id: item.call_id, name: item.name, arguments: item.arguments });
    }
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === "output_text" && typeof part.text === "string") text.push(part.text);
        if (part?.type === "refusal" && typeof part.refusal === "string") text.push(part.refusal);
      }
    }
  }
  return {
    content: text.length ? text.join("") : null,
    ...(calls.length ? { tool_calls: calls } : {}),
    responses_output: response.output,
    ...(response.usage ? { usage: {
      prompt_tokens: response.usage.input_tokens,
      completion_tokens: response.usage.output_tokens,
      total_tokens: response.usage.total_tokens,
    } } : {}),
  };
}

function chatCompletionsMessages(messages: ChatMsg[]): unknown[] {
  return messages.map((message) => {
    if (message.role === "tool")
      return { role: "tool", tool_call_id: message.tool_call_id, name: message.name, content: message.content ?? "" };
    return {
      role: message.role,
      ...(message.content !== undefined ? { content: message.content } : {}),
      ...(message.tool_calls?.length ? { tool_calls: message.tool_calls.map((call) => ({
        id: call.id, type: "function", function: { name: call.name, arguments: call.arguments },
      })) } : {}),
    };
  });
}

function parseChatCompletion(value: unknown): ChatResponse {
  if (!value || typeof value !== "object") throw new Error("LLM invalid response");
  const response = value as {
    choices?: { finish_reason?: string | null; message?: { role?: string; content?: unknown; tool_calls?: unknown } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const choice = response.choices?.[0];
  const message = choice?.message;
  if (!message || message.role !== "assistant" ||
      (message.content !== null && message.content !== undefined && typeof message.content !== "string") ||
      (message.tool_calls !== undefined && message.tool_calls !== null && !Array.isArray(message.tool_calls)))
    throw new Error("LLM invalid response");
  if (choice?.finish_reason === "length" || choice?.finish_reason === "content_filter")
    throw new Error("LLM response failed");
  const calls: ToolCallReq[] = [];
  for (const item of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const call = item as { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } };
    if (call?.type !== "function" || typeof call.id !== "string" || !call.id ||
        typeof call.function?.name !== "string" || !call.function.name ||
        typeof call.function.arguments !== "string")
      throw new Error("LLM invalid response");
    calls.push({ id: call.id, name: call.function.name, arguments: call.function.arguments });
  }
  return {
    content: typeof message.content === "string" ? message.content : null,
    ...(calls.length ? { tool_calls: calls } : {}),
    ...(response.usage ? { usage: response.usage } : {}),
  };
}

function anthropicMessages(messages: ChatMsg[]): { system?: string; messages: unknown[] } {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content ?? "").filter(Boolean).join("\n\n");
  const output: { role: "user" | "assistant"; content: string | unknown[] }[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const result = { type: "tool_result", tool_use_id: message.tool_call_id, content: message.content ?? "" };
      const previous = output.at(-1);
      if (previous?.role === "user" && Array.isArray(previous.content) &&
          previous.content.every((block) => (block as { type?: string })?.type === "tool_result")) {
        previous.content.push(result);
      } else {
        output.push({ role: "user", content: [result] });
      }
      continue;
    }
    if (message.role === "assistant" && message.anthropic_content?.length) {
      output.push({ role: "assistant", content: message.anthropic_content });
      continue;
    }
    if (message.role === "assistant") {
      const content: unknown[] = [];
      if (typeof message.content === "string" && message.content) content.push({ type: "text", text: message.content });
      for (const call of message.tool_calls ?? []) {
        let input: unknown;
        try {
          input = JSON.parse(call.arguments);
        } catch {
          throw new Error("LLM invalid tool arguments");
        }
        if (!input || typeof input !== "object" || Array.isArray(input))
          throw new Error("LLM invalid tool arguments");
        content.push({ type: "tool_use", id: call.id, name: call.name, input });
      }
      if (content.length) output.push({ role: "assistant", content });
      continue;
    }
    output.push({ role: "user", content: message.content ?? "" });
  }
  return { ...(system ? { system } : {}), messages: output };
}

function anthropicTools(tools: unknown[]): unknown[] {
  return tools.map((raw) => {
    const tool = raw as { type?: string; function?: { name?: string; description?: string; parameters?: unknown } };
    if (tool.type !== "function" || !tool.function) return raw;
    return {
      name: tool.function.name,
      ...(tool.function.description ? { description: tool.function.description } : {}),
      input_schema: tool.function.parameters,
    };
  });
}

function parseAnthropicMessage(value: unknown): ChatResponse {
  if (!value || typeof value !== "object") throw new Error("LLM invalid response");
  const response = value as {
    type?: string;
    role?: string;
    content?: unknown;
    stop_reason?: string | null;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  if (response.type !== "message" || response.role !== "assistant" || !Array.isArray(response.content))
    throw new Error("LLM invalid response");
  if (response.stop_reason === "max_tokens" || response.stop_reason === "pause_turn")
    throw new Error("LLM response failed");
  const text: string[] = [];
  const calls: ToolCallReq[] = [];
  for (const raw of response.content) {
    if (!raw || typeof raw !== "object") throw new Error("LLM invalid response");
    const block = raw as { type?: string; text?: unknown; id?: unknown; name?: unknown; input?: unknown };
    if (block.type === "text") {
      if (typeof block.text !== "string") throw new Error("LLM invalid response");
      text.push(block.text);
    } else if (block.type === "tool_use") {
      if (typeof block.id !== "string" || !block.id || typeof block.name !== "string" || !block.name ||
          !block.input || typeof block.input !== "object" || Array.isArray(block.input))
        throw new Error("LLM invalid response");
      calls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
    }
  }
  if (!text.length && !calls.length) throw new Error("LLM invalid response");
  const input = response.usage?.input_tokens;
  const output = response.usage?.output_tokens;
  return {
    content: text.length ? text.join("") : null,
    ...(calls.length ? { tool_calls: calls } : {}),
    anthropic_content: response.content,
    ...(response.usage ? { usage: {
      prompt_tokens: input,
      completion_tokens: output,
      ...(typeof input === "number" && typeof output === "number" ? { total_tokens: input + output } : {}),
    } } : {}),
  };
}

export interface LiveProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  apiFormat?: "responses"|"chat_completions"|"anthropic_messages";
  anthropicThinking?: "adaptive"|"";
  anthropicEffort?: "low"|"medium"|"high"|"";
}
export function liveProvider(modelOverride?:string, overrides:LiveProviderOptions={}): Provider {
  const model=modelOverride?.trim()||config.llmModel;
  const apiKey=overrides.apiKey??config.llmApiKey;
  const apiBaseUrl=overrides.baseUrl??config.llmBaseUrl;
  const apiFormat=overrides.apiFormat??config.llmApiFormat;
  const anthropicThinking=overrides.anthropicThinking??config.llmAnthropicThinking;
  const anthropicEffort=overrides.anthropicEffort??config.llmAnthropicEffort;
  if((anthropicThinking||anthropicEffort)&&
      (apiFormat!=="anthropic_messages"||anthropicThinking!=="adaptive"||
       !["low","medium","high"].includes(anthropicEffort)))
    throw Error("Anthropic adaptive thinking requires low, medium or high effort on anthropic_messages");
  if(!apiKey.trim()||!model.trim())throw Error("live model and API key required");
  return {
    name: "live:" + model,
    async chat(messages, tools, options) {
      const controller = new AbortController();
      const signal = options?.signal
        ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
      const timeoutMs = Number.isFinite(config.llmApiTimeoutMs) && config.llmApiTimeoutMs > 0
        ? config.llmApiTimeoutMs : 180000;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const chatCompletions = apiFormat === "chat_completions";
        const anthropic = apiFormat === "anthropic_messages";
        let res: Response;
        try {
          const baseUrl = apiBaseUrl.replace(/\/+$/, "");
          const nativeMessages = anthropic ? anthropicMessages(messages) : undefined;
          const body = anthropic
            ? {
                model: model,
                max_tokens: 8192,
                ...(nativeMessages?.system ? { system: nativeMessages.system } : {}),
                messages: nativeMessages!.messages,
                ...(tools.length ? { tools: anthropicTools(tools) } : {}),
                ...(anthropicThinking === "adaptive" ? {
                  thinking: { type: "adaptive" },
                  output_config: { effort: anthropicEffort },
                } : {}),
              }
            : chatCompletions
            ? {
                model: model,
                messages: chatCompletionsMessages(messages),
                ...(tools.length ? { tools, tool_choice: "auto" as const } : {}),
                max_tokens: 8192,
              }
            : {
                model: model,
                reasoning: { effort: config.llmReasoningEffort },
                max_output_tokens: 8192,
                store: false,
                include: ["reasoning.encrypted_content"],
                instructions: messages.filter((m) => m.role === "system")
                  .map((m) => m.content ?? "").join("\n\n"),
                input: responsesInput(messages),
                tools: responsesTools(tools),
                tool_choice: "auto",
              };
          res = await fetch(baseUrl + (anthropic ? "/messages" : chatCompletions ? "/chat/completions" : "/responses"), {
            method: "POST",
            headers: anthropic ? {
              "content-type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
            } : {
              "content-type": "application/json",
              authorization: "Bearer " + apiKey,
            },
            signal,
            body: JSON.stringify(body),
          });
        } catch {
          throw new Error(signal.aborted ? "LLM timeout" : "LLM request failed");
        }
        // Never read or echo error bodies: they may contain credentials or PII.
        if (!res.ok) throw new Error("LLM http " + res.status);
        let value: unknown;
        try {
          value = await res.json();
        } catch {
          throw new Error(signal.aborted ? "LLM timeout" : "LLM invalid response");
        }
        return anthropic ? parseAnthropicMessage(value)
          : chatCompletions ? parseChatCompletion(value) : parseResponse(value);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// 평가·테스트용: 케이스 파일이 정한 응답을 순서대로 재생한다.
export function scriptedProvider(steps: ChatResponse[]): Provider {
  let i = 0;
  return {
    name: "scripted",
    async chat() {
      const s = steps[i++];
      if (!s) return { content: "(scripted provider: 응답 소진)" };
      return s;
    },
  };
}

// 로컬 데모용 stub: LLM 없이도 A01을 열 수 있게 조회 Tool만 호출하고,
// 쓰기 Tool은 절대 호출하지 않는다. 실제 모델 실행으로 보고하지 않는다.
export function stubProvider(): Provider {
  return {
    name: "stub-readonly",
    async chat(messages, tools) {
      const names = new Set(
        (tools as { function?: { name?: string } }[]).map((t) => t.function?.name),
      );
      const toolMsgs = messages.filter((m) => m.role === "tool");
      // CS Brain 스텁: 주문 목록 → 첫 주문 배송 조회 → 실제 조회값 요약.
      if (names.has("list_orders")) {
        if (toolMsgs.length === 0)
          return {
            content: null,
            tool_calls: [{ id: "call_1", name: "list_orders", arguments: "{}" }],
          };
        if (toolMsgs.length === 1) {
          try {
            const d = JSON.parse(String(toolMsgs[0].content));
            const oid = d?.orders?.[0]?.id;
            if (!oid)
              return { content: "주문 내역이 없어요. 주문이 생기면 다시 확인해 주세요." };
            return {
              content: null,
              tool_calls: [
                { id: "call_2", name: "get_shipping_status", arguments: JSON.stringify({ order_id: oid }) },
              ],
            };
          } catch {
            // fallthrough
          }
        }
        try {
          const ship = JSON.parse(String(toolMsgs[1]?.content ?? "{}"));
          const list = JSON.parse(String(toolMsgs[0].content));
          const oid = list?.orders?.[0]?.id;
          if (ship?.information === "NO_INFORMATION")
            return { content: oid + " 주문의 배송 정보가 아직 등록되지 않았어요. 잠시 후 다시 확인해 주세요." };
          const label = { PREPARING: "배송 준비 중", IN_TRANSIT: "배송 중", DELIVERED: "배송 완료", CANCELLED: "배송 취소" }[ship?.status as string] ?? "알 수 없음";
          return { content: oid + " 주문은 현재 " + label + " 상태예요. (로컬 stub — LLM 미설정)" };
        } catch {
          return { content: "주문/배송 정보를 확인하지 못했어요." };
        }
      }
      if (toolMsgs.length === 0) {
        const userMsg = [...messages].reverse().find((m) => m.role === "user");
        const raw = typeof userMsg?.content === "string" ? userMsg.content : "";
        // stub은 의도 추출을 흉내낸다: 요청 어미(~해줘/~주세요/추천/비교 등)를 떼고
        // 남은 토큰의 마지막을 상품 키워드로 쓴다. 없으면 원문 그대로.
        const tokens = raw
          .split(/\s+/)
          .map((t) => t.replace(/[?!.,~]/g, ""))
          .filter(
            (t) =>
              t &&
              !/(해주세요|해줘|주세요|줘|줄래|해주|해|추천|비교|알려|보여|찾아|골라|검색|싶어|할게)$/u.test(
                t,
              ),
          );
        const query = (tokens[tokens.length - 1] ?? raw).slice(0, 50);
        return {
          content: null,
          tool_calls: [
            { id: "call_1", name: "search_products", arguments: JSON.stringify({ query }) },
          ],
        };
      }
      // 이미 상품 검색 결과가 있으면 첫 상품의 리뷰를 한 번 조회한다.
      if (toolMsgs.length === 1 && toolMsgs[0].name === "search_products") {
        try {
          const data = JSON.parse(String(toolMsgs[0].content));
          const pid = data?.data?.items?.[0]?.product_id;
          if (pid)
            return {
              content: null,
              tool_calls: [
                { id: "call_2", name: "get_reviews", arguments: JSON.stringify({ product_id: pid }) },
              ],
            };
        } catch {
          // fallthrough
        }
      }
      const first = JSON.parse(String(toolMsgs[0]?.content ?? "{}"));
      const items = first?.data?.items ?? [];
      if (items.length === 0)
        return {
          content: "조건에 맞는 상품을 찾지 못했어요. 검색 조건을 바꿔서 다시 알려주세요.",
        };
      const lines = items
        .slice(0, 3)
        .map(
          (it: { product_id: string; name: string; matched_variants: { variant_id: string; unit_price_won: number; availability: string }[] }) =>
            "- " + it.name + " (" + it.product_id + "): " +
            it.matched_variants
              .map((v) => v.variant_id + " " + v.unit_price_won.toLocaleString() + "원 " + v.availability)
              .join(" / "),
        );
      return {
        content:
          "(로컬 stub — LLM 미설정)\n조건에 맞는 후보를 찾았어요:\n" +
          lines.join("\n") +
          "\n\n옵션과 수량을 지정해 주시면 장바구니에 담아드릴게요.",
      };
    },
  };
}

export function getProvider(): Provider {
  return config.llmProvider === "live" && config.llmApiKey && config.llmModel.trim()
    ? liveProvider()
    : stubProvider();
}
