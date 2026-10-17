# M15 — Operational Security & Release Readiness QA

Scope: `feature/brain-core` only. No changes to `main`, no Draft PR merge, no Commerce migration/data manipulation, no production deployment or destructive erasure.

## M15-A. Shared rate limiting (implemented, gated)

- `db/brain/003_brain_rate_windows.sql` creates **AI-only** PostgreSQL one-minute request counters (not local process maps).
- `src/brain/rate-limit.ts` uses one transaction for global and actor counters, obtains a DB-time minute boundary, updates both or **rolls back both**; quota failures return HTTP 429 and `Retry-After`. Any DB error fails closed and does not trigger a process-local unlimited fallback.
- `src/server.ts` applies quotas to authenticated Brain POST/DELETE only, before controller actions. Limits currently: **turn 12/user/min + 100 global/min; other Brain mutations 30/user/min + 300 global/min**. Multiple Node workers share the counters. Actor identities are hashed and request content is never in the rate ledger.
- This replaces the previous process-lifetime `brainTurns` quota. Advisory-lock concurrency is still enforced independently by the Graph.
- Tests: two independent PostgreSQL pools racing a shared actor, rejected-global-budget rollback, unrelated actor permitted, correct HTTP 429 with header, disabled service fail-closed behavior.
- **Unresolved:** the login/demo access-code exchange, Brain GET endpoints, all other Commerce endpoints and IP-based anonymous traffic have not been placed behind a multi-service WAF/global authentication throttle. A public release requires external ingress restrictions and abuse assessment.
- Rate window retention/cleanup: configuration/policy pending; the current migration **does not delete** rate records. Production scheduled cleanup must be scoped to AI DB and reviewed first.

## M15-B. Cookie CSRF enforcement (implemented, gated)

- `src/brain/csrf.ts` rejects missing or mismatched `Origin` / `Referer`, cross-site and same-site Fetch Metadata for cookie-authenticated Brain mutations; checks exact origin, not an arbitrary suffix; no trust in forwarded-origin headers.
- On **non-loopback hosts**, configure `BRAIN_PUBLIC_ORIGIN=https://<real-host>` (no trailing slash/path). Without it, cookie mutation requests fail closed. Local `127.0.0.1`, `localhost` and `[::1]` development origins are supported.
- Bearer-only clients may omit Origin because ambient cookies are not attached, but they must not include Cookie; explicit cross-site Fetch Metadata remains blocked. This does not confer any additional API tool/Commerce privileges.
- Unit tests: origin downgrade, suffix/domain spoof, missing Origin, cross-site metadata, cookie+bearer mix, public origin requirement. Authenticated live HTTP CI: valid session succeeds, missing origin and cross-site forged origin reject 403.
- **Unresolved:** session-cookie issuance on a TLS proxy needs `Secure` plus a trusted deployment policy. Commerce endpoints beyond Brain have separate CSRF posture and are **not certified by this Brain-only QA**.

## M15-C. Evaluation near-duplicate inspection (heuristic, not certified)

- `src/brain/eval-audit.ts` adds a metadata-only **character-bigram Dice** score between development and provisional holdout questions. Threshold 0.64. It outputs case IDs and similarity scores, **not prompts, previous plans, answers, or gold labels**.
- This produces **human-review candidates**, not a declaration of semantic equivalence. Lexical overlap can falsely flag unrelated scenarios; paraphrases with different words can be missed.
- Existing `eval/brain/intent-v2.json`: 60 synthetic cases, 45 development / 15 provisional holdout. Exact normalized cross-split duplicates: 0; provisional statuses `author_review_required` for all 60. Similarity audit flagged one candidate pair: `REQ_QHD` vs `REPLACE_REQUIREMENT`, score 0.762. A human/adjudicator must review prompt + previous state + intended plan privately.
- Holdout remains **not independently validated** and cannot support real LLM generalization claims. Live-model evaluation requires API and a separately approved call budget.
- CI reports may display case IDs but never actual question text. No automatic relabel or destructive dataset rewrite.

## M15-D. Checkpoint lineage, failure recovery and deletion policy (inventory only)

- **Defect:** v9's canonical `turn_receipts` row for a repeated Action ID updates `attempt_id` to the newest generation. Previously abandoned physical thread IDs could therefore disappear from actor-scoped privacy inventories.
- `db/brain/004_brain_attempt_history.sql` adds append-only `turn_attempts`, recording **every new physical generation** before graph execution. `FencedTurns.claim` writes it transactionally; `publish` marks the attempt COMPLETED in the same transaction as canonical result publication.
- `brainErasureFootprint` now follows both canonical receipts and the attempt lineage, including abandoned checkpoint blobs/writes; `checkpoint-retention-audit.ts` returns **only counts** for old PENDING generations superseded by newer generations, excluding active or published threads.
- Dry-run minimum age 7–3650 days, default 30. **This threshold is illustrative, not a legally authorized retention period.** There is NO DELETE endpoint, scheduled cleaner, SQL DROP or deletion of real records.
- Existing physical checkpoint threads created *before* 004 may be unindexed; a historical backup and manifest reconciliation is required before ever claiming account-wide erasure, and it is unsafe to discard these historical blobs blindly.
- An approved full-erasure design must: stop new claims via actor tombstone, serialize with in-flight generation locks, derive all physical thread IDs (including pre-004 recovery), reconcile receipt and snapshot references, delete in the correct dependency order, independently verify remaining actor counts, address model processors/logs/backups and record authorized approval. No such destructive path is implemented here.
- A hard crash can still leave read-only provider calls repeated; canonical output fencing ensures a stale physical generation is not published. This is NOT exactly-once billing or remote LLM execution.

## Release and QA gates

1. New 003/004 migrations run ONLY with explicit `BRAIN_MIGRATE_APPROVED=1` on an approved physically separate `brain_*` database. Startup rejects missing table/column contracts. Existing v8 conversation contents remain protected; there is no implicit v8→v9 conversion.
2. Perform TypeScript, full frontend build, Brain unit and provenance audit, disposable PostgreSQL concurrency/checkpoint tests, authenticated HTTP with CSRF and 429 checks, Mock RAG, Chromium, and dependency immutability.
3. Report **PASS/FAIL/NOT RUN** at the exact final `feature/brain-core` HEAD. Existing broad Commerce failures remain non-gating and do not count as PASS.
4. Prior to actual public release: rate/CSRF ingress review, session Secure cookie + CORS/proxy policy, provider budget, privacy erasure policy, backup/PITR/failover rehearsals, real RAG manifest validation, independent blind review, and 5+ actual-user tests.
5. No self-authorized production deployment, DB deletion, Commerce tool writes, PR readiness change or merge to `main`.
