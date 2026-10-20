# Hermes H6 local verification — 2026-10-20

Scope: `feature/hermes-agent` source `734c187`, dedicated managed worktree `hermes-h6-live`, HTTP port 3136, new PostgreSQL cluster 15442. Existing Brain Core/Hermes 3124 services, databases, sessions, worktrees and tunnels were preserved. Public origin: https://grey-prescription-beast-die.trycloudflare.com . Six newly generated H6 access codes and a separate session secret are local-only.

## Corrections

- Request serial tool selection at the provider boundary; retain whole-batch rejection when a provider still returns multiple calls. This fixes valid multi-step requests being discarded before any tool executes.
- Combine bounded verified cart/order/product/review/shipping observations. Preserve cart totals and order composition on compound questions, deduplicate matching order summaries, disclose unavailable cart options, and never use model prose as facts.
- Recognize order arrival/detail/amount reads and retrospective cart wording while retaining mutation blockers.
- Add strict `hermes-h6` local Commerce/Brain identity; disallow reuse of existing Brain state. Allow only the existing cancellation approve/execute UI endpoints in this isolated profile; preserve origin and confirmation checks.
- Correct two stale catalog/policy unit assertions.
- RAG `profile`/`filters.in_stock` 422 investigation and changes were explicitly excluded at the user's request. Adapter/test edits were restored. Earlier exploratory search results are not a release pass.

## Executed evidence

| Check | Result |
|---|---|
| Final whole-project Typecheck / Build | PASS / PASS |
| Final focused regression (provider, H1-H6, grounded timeout, QA isolation, stale assertions) | 144/144 PASS; deterministic tests |
| Baseline full unit suite | 1,021 total: 977 PASS, 43 FAIL, 1 SKIP |
| Baseline failure classification | 37 missing pinned audit/SQL backup artifacts, 4 missing DB/provider configuration, 2 stale assertions corrected; full suite not rerun |
| External login / unauthenticated denial / Secure cookie / Brain and catalog APIs | PASS |
| Real Claude browser Brain E2E | 10/10 PASS; exact tool sequence 10/10; no RAG calls; p50 5,433 ms, p95/max 13,632 ms |
| Initial direct read API measurements | 16 attempts, actual model called on 15; exact sequence 12/16; p50 5,760 ms, p95/max 16,678 ms; 2 route misses subsequently fixed |
| Targeted live retests | Order detail `get_orders -> get_order`: 8,230 ms; retrospective empty-cart read `get_cart`: 4,664 ms; both PASS |
| Grounding | 14/14 initial observed summaries checked against actual observations; not a measurement of recommendation semantics |
| Cross-actor isolation | 10/10 HTTP 404: foreign order/detail/shipping/cancel eligibility/valid quote and conversations |
| Read-turn Commerce preservation | All 10 measured tables unchanged before/after direct reads, browser Brain reads and targeted retests |
| Connected Commerce UI | Product/cart/quote -> explicit simulated checkout -> paid local order -> orders/history -> shipping; PASS in prior local browser evidence |
| Connected cancellation UI | 4/4 PASS; zero approve/execute before final CTA; one approve then one execute, both 200; persisted REQUESTED |
| Actual payment | All 2 local payment rows are SIMULATED; outbound fetch guard permits only existing Claude/Decisions/RAG endpoints; no payment gateway |
| DGX writes | External catalog connections set default_transaction_read_only and verify it; no DGX permissions/schema changed |

Remaining direct tool-path variations: shipping summary can finish after get_orders when status is already present; a review request performed two review queries. These remain deviations under the strict sequence evaluator. The earlier two live route misses must not be counted as passing original samples. The browser retest uses the corrected source.

Wishlist UI verification remains **FAIL/INCOMPLETE**: the original harness toggled an already-saved item and expected it saved; a follow-up request wait timed out. No product-code fix or successful wishlist write E2E is claimed.

Full H6 gate is **INCOMPLETE**, since RAG/recommendation/purchase-personalization and fault/load recovery are excluded/not run; direct live sample minimum 20 is not met in this scoped run. Recommendation explanation/follow-up quality is not certified by the read-only browser samples. Provider cost is NOT_MEASURED. No fabricated fixtures were substituted for missing audit artifacts.

## Local process management

Worktree: `C:\Users\proje\.codex\worktrees\hermes-h6-live\codyssey_final` (detached, pinned to a commit from feature/hermes-agent so the prior branch checkout is preserved).

Ignored local runtime: `.local-data/h6`. Credentials: `.secrets/access-codes.json` in that directory; never publish them. `running.json` records server PID/port/source SHA; `server.pid` and `tunnel.pid` identify H6-only processes. Existing tunnel connects only 127.0.0.1:3136. Quick Tunnel hostname lasts while that H6 connector runs.

Final launcher: `node .local-data/h6/start-release.mjs` from this worktree. Launch with PowerShell Start-Process -WindowStyle Hidden and dedicated stdout/stderr files. It reuses H6-only DB/auth and does not initialize or reset databases. Stop only this server by creating `.local-data/h6/stop-server-release`; remove that sentinel before an intentional restart. Do not use old launchers or initialize/seed scripts. Tunnel shutdown, if desired, targets only the PID recorded in tunnel.pid; restarting Quick Tunnel may change the hostname and requires updating the allowed public origin. PostgreSQL data remains in `.local-data/h6/pgdata`.

Evidence is ignored local data: `regression-release.log`, `live-final-raw.json`, `browser-brain-final-raw.json`, `browser-brain-final-metadata.json`, `commerce-final-preservation.json`, `browser-brain-preservation.json`, `isolation-final.json`, `targeted-retest.json`, `results/browser-final-2026-10-20T09-48-58-119Z.json`. Raw prompts, observations, IDs and codes are not committed.
