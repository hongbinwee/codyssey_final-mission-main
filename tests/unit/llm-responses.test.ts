import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, mock, test } from "node:test";
import type { ChatMsg } from "../../src/llm.ts";

// Import the real adapter/config without reading .env or credential files.
const readFileSync = fs.readFileSync;
const envGuard = mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
  if (String(args[0]) === ".env") throw new Error("test: .env disabled");
  return Reflect.apply(readFileSync, fs, args);
});
syncBuiltinESMExports();
delete process.env.DATABASE_PASSWORD_FILE;
Object.assign(process.env, {
  NODE_ENV: "test", SESSION_SECRET: "test-session-only", TEST_USER_CODES: "",
  LLM_API_KEY: "fake-test-key", LLM_MODEL: "gpt-6-luna",
  LLM_BASE_URL: "https://example.invalid/v1", LLM_PROVIDER: "live",
  LLM_API_FORMAT: "responses", LLM_ANTHROPIC_THINKING: "", LLM_ANTHROPIC_EFFORT: "",
});
delete process.env.LLM_REASONING_EFFORT;
delete process.env.LLM_API_TIMEOUT_MS;
const { config } = await import("../../src/config.ts");
const { getProvider, liveProvider, scriptedProvider, stubProvider } = await import("../../src/llm.ts");
envGuard.mock.restore();
syncBuiltinESMExports();
const defaults = { ...config };
afterEach(() => { mock.restoreAll(); Object.assign(config, defaults); });

type Body = Record<string, any>;
function capture(responses: Response[]) {
  const requests: { url: string; options: RequestInit; body: Body }[] = [];
  mock.method(globalThis, "fetch", async (url: string | URL | Request, options: RequestInit) => {
    requests.push({ url: String(url), options, body: JSON.parse(String(options.body)) });
    const response = responses.shift();
    assert.ok(response, "unexpected retry or extra request");
    return response;
  });
  return requests;
}
const reply = (output: unknown[], extra = {}) => Response.json({
  id: "resp_test", object: "response", status: "completed", output, ...extra,
});
const textOutput = [{ type: "message", id: "msg_test", role: "assistant", status: "completed",
  content: [{ type: "output_text", text: "Hello", annotations: [] }] }];

test("Responses request uses configured model, flat optional tools, stateless reasoning and full history", async () => {
  const requests = capture([reply(textOutput, {
    usage: { input_tokens: 10, output_tokens: 6, total_tokens: 16 },
  })]);
  const result = await liveProvider().chat([
    { role: "system", content: "Policy one" },
    { role: "user", content: "Earlier" },
    { role: "assistant", content: "Previous answer" },
    { role: "system", content: "Policy two" },
    { role: "user", content: "Latest" },
  ], [{ type: "function", function: {
    name: "lookup", description: "Find orders", strict: true,
    parameters: { type: "object", properties: { query: { type: "string" } } },
  } }]);
  assert.equal(requests[0].url, "https://example.invalid/v1/responses");
  assert.equal(requests[0].options.method, "POST");
  assert.equal((requests[0].options.headers as Record<string, string>).authorization, "Bearer fake-test-key");
  assert.deepEqual(requests[0].body, {
    model: "gpt-6-luna", reasoning: { effort: "xhigh" }, max_output_tokens: 8192, store: false,
    include: ["reasoning.encrypted_content"], instructions: "Policy one\n\nPolicy two",
    input: [{ role: "user", content: "Earlier" }, { role: "assistant", content: "Previous answer" },
      { role: "user", content: "Latest" }],
    tools: [{ type: "function", name: "lookup", description: "Find orders", strict: false,
      parameters: { type: "object", properties: { query: { type: "string" } } } }],
    tool_choice: "auto",
  });
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  assert.equal(result.content, "Hello");
  assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 });
  assert.deepEqual(result.responses_output, textOutput);
});

