# Brain v4 — real Chromium QA and latency boundaries

**Development branch only:** `feature/brain-core`; base `main` remains protected. Do not merge without an explicit separate approval.

## Goal and change boundaries

"Commerce First, AI as an Extension": new work focuses on proof that users can sign in to the existing storefront, use the additive Brain Preview, confirm durable preferences, observe different product rankings for an identical candidate set, retain budget during a follow-up turn, and recover from a transient RAG outage.

No Commerce business rules, product schema, stock, order, checkout or production databases are migrated. Browser E2E uses fresh CI-only disposable `commerce_brain_browser_ci` and `brain_ci` PostgreSQL databases. All reviewed products/reviews and model/RAG responses are CI fixtures, not real shopping claims.

## New browser E2E: `tests/brain-browser/brain-browser.test.mjs`

Run only on the explicitly isolated CI environment, after `node scripts/brain-migrate.ts` targets `brain_ci` and the schema is verified. The test starts a real Commerce/Brain HTTP server and real Chromium through Playwright's JS API.

- Existing session login through `/api/session`.
- Existing storefront icon opens the Brain Preview.
- Input question returns an actual React-rendered ranking and preserved 500,000 KRW task budget.
- Confirm `price_priority=value` with proposal + explicit user confirmation; new turn ranks the lower-cost CI fixture first.
- Confirm `price_priority=performance`; new turn ranks the higher-performance CI fixture first.
- Simulate one upstream RAG HTTP 503: UI retains the unsent user text, shows an error and does not append a successful recommendation; retry works.
- Explicitly check no `cart_items` or `action_requests` writes. Note: storefront GET /api/cart can lazily create an empty cart; cart-row count is not a reliable mutation assertion.
- Failures are reported as failures; do not disable tests to achieve a green build.

## Fixes during QA

- `src/web/components/BrainPreview.tsx` now handles fetch rejection for preference proposal, confirmation and deletion without an unhandled rejection.
- Browser spec awaits a newly rendered response card rather than interpreting an existing card as the next turn.
- `src/server.ts` reads optional image file bytes before sending a 200 response, and does not attempt a second HTTP header when a response already started.
- `src/brain/api.ts` reports a separate `graphWallMs` based on complete graph invocation; `totalMs` remains the historical research-only timing (not identical to end-to-end client latency).
- `src/brain/latency.ts` provides bounded pure p50/p95 calculation. Chromium test logs those percentiles **labeled CI/mock-only**, with model and RAG replaced by loopback fixtures.

## Remaining release blockers

- **Actual LLM token/latency/error-rate evaluation is not verified** without a real production-like provider, credentials, agreed test dataset, and controlled spend. CI mock latency is *not* evidence of live-model p95.
- **Real Amazon/RAG**: upstream dataset audit, review count and cross-product evidence provenance must be independently verified.
- **Real-user usage and UX**: 5+ feedback interviews/testing, actual browser/device and accessibility validation; single simulated Chromium browser is not that.
- Multi-instance distributed locking, auth/session production review, rate limits, retention/deletion semantics and safe write-tool confirmations are not release-ready.
- Legacy Commerce broad unit audit is deliberately non-gating because its protected dumps and environment are unavailable on this GitHub runner; do not interpret overall CI green as full Commerce legacy QA passed.

## Verification

Use the latest GitHub Action on Draft PR #1 for branch HEAD. Gating steps should include:
`npm ci`, full `npm run check`, `npm run build`, Brain mocked unit regression, isolated real PostgreSQL Memory/checkpoint, authenticated HTTP/RAG tests, Playwright Chromium E2E and dependency manifest no-diff check.

**Do not run protected Commerce migrations, do not push/merge to main, and do not treat test/mock evidence as real Amazon review evidence.**
