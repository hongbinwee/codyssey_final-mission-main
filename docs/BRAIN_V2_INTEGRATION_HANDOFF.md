# Shopping Brain v2 — isolated integration handoff

**Branch only:** `feature/brain-core`. Never merge or push to `main` without explicit separate user approval.

## 1. Commerce First, AI as an Extension

- Existing React storefront, Node Commerce API, cart, checkout, orders, and base migrations 001–004 remain canonical and unchanged.
- Brain is **opt-in** using `BRAIN_ENABLED=1`. Without it, `/api/agent/turn` and the existing AI panel are unchanged.
- Old read-only `AI_LIVE_DEMO=1` and new `BRAIN_ENABLED=1` are mutually exclusive; startup fails closed if enabled together.
- New authenticated API endpoints use server-side session cookie actor, not `actorUserId` from request data.
- Brain uses its own PostgreSQL *database* named `brain_*` (not only a different schema within the Commerce database); startup rejects a DB target shared with Commerce.
- `src/brain/runtime.ts` creates an independent postgres.js pool and LangGraph PostgresSaver with schema `shopping_brain`. `setup()` only runs after verifying the AI DB and schema.

## 2. Controlled local setup

Prerequisites: Node 24+, a **fresh user-owned AI PostgreSQL database**, existing user-owned Commerce DB, and a configured LLM Responses API provider.

1. Provision a separate database named e.g. `brain_dev` with private credentials. **Do not use** `commerce`, `commerce_test`, protected snapshots, preserved volumes or production databases.
2. Set `BRAIN_DATABASE_URL` to this DB. Keep `DATABASE_URL` pointed only at an authorized Commerce environment.
3. With the destination positively verified as the fresh AI database only, use `BRAIN_MIGRATE_APPROVED=1 node scripts/brain-migrate.ts`. Never run the Commerce migration runner to set up Brain.
4. Configure `LLM_PROVIDER=live`, `LLM_API_KEY`, `LLM_MODEL`. Only then set `BRAIN_ENABLED=1`. A local test-only Responses mock is used by CI; CI makes **no public LLM API calls**.
5. `npm ci`, `npm run check`, `npm run build`, `npm start`. Log in with the existing Commerce test account, open the Shopping AI panel; the opt-in Brain Preview is shown when `/api/brain/status` succeeds.

The app displays a user-confirmed preference-write flow; proposals expire after ten minutes and can be consumed once. Browser-origin mutation checks and in-process per-user rate limits apply. For public deployment, add distributed rate limits, CSRF strategy and retention/deletion controls.

## 3. Authenticated routes

All routes below require the existing authenticated session, and no route accepts a request-body actor override:

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/brain/status` | GET | Preview enabled status |
| `/api/brain/conversations` | POST | Create actor-owned conversation |
| `/api/brain/conversations/:uuid/turn` | POST | Read-only research via Postgres-backed LangGraph; `user_message` / `client_action_id` |
| `/api/brain/conversations/:uuid/state` | GET | Return owned checkpoint metadata only, not raw state |
| `/api/brain/preferences` | GET | Retrieve scoped preferences |
| `/api/brain/preferences/proposals` | POST | Propose sourced preference for explicit confirmation |
| `/api/brain/preferences/confirm` | POST | Consume one-shot confirmation proof and persist preference |
| `/api/brain/preferences/:key` | DELETE | Delete one's own preference |

The new Brain makes **no Commerce cart/checkout/cancellation writes**. New Brain tool calling for writes is NOT implemented yet.

## 4. RAG team handoff: exact RetrieverPort contract

`src/brain/contracts.ts` defines `RetrieverPort.search({query,maxTotalWon,requiredConditions})` returning `{candidates,evidence}`. Team integration must implement this port (no changes to Commerce service contracts).

Every `ProductCandidate` must contain:
- Canonical Commerce `productId` and `variantId` mapping and confirmed currency/variant price and shipping fee.
- `rating`, `ratingScale`, `wholeReviewCount`, `wholeReviewCountVerified`, with provenance. **Do not convert imported stored-review count to verified Amazon-wide count.**
- `conditions` as a mapping from each hard requirement to supporting evidence IDs. Missing evidence means requirement not met/unknown, not a pass.
- Optional `facets.performance/eye_comfort/noise` each with normalized [0,1] score and `evidenceIds`. Facet scoring method/calibration must be documented; LLM free-text guesses alone are not validated scores.
- `EvidenceRecord` ID, canonical `productId`, optional `variantId`, kind `SPEC` or `REVIEW`, `sourceKind` REAL/SYNTHETIC for reviews, source reference. IDs should be stable and unique. No cross-product evidence borrowing or fabricated citations.
- Retrieved review text is untrusted; do not splice it into system/policy prompts.

Without verified whole-review count, existing v0.6 **G2** remains fail-closed: displayed candidates are `referenceOnly`, not eligible recommendations. The default `commerceRetriever` is deliberately limited to this honest reference-only fallback; it is **not the team's Hybrid RAG**.

## 5. QA matrix / gates

- `npm ci`, full TypeScript check, frontend build and targeted Brain unit tests: GitHub Actions.
- Isolated `brain_ci` PostgreSQL: actual schema migration, idempotent message writes, tenant ownership, concurrent one-use preference confirmation, memory-driven preference ranking changes, PostgresSaver checkpoint survives saver recreation.
- HTTP integration: short-lived mock Responses API on loopback, disposable `commerce_brain_ci` plus `brain_ci`, session cookie auth, cross-user 404, Origin gate, read-only Commerce effects, G2 reference-only fallback, explicit memory saving.
- CI's broader legacy Commerce unit suites depend on historical protected snapshots and env not present in clean runner; results are reported separately and are NOT full-Commerce PASS.
- Still pending: actual team Amazon/RAG, real LLM quality assessment, claimed aspect-grounding evaluation, browser Playwright run, deployment, real-user feedback (5+), production retention/security/privacy review.

## 6. Boundaries and next handoff

No fork, no Commerce DB write during Brain tests, no automatic `main` merge. Keep draft PR #1 open for review.

After receiving actual RAG Adapter implementation, add fixture-based and real-data evaluation gates for personalized ranking, source-quality audit, p50/p95/TTFT and real browser shopping comparison. Implement cart writes only with approved server-side explicit confirmation and established Commerce idempotency/version checks.