test("Chat Completions converts internal messages and tools without Responses-only fields", async () => {
  Object.assign(config, { llmApiFormat: "chat_completions", llmModel: "verified-model-fixture" });
  const requests = capture([Response.json({
    id: "chatcmpl_test", object: "chat.completion", choices: [{ index: 0, finish_reason: "tool_calls",
      message: { role: "assistant", content: null, tool_calls: [{ id: "call_order", type: "function",
        function: { name: "lookup", arguments: "{\"order_id\":\"o-1\"}" } }] } }],
    usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
  })]);
  const result = await liveProvider().chat([
    { role: "system", content: "Policy" }, { role: "user", content: "Find order" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_previous", name: "lookup", arguments: "{}" }] },
    { role: "tool", tool_call_id: "call_previous", name: "lookup", content: "Found" },
  ], [{ type: "function", function: { name: "lookup", description: "Find order",
    parameters: { type: "object", properties: { order_id: { type: "string" } } } } }]);
  assert.equal(requests[0].url, "https://example.invalid/v1/chat/completions");
  assert.equal((requests[0].options.headers as Record<string, string>).authorization, "Bearer fake-test-key");
  assert.deepEqual(requests[0].body, {
    model: "verified-model-fixture", messages: [
      { role: "system", content: "Policy" }, { role: "user", content: "Find order" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_previous", type: "function",
        function: { name: "lookup", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_previous", name: "lookup", content: "Found" },
    ],
    tools: [{ type: "function", function: { name: "lookup", description: "Find order",
      parameters: { type: "object", properties: { order_id: { type: "string" } } } } }],
    tool_choice: "auto", max_tokens: 8192,
  });
  for (const key of ["reasoning", "reasoning_effort", "store", "include", "input", "instructions"])
    assert.equal(key in requests[0].body, false, `must omit Responses-only field ${key}`);
  assert.equal(result.content, null);
  assert.deepEqual(result.tool_calls, [{ id: "call_order", name: "lookup", arguments: "{\"order_id\":\"o-1\"}" }]);
  assert.deepEqual(result.usage, { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 });
  assert.equal(result.responses_output, undefined);
});

test("Chat Completions preserves assistant text and sanitizes upstream error details", async () => {
  Object.assign(config, { llmApiFormat: "chat_completions" });
  const requests = capture([Response.json({ choices: [{ message: { role: "assistant", content: "Hello" } }] })]);
  const result = await liveProvider().chat([{ role: "user", content: "Hi" }], []);
  assert.equal(result.content, "Hello");
  assert.equal("choices" in (result as unknown as Body), false);
  assert.equal(requests.length, 1);

  const privateResponse = new Response("private key detail", { status: 401 });
  capture([privateResponse]);
  await assert.rejects(liveProvider().chat([], []), { message: "LLM http 401" });
  assert.equal(privateResponse.bodyUsed, false);
});

test("Chat Completions honors caller abort and provider timeout without retry", async () => {
  Object.assign(config, { llmApiFormat: "chat_completions", llmApiTimeoutMs: 50 });
  let calls = 0;
  mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    calls++;
    return await new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new Error("private abort detail")), { once: true });
      if (options.signal!.aborted) reject(new Error("already aborted"));
    });
  });
  const controller = new AbortController();
  const pending = assert.rejects(liveProvider().chat([], [], { signal: controller.signal }), { message: "LLM timeout" });
  controller.abort();
  await pending;
  assert.equal(calls, 1);
});

test("Anthropic Messages converts tools, preserves native assistant blocks, and round trips tool results", async () => {
  Object.assign(config, { llmApiFormat: "anthropic_messages", llmModel: "claude-sonnet-4" });
  const nativeContent = [
    { type: "thinking", thinking: "opaque-test-thinking", signature: "opaque-test-signature" },
    { type: "text", text: "상품을 찾아볼게요." },
    { type: "tool_use", id: "toolu_search", name: "search_products", input: { query: "monitor" } },
  ];
  const requests = capture([
    Response.json({ id: "msg_test", type: "message", role: "assistant", model: "claude-sonnet-4-6",
      content: nativeContent, stop_reason: "tool_use", usage: { input_tokens: 12, output_tokens: 5 } }),
    Response.json({ id: "msg_result", type: "message", role: "assistant", model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "검색 결과를 확인했어요." }], stop_reason: "end_turn",
      usage: { input_tokens: 20, output_tokens: 8 } }),
  ]);
  const provider = liveProvider();
  const tools = [{ type: "function", function: { name: "search_products", description: "Search demo products",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } }];
  const first = await provider.chat([
    { role: "system", content: "Commerce policy" },
    { role: "user", content: "Find a monitor" },
  ], tools);

  assert.equal(requests[0].url, "https://example.invalid/v1/messages");
  const headers = requests[0].options.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "fake-test-key");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers.authorization, undefined);
  assert.deepEqual(requests[0].body, {
    model: "claude-sonnet-4", max_tokens: 8192, system: "Commerce policy",
    messages: [{ role: "user", content: "Find a monitor" }],
    tools: [{ name: "search_products", description: "Search demo products",
      input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }],
  });
  assert.equal("thinking" in requests[0].body, false);
  assert.equal(first.content, "상품을 찾아볼게요.");
  assert.deepEqual(first.tool_calls, [{ id: "toolu_search", name: "search_products", arguments: "{\"query\":\"monitor\"}" }]);
  assert.deepEqual(first.anthropic_content, nativeContent);
  assert.deepEqual(first.usage, { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 });

  const final = await provider.chat([
    { role: "system", content: "Commerce policy" },
    { role: "user", content: "Find a monitor" },
    { role: "assistant", content: first.content, tool_calls: first.tool_calls, anthropic_content: first.anthropic_content },
    { role: "tool", tool_call_id: "toolu_search", name: "search_products", content: "{\"products\":[{\"id\":\"p-a\"}]}" },
  ], tools);
  assert.deepEqual(requests[1].body.messages, [
    { role: "user", content: "Find a monitor" },
    { role: "assistant", content: nativeContent },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_search", content: "{\"products\":[{\"id\":\"p-a\"}]}" }] },
  ]);
  assert.equal(final.content, "검색 결과를 확인했어요.");
  assert.deepEqual(final.usage, { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 });
});

