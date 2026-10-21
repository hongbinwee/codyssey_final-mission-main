# Hermes Agent V2 — single decision planning and typed search (2026-10-21)

Branch: `feature/hermes-agent`. Feature switch: `BRAIN_AGENT_ARCH_V2=1` (also requires the existing `HERMES_AGENT_ENABLED` path). **Default OFF**. No QA restart/deployment in this change.

## Why
The previous shopping path could call the intent-model planner, then an independent Hermes Tool-decision model, then RAG, another Hermes decision and a separate grounded explanation model. Model calls repeatedly reinterpreted the shopping goal; the Hermes model received only a partial Shopping Plan.

## What V2 changes
- Routing still provides fast authenticated CS/UI/review decisions and mandatory security boundaries. For new shopping discovery, `route → agent_decide` skips the separate intent-model planner.
- `search_products` becomes a parameterized Tool in V2. The *same first Hermes LLM decision* proposes a typed shopping intent (query, budget mode, required conditions, user preferences and category) **and** the Tool call. V1 keeps its empty-argument Tool untouched.
- `agent-search-intent.ts` parses the proposal through the existing `parseShoppingIntent`, enforcing mode/shape/limits, rejecting invented hard conditions and unauthorized budget/requirement clearing. The server reuses `resolveTurnPlan` and `rememberInterview`, applying existing explicit-gender, interview, sorting and exclusion logic before RAG.
- RAG/Commerce candidate verification, Ranking, Fencing, ownership, idempotency and previously published result types remain unchanged. Model proposals never authorize a purchase, cancellation, change of actor or unscoped product ID.
- Agent Context continues to include a bounded owned conversation transcript, previous displayed products, full key shopping conditions and observation summaries.
- After a simple search, V2 goes directly to the verified response node rather than spending another LLM call on an unnecessary stop decision. Complex prior-purchase, review and comparison requests continue through the Tool-observation decision loop.
- V2 skips the additional grounded model call when there is no verified review evidence to summarize. When evidence is present, the existing strict cited-grounding responder is retained.
- A model failure / invalid new Tool proposal does not silently send a stale prior Shopping Plan to RAG. V1 degraded recovery remains unchanged.

## Boundaries
- This is **not** the NousResearch Python Hermes runtime. It is a shopping-domain, TypeScript/LangGraph single-Agent orchestrator.
- V2 does not provide arbitrary model-selected writes. Existing Checkout/cancellation confirmation remains a separate server/UI flow.
- QA13 scoped semantic review RAG remains blocked pending RAG team support for enforced product-ID filtering.
- First-model hallucinations, incomplete follow-up context and model-specific nested Tool schema compliance must be validated against live models. CI mock correctness is not a live model quality score.
- A fallback to old V1 for rollout should be deliberate via feature switch, not an automatic silent bypass of user intent.
- This phase does not introduce new tables or alter canonical receipt/checkpoint payload shape.

## Deployment / validation
1. With V2 disabled, run H1–H6, QA09–QA11 and existing PostgreSQL tests, verifying no behavior regression.
2. With V2 enabled in a **separate isolated environment**, run direct Tool plan tests and multi-turn real-model tests. In particular: named product discovery, explicit male/female hard constraints, budget follow-ups, prior purchase comparison, order read, review target ordinal, rejection of guessed/unauthorized IDs and model failures.
3. Measure `hermesDecisions`, `hermesDecisionMs`, `retrievalMs`, `responseMs`, total wall time, ground-truth condition adherence and p50/p95 on identical prompts. Compare to V1 in the same environment. `agentV2` and `contextHistoryMs` identify the candidate path in traces.
4. Validate actual DGX RAG + Commerce + browser, separately from offline mock CI. No QA server switch without explicit approval.
5. Roll back by disabling `BRAIN_AGENT_ARCH_V2` and restarting only the separately approved candidate process; do not discard checkpoints or change the QA database schema.

## Known follow-ups
- Run true connected E2E with Claude and another candidate provider to confirm nested search Tool JSON support and next-turn context quality.
- Trace tool-to-evidence quality, request-level time budget across model, RAG and Commerce; currently their deadlines are not fully shared.
- Harden the model-output evidence citation and human judgment evaluation for semantic review comparison beyond mechanically verified excerpt IDs.
