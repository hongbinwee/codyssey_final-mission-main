# Hermes H4 — LangGraph Autonomous Read Agent (2026-10-20)

## Goal
Complete the executable loop **choose Tool → execute authenticated read → inspect observation → choose next Tool / ask / stop**. Do not encode the eight examples as dialog scripts. H1 wishlist, H2 Task State and H3 typed Tool ports are reused; established Commerce-verified RAG ranking remains the **only** source of recommendation cards.

Branch: `feature/hermes-agent` only. `main`, `feature/brain-core` and QA server have not been modified.

## Implemented graph
```
prepare (scope, prior canonical receipt, memory)
  → route
    ├─ historical explanation → explain_previous → END
    ├─ simple owned wishlist list/selection → wishlist → END
    ├─ eligible owned cart/order/delivery read → agent_decide
    ├─ new recommendation → plan → clarify OR agent_decide
    └─ greeting, unsafe writes, unsupported CS → converse → END

agent_decide
  ├─ allowed Tool choice → agent_execute → agent_decide
  ├─ verified search already executed → respond (canonical ranking) → END
  ├─ failed/unfulfilled explicit recommendation → agent_recover (verified, scoped retrieval) → respond/END
  └─ enough read facts / one question / budget or invalid output → agent_finish → END
```

### Design safeguards
- Each step is a LangGraph node: Checkpoint/fencing/actor ownership are preserved in `graph.ts`. A new turn resets tool observations while keeping the canonical H2 Task State.
- `hermes-agent-step.ts` supplies pure-ish decision, read dispatch, stop policy and deterministic evidence-based read summaries. It **reuses H3's canonical Tool definitions and argument validator**, not a second permissive registry.
- Nine read Tool names are available conditionally. No model-selected writes, checkout, cancellation, cross-tenant IDs or direct DB access.
- Product and order references must be observed in prior **server-issued** Tool output within the current turn. Invalid JSON, unauthorized IDs, unsupported Tool names, duplicate/parallel requests or missing privileges are rejected before dispatch.
- The read agent does not offer `search_products` for owned-order/cart lookups. Ordinary new-product discovery can use RAG only via the verified graph search Tool. The previous unconditional `deep` search node was removed.
- The model reads bounded observations and can choose a new Tool on the next checkpointed step. Its free-form prose cannot become authoritative recommendations, prices, shipping dates or payment decisions.
- Up to five serial reads, 45-second **decision** budget beginning after shopping-plan extraction, and up to 18-second timeout per model decision. Tool/DB/RAG execution is not yet governed by one fully propagated end-to-end deadline.
- If an explicit product recommendation has no validated candidates because the model returned DONE or timed out, a separate **degraded-only** path reuses authenticated purchase snapshots, retrieves and ranks actual catalog products and applies verified cheaper/review-count constraints. Owned-order and cart reads never go through that search fallback. If the user answered with a valid one-question clarification, no premature search is triggered.
- Generic agent clarification is stored in H2 `AWAITING_INPUT/agent_followup` and can be resumed on neutral answers; clear new intents, restricted changes and greetings are not captured.
- When a product's options have different availability, server summaries use only actually AVAILABLE variants for the displayed minimum unit price and show shipping separately; they do not invent a paid quote.
- Other systems' written policy / Skills and the authenticated origin are authoritative over untrusted review/product text. Previous recommendation-rationale no-retrieval fast path is unchanged.

## Real verification
Run: [GitHub Actions #39352356535](https://github.com/hongbinwee/codyssey_final-mission-main/actions/runs/39352356535), commit `8874763f9ddfe1e046f49734d3064911462441e8`.

- `npm ci` — PASS
- `npm run check` — PASS (whole repository)
- `npm run build` — PASS
- H1-H4 + purchase, V4, routing, history regression — **80 / 80 PASS**.
- Agent-graph tests use actual `MemorySaver` and a deterministic mock LLM/Tool ports (no live account or network required). They validate no-search reads, order→shipping, cart, protected write intents, purchase-history-first recommendation, model failure and verified fallback, question→await→resume, forged IDs, variant-availability pricing, and graph state persistence.
- Broader `npm run test:unit` diagnostic run: **996 tests, 951 passed, 44 failed, 1 skipped**. Many failures require unavailable legacy `shots/` backup/snapshot artifacts or live credentials; other older unrelated tests have differing expectations. The non-blocking diagnostic step intentionally uses `continue-on-error: true`; its failure is **NOT** a PASS and must not be represented as one.
- NOT RUN: actual Claude/OpenAI reasoning/Tool-choice evaluation, production-like Postgres checkpoint/fencing multi-process integration, connected real Commerce/RAG provider QA, interactive browser E2E, p50/p95 production latency and live QA deployment.

## Next acceptance gates (H5 / H6)
1. H5: server-validated action descriptors (product detail/cart/checkout/cancel eligibility); explicit per-operation user approval, idempotency and conflict recovery. **No AI-triggered real purchase/cancel**.
2. H6: instrument tool-choice exact-match/precision, unnecessary search rate, grounding/citation validity, total p50/p95, retries, cancellations, tenant isolation, prompt injection and dataset/version transitions with real connected providers.
3. Independent QA should confirm read-only order and cart requests are actually exposed in the selected QA Commerce configuration (`qaCommerceActivityAllowed`), and live RAG sources are properly mapped.
4. Only separately authorized releases may deploy or restart QA server. No branch merge is implied by this report.