test("Anthropic Messages converts legacy assistant tool calls and groups adjacent tool results", async () => {
  Object.assign(config, { llmApiFormat: "anthropic_messages", llmModel: "claude-sonnet-4" });
  const requests = capture([Response.json({ id: "msg_test", type: "message", role: "assistant", model: "claude-sonnet-4-6",
    content: [{ type: "text", text: "Done" }], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 1 } })]);
  await liveProvider().chat([
    { role: "system", content: "Policy one" }, { role: "system", content: "Policy two" },
    { role: "user", content: "Look up two things" },
    { role: "assistant", content: "Searching", tool_calls: [
      { id: "toolu_one", name: "lookup_one", arguments: "{\"id\":1}" },
      { id: "toolu_two", name: "lookup_two", arguments: "{\"id\":2}" },
    ] },
    { role: "tool", tool_call_id: "toolu_one", content: "one" },
    { role: "tool", tool_call_id: "toolu_two", content: "two" },
  ], []);
  assert.equal(requests[0].body.system, "Policy one\n\nPolicy two");
  assert.deepEqual(requests[0].body.messages, [
    { role: "user", content: "Look up two things" },
    { role: "assistant", content: [
      { type: "text", text: "Searching" },
      { type: "tool_use", id: "toolu_one", name: "lookup_one", input: { id: 1 } },
      { type: "tool_use", id: "toolu_two", name: "lookup_two", input: { id: 2 } },
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_one", content: "one" },
      { type: "tool_result", tool_use_id: "toolu_two", content: "two" },
    ] },
  ]);
});

test("Anthropic adaptive thinking keeps configured high by default and accepts per-call low effort", async () => {
  Object.assign(config, {
    llmApiFormat: "anthropic_messages", llmModel: "claude-sonnet-4",
    llmAnthropicThinking: "adaptive", llmAnthropicEffort: "high",
  });
  const answer=()=>Response.json({ id: "msg_test", type: "message", role: "assistant", model: "claude-sonnet-4-6",
    content: [{ type: "text", text: "Ready" }], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 1 } });
  const requests = capture([answer(),answer()]);
  await liveProvider().chat([{ role: "user", content: "Run a brief catalog lookup." }], []);
  await liveProvider().chat([{ role: "user", content: "Run a brief catalog lookup." }], [], {reasoningEffort:"low"});
  assert.deepEqual(requests[0].body.thinking, { type: "adaptive" });
  assert.deepEqual(requests[0].body.output_config, { effort: "high" });
  assert.deepEqual(requests[1].body.thinking, { type: "adaptive" });
  assert.deepEqual(requests[1].body.output_config, { effort: "low" });
  assert.equal(requests[0].body.model, "claude-sonnet-4");
  assert.equal("reasoning" in requests[0].body, false);
  assert.equal("reasoning_effort" in requests[0].body, false);
});

test("Anthropic Messages sanitizes failures, rejects truncated output, and honors caller abort without retry", async () => {
  Object.assign(config, { llmApiFormat: "anthropic_messages", llmModel: "claude-sonnet-4", llmApiTimeoutMs: 50 });
  const forbidden = new Response("private institutional key detail", { status: 403 });
  const requests = capture([forbidden, Response.json({ id: "msg_cut", type: "message", role: "assistant", model: "claude-sonnet-4-6",
    content: [{ type: "text", text: "partial" }], stop_reason: "max_tokens", usage: { input_tokens: 1, output_tokens: 1 } })]);
  await assert.rejects(liveProvider().chat([], []), { message: "LLM http 403" });
  assert.equal(forbidden.bodyUsed, false);
  await assert.rejects(liveProvider().chat([], []), { message: "LLM response failed" });
  assert.equal(requests.length, 2);

  let calls = 0;
  mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    calls++;
    return await new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new Error("private abort detail")), { once: true });
      if (options.signal!.aborted) reject(new Error("already aborted"));
    });
  });
  const controller = new AbortController();
  const pending = assert.rejects(liveProvider().chat([], [], { signal: controller.signal }), { message: "LLM timeout" });
  controller.abort();
  await pending;
  assert.equal(calls, 1);
});

