# Agent-first cross-check — source and CI audit (2026-10-22)

Target: `hongbinwee/codyssey_final-mission-main`, `feature/hermes-agent`. Based on `d618824` and the small hardening commit following this review.

## Verified in code (not just presentation)
1. `runtime.ts`: new semantics run only if `HERMES_AGENT_ENABLED` and `BRAIN_AGENT_ARCH_V2=1`. Old V1 path stays intact.
2. `graph.ts`: when V2 is enabled, `prepare → route` produces a *neutral* `UNCERTAIN / search-possible` state and immediately sends ordinary messages to `agent_decide`, bypassing `guardBrainMessage`, `readAgentRoute`, review/wishlist keyword routing and the independent Intent LLM. Those old branches are still present strictly for V1; they are not called on V2.
3. `hermes-agent-step.ts`: one LLM decision proposes `respond_to_user`, `ask_user`, `reset_shopping_task` or an allowed read Tool, including `search_products` with a typed Plan proposal. Models cannot directly execute checkout/cancel/cart writes.
4. `agent-search-intent.ts`, `read-flow.ts`: server validates budget/hard requirement changes and authorizes Commerce-verified retrieval, not trusting LLM Tool arguments as write/identity authority.
5. `graph.ts` and `task-state.ts`: bounded Tool Call/Result transcript, actor-owned task, published checkpoints, fencing and per-conversation lock are retained; reset needs an explicit user reset phrase as a *server-side authorization check*.
6. `brain-agent-v2.test.ts`: deterministic provider tests show capability phrasing `넌 뭘할수있어?` reaches the LLM, mixed greeting + wishlist reaches the Tool, a question is checkpointed, no writes are executed, and prior displayed products survive follow-up reviews.

## Findings corrected during cross-check
- `safeAnswer` previously rejected ordinary newlines in a natural, multi-line assistant response; permit LF/CR/TAB while still rejecting other control characters. Align text response schema length.
- `agent_finish` previously used a product/tool-specific fallback for *any* no-Tool failure, including model timeouts on greetings. Give a non-product retry explanation and expose `agentModelUnavailable` / `agentDecisionInvalid` numeric trace flags.
- `searchKind` previously labeled **every** search after a previous plan as `SHOPPING_FOLLOWUP`, even if the model had selected a different product query. Distinguish new discovery by verified resolved query, so simple-discovery fast exits and UI intent metadata behave consistently.
- Add CI regressions for all three cases.

## Limits and remaining risks — Codex must not call these PASS on CI alone

**P0: Real-model contract.** No live Claude/Anthropic or gateway invocation has validated `respond_to_user`, `ask_user`, reset and nested `search_products.intent` JSON. `tool_choice:auto` allows a plain answer as well as a Tool call. Probe real use, especially multi-turn context, malformed tool arguments, parallel calls, provider timeouts.

**P0: Mixed read + conversational answer fidelity.** `agent_finish` composes a deterministic summary of successful Tool observations. The LLM's final `respond_to_user` text after reads is not rendered, intentionally to prevent unsupported claims. This can **lose the greeting or the user's requested aggregation**. Example: `안녕! 내가 찜한 상품 중 가장 저렴한 것도 알려줘` could successfully call `get_wishlist` but the current wishlist summarizer only lists names, not the cheapest by verified price. Do not solve by blindly displaying unverified LLM prices; implement/evaluate structured, evidence-grounded answer intent plus server-calculated lowest verified price if needed.

**P0: Review comparisons.** V2's neutral route and new-query search metadata are not yet equivalent to a proven `REVIEW_COMPARE` task classifier. Retain review Evidence and scope; verify whether aspect-ranking/review-compare requests reach correct read/grounded paths. QA13 scoped review filter in DGX is an external dependency.

**P0: Failure recovery.** Model failure currently gives safe retry text rather than injecting a fallback regex classifier. Check actual UI error display, retries, timeouts, fixed prompt variations and state preservation.

**P1: Long sessions and latency.** Only a bounded (four-turn) previous conversation history is passed with Shopping Plan and checkpoints. Measure actual limits, 18s per model decision/45s Agent budget, optional 25s grounded response, p50/p95 and extra Tool-selection turns.

**P1: QA/browser.** CI runs deterministic stubs, isolated PostgreSQL and synthetic browser/CSS regression, **not** logged-in QA with Claude+DGX+Commerce. Do not claim a deployed server has picked up the branch until running SHA and feature flags are verified.

## Codex handoff acceptance

Use an independent local Worktree pinned to the latest `feature/hermes-agent` SHA, without resetting another developer's uncommitted work. Do not touch `main`, `feature/brain-core`, current QA server or shared production DB. Activate `BRAIN_AGENT_ARCH_V2=1` only in the separate test process with Hermes enabled. Confirm authenticated startup, actor-owned Commerce/Brain DB and checkpoint, real Claude Tool Call → RAG/Commerce result, and browser-visible output.

Required conversations:
1. `안녕? 넌 뭘할수있어?`, `넌 뭘할수있어?`, `넌 뭘 할 수 있어?`: natural response, no search, one Agent decision.
2. `안녕! 내가 찜한 상품 중 가장 저렴한 것도 알려줘`: mixed intent; verify no lost greeting and correct owned, available, price-verified minimum.
3. `세럼 추천해줘 → 그중 1번 단점 → 좀 더 저렴하게 → 이번엔 무선 이어폰`: continuity, no old-category hard constraints, verified IDs.
4. `촉촉하다는 후기가 많은 순서로 비교해줘`: product scope, evidence correctness, no invented review ranking.
5. `내 주문 배송 어디까지 왔어?`: `get_orders → get_shipping_status`, owned order only, no unnecessary RAG.
6. `처음부터 시작`: reset only task/plan, keep memories/orders.
7. Provider timeout and malformed/parallel Tool calls: retries should preserve input; no fake Tool facts, no unauthorized writes.

Report each phase `PASS / FAIL / BLOCKED / NOT_RUN` with request/Tool trace, real model vs stub, running SHA, local URL, process ID, and measured timings. Preserve QA/server sessions unless specifically approved to restart.

Roll back test process with the V2 flag off. Do not silently apply V2 to existing QA.
