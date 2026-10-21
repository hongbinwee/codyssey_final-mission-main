# Shopping Brain integration gates — branch-only WIP

Baseline: `main` `782e67cd6efd815bc615830070e652b4b775567c`. **Never push into main directly.**

## Protected components
`src/catalog.ts`, `src/cart.ts`, `src/checkout.ts`, `src/orders.ts`, `src/cancellation.ts`, the existing `db/migrations/001..004`, and Commerce test database remain untouched. The v0.6 prompt and `AI_LIVE_DEMO=1` read-only gate are retained.

## Scope now
1. Fixed `page_context` handling in the existing Agent: allowlisted navigation hints appear only in the lower-trust user message, not system instructions.
2. Added isolated, read-only `src/brain/` recommendation contracts and `personalization.ts` with a consistent denominator, critical-facet coverage, Commerce G2 eligibility thresholds, review/spec evidence ID ownership and user context precedence.
3. Added explicit memory writing contract requiring a server-owned proof of source message and user confirmation. The included `InMemoryMemoryRepository` is **only a test double** and must never be used as production long-term memory.
4. Unit regressions cover ranking changes, coverage, invalid/missing evidence, review-count gate, tenant isolation and page-context injection.

## Important limitations
- There is **no real LangGraph integration, persistent checkpointer, real PostgreSQL memory repository, RAG connection or live LLM evaluation in this branch yet**.
- `PreferenceProofPort` is an interface, not a concrete signed/server-persisted confirmation implementation. Callers must supply verified `actorUserId`, owned `conversationId`, a source message, and a consumed confirmation token.
- `ProductCandidate`/evidence are presently assumed to originate from a trusted adapter. **Do not pass raw LLM-generated or unvalidated client JSON to `rankProducts`**. The trusted Commerce/Retriever mapper is still required.
- Scores and missing coverage threshold are **heuristic experimental values**, not an empirically calibrated recommender; keep them behind a feature flag and measure against a holdout set.
- G2 5-star rating and verified whole-review count are kept unchanged. When whole-review count is missing, return `referenceOnly`; do not silently promote it.
- Existing evaluation uses regex IDs; typed evidence mapping must replace it before claiming RAG groundedness.
- `get_cart` is marked READ by Tool Registry but can cause an upsert; do not expose it through a read-only DB role without review.
- Graph checkpoint replay must not execute Commerce writes without independently validated user intent/approval, freshness/version, and idempotency.
- Existing Commerce `scripts/migrations-manifest.ts` only registers phases 0..6. AI memory migration must be isolated and explicitly opted in; never silently append a migration to the protected Commerce path.

## Next gates in priority order
1. Verify **full repository** `npm run check`, `npm run test:unit`, and targeted security regression on an isolated checkout. Results have not been run in this connector-only session.
2. Pin/test LangGraph JS in existing Node runtime, build a minimal state graph using scripted Provider and mock Retriever.
3. Implement server-owned conversation, persisted message source, consent and deletion semantics against a fresh **AI-owned scratch PostgreSQL**; verify restart, tenant isolation and concurrency.
4. Define and verify the real Amazon/RAG `productId` / `variantId` / `reviewId` mapping and whole review count. Keep read-only demo functionality until this is demonstrably safe.
5. Integrate behind opt-in `BRAIN_V2_ENABLED`; compare legacy vs new output, claims, latency and Tool calls. Add Cart only after safety checks.
6. Open **draft PR** against main for PM/QA review, without merging.

Architecture principle: **Commerce First, AI as an Extension**.