test("raw reasoning and function calls round trip once, using call_id rather than output item id", async () => {
  const raw = [
    { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "encrypted-test-reasoning" },
    { type: "function_call", id: "fc_item_1", call_id: "call_order_1", name: "lookup", arguments: "{}", status: "completed" },
  ];
  const requests = capture([reply(raw), reply(textOutput)]);
  const provider = liveProvider();
  const history: ChatMsg[] = [{ role: "user", content: "Find my order" }];
  const first = await provider.chat(history, []);
  assert.equal(first.content, null);
  assert.deepEqual(first.tool_calls, [{ id: "call_order_1", name: "lookup", arguments: "{}" }]);
  assert.deepEqual(first.responses_output, raw);
  history.push({ role: "assistant", content: first.content, tool_calls: first.tool_calls,
    responses_output: first.responses_output });
  history.push({ role: "tool", tool_call_id: first.tool_calls![0].id, content: '{"order":42}' });
  await provider.chat(history, []);
  assert.deepEqual(requests[1].body.input, [
    { role: "user", content: "Find my order" }, ...raw,
    { type: "function_call_output", call_id: "call_order_1", output: '{"order":42}' },
  ]);
  assert.equal("previous_response_id" in requests[1].body, false);
});

test("legacy assistant tool calls convert to function_call and tool output", async () => {
  const requests = capture([reply(textOutput)]);
  await liveProvider().chat([
    { role: "assistant", content: "Looking up", tool_calls: [{ id: "call_legacy", name: "lookup", arguments: "{}" }] },
    { role: "tool", tool_call_id: "call_legacy", content: "found" },
  ], []);
  assert.deepEqual(requests[0].body.input, [
    { role: "assistant", content: "Looking up" },
    { type: "function_call", call_id: "call_legacy", name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "call_legacy", output: "found" },
  ]);
});

test("provider requests remain isolated across concurrent users", async () => {
  const requests = capture([reply(textOutput), reply(textOutput)]);
  const provider = liveProvider();
  await Promise.all([
    provider.chat([{ role: "user", content: "User A" }], []),
    provider.chat([{ role: "user", content: "User B" }], []),
  ]);
  assert.deepEqual(requests.map((r) => r.body.input), [
    [{ role: "user", content: "User A" }], [{ role: "user", content: "User B" }],
  ]);
  assert.ok(requests.every((r) => !("previous_response_id" in r.body)));
});

test("configured base URL retains custom path and removes trailing slashes", async () => {
  config.llmBaseUrl = "https://proxy.invalid/custom/v1///";
  const requests = capture([reply(textOutput)]);
  await liveProvider().chat([], []);
  assert.equal(requests[0].url, "https://proxy.invalid/custom/v1/responses");
});

test("non-200 errors expose only HTTP status and never consume the secret response body or retry", async () => {
  const response = new Response("fake-test-key private-customer-content", { status: 429 });
  const requests = capture([response]);
  await assert.rejects(liveProvider().chat([], []), { message: "LLM http 429" });
  assert.equal(response.bodyUsed, false);
  assert.equal(requests.length, 1);
});

test("transport and invalid JSON errors do not leak upstream messages", async () => {
  mock.method(globalThis, "fetch", async () => { throw new Error("fake-test-key private-network-detail"); });
  await assert.rejects(liveProvider().chat([], []), { message: "LLM request failed" });
  mock.restoreAll();
  capture([new Response("private-bad-json", { status: 200 })]);
  await assert.rejects(liveProvider().chat([], []), { message: "LLM invalid response" });
});

test("timeout aborts the request without retries or fallback", async () => {
  Object.assign(config, { llmApiTimeoutMs: 10 });
  let calls = 0;
  mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    calls++;
    return await new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new Error("private-timeout-detail")), { once: true });
    });
  });
  await assert.rejects(liveProvider().chat([], []), { message: "LLM timeout" });
  assert.equal(calls, 1);
});

test("external deadline abort settles the pending fetch before the provider timeout", async () => {
  Object.assign(config, { llmApiTimeoutMs: 50 });
  const deadline = new AbortController();
  let fetchSignal: AbortSignal | undefined;
  let calls = 0;
  mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    calls++;
    fetchSignal = options.signal!;
    return await new Promise<Response>((_resolve, reject) => {
      fetchSignal!.addEventListener("abort", () => reject(new Error("private-abort-detail")), { once: true });
    });
  });
  const settled = assert.rejects(liveProvider().chat([], [], { signal: deadline.signal }), { message: "LLM timeout" });
  deadline.abort();
  const abortedByDeadline = fetchSignal?.aborted;
  await settled;
  assert.equal(abortedByDeadline, true);
  assert.equal(calls, 1);
});

test("malformed or failed response cannot become an empty successful answer", async () => {
  capture([Response.json({ error: { message: "secret" } }), reply([], { status: "failed", error: { message: "secret" } })]);
  await assert.rejects(liveProvider().chat([], []), { message: "LLM invalid response" });
  await assert.rejects(liveProvider().chat([], []), { message: "LLM response failed" });
});

test("live selection stays on the stub until both an API key and an exact model ID are configured", () => {
  Object.assign(config, { llmProvider: "live", llmApiKey: "fake-test-key", llmModel: "" });
  assert.equal(getProvider().name, "stub-readonly");
  config.llmModel = "verified-model-fixture";
  assert.equal(getProvider().name, "live:verified-model-fixture");
});

test("scripted and read-only stub providers keep the chat contract without fetch", async () => {
  mock.method(globalThis, "fetch", async () => { assert.fail("stub/scripted must not fetch"); });
  assert.deepEqual(await scriptedProvider([{ content: "scripted" }]).chat([], []), { content: "scripted" });
  const stub = await stubProvider().chat([{ role: "user", content: "apple" }], []);
  assert.equal(stub.tool_calls?.[0].name, "search_products");
});

test("diagnostics persist response receipt and parsing without prompts, replies or secrets", async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "llm-diagnostics-"));
  const file = join(dir, "events.jsonl");
  config.llmDiagnosticsFile = file;
  try {
    capture([reply([{ type: "message", content: [{ type: "output_text", text: "private-reply" }] }])]);
    await liveProvider().chat([{ role: "user", content: "private-question" }], [],
      { requestId: "test-request", operation: "recommendation" });
    const log = fs.readFileSync(file, "utf8");
    const events = log.trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(events.map(e => e.event), ["request_started", "response_headers", "response_body", "response_parsed"]);
    assert.ok(events.every(e => e.requestId === "test-request" && e.operation === "recommendation" && e.elapsedMs >= 0));
    assert.equal(events.at(-1).httpStatus, 200);
    assert.equal(events.at(-1).contentChars, 13);
    assert.doesNotMatch(log, /private-question|private-reply|fake-test-key|authorization/);
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
});

test("diagnostics distinguish HTTP failure, timeout and invalid successful responses without retries", async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "llm-diagnostics-"));
  const file = join(dir, "events.jsonl");
  config.llmDiagnosticsFile = file;
  try {
    capture([new Response("private-error", { status: 429 }), new Response("private-error", { status: 504 }),
      new Response("private-invalid-json", { status: 200 })]);
    for (const message of ["LLM http 429", "LLM http 504", "LLM invalid response"])
      await assert.rejects(liveProvider().chat([], []), { message });
    mock.method(globalThis, "fetch", async () => { throw new Error("private-transport"); });
    const deadline = new AbortController();
    deadline.abort();
    await assert.rejects(liveProvider().chat([], [], { signal: deadline.signal }), { message: "LLM timeout" });
    const log = fs.readFileSync(file, "utf8");
    const failures = log.trim().split("\n").map(line => JSON.parse(line)).filter(e => e.event === "request_failed");
    assert.deepEqual(failures.map(e => [e.failureCode, e.httpStatus ?? null]), [
      ["MODEL_RATE_LIMIT", 429], ["MODEL_HTTP_ERROR", 504], ["MODEL_INVALID_RESPONSE", 200], ["MODEL_TIMEOUT", null],
    ]);
    assert.doesNotMatch(log, /private-|fake-test-key/);
    // A failed diagnostic sink must not turn a valid model reply into a failure.
    config.llmDiagnosticsFile = join(dir, "missing", "events.jsonl");
    capture([reply(textOutput)]);
    assert.equal((await liveProvider().chat([], [])).content, "Hello");
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
});
