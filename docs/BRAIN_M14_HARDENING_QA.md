# M14 — Independent Brain hardening / release-readiness audit

**Repository:** `hongbinwee/codyssey_final-mission-main`  
**Allowed branch only:** `feature/brain-core`; preserve Draft PR #1.  
**Isolation:** no modification of `main`, Commerce business logic/migrations, existing Commerce DB, production data, provider credentials or deployments.

## Findings and fixes

### M14-A. Model output errors must not be blamed on the user (fixed)

- Previously `parseShoppingIntent` and `providerIntentModel` threw generic `invalid ...` errors, while the API returned 400 for all generic invalid errors. A malformed JSON/schema/tool response from the model could masquerade as a bad end-user request.
- `BrainModelOutputError` now distinguishes bad LLM output from invalid user input. `src/brain/api.ts` returns a non-disclosing **502 `MODEL_OUTPUT_INVALID`** for this typed error while actual invalid user parameters still return 400.
- `tests/unit/brain-model-output-errors.test.ts`: malformed JSON, unsupported preference, disallowed tool call and true bad-client-parameter scenarios; no provider secrets in API response.
- Model 429/504 and explicit same-action recovery are unchanged.

### M14-B. v8→v9 upgrade inventory is read-only (implemented; live migration not approved)

- `src/brain/legacy-migration-audit.ts` classifies **legacy physical checkpoints, v9 canonical receipts, pending-only attempts, empty conversations and inconsistent pointers**, returning only actor-scoped aggregated counts.
- `tests/brain-db/brain-legacy-migration-audit.test.mjs` runs on disposable `/brain_ci`, creates dedicated test tenants, proves no existing checkpoints were modified, checks wrong-tenant separation.
- No state copying, deleting or automatic upgrade. Existing v8 messages/checkpoints remain protected by v9's fail-closed guard.
- Production upgrade requires verified last-complete v8 checkpoint selection, backup/rollback plan, concurrent traffic freeze, exact per-thread data reconciliation, explicit approval, and isolated migration rehearsal.

### M14-C. Evaluation integrity (implemented; external blind review outstanding)

- `src/brain/eval-audit.ts` and `scripts/brain-eval-audit.ts` perform metadata-only NFKC/whitespace/punctuation-normalized exact duplicate checks between evaluation splits; report labels, case counts and annotation status, **never print questions or gold answers**.
- CI fails on malformed/duplicated IDs or cross-split identical logical scenarios. Lack of external adjudication is *reported* rather than falsely treated as certified.
- The existing v2 60 cases split into **45 development + 15 provisional candidate_holdout**. Exact split overlap: **0**. `author_review_required`: **60/60**. `independentlyApproved=false`, `safeForBlindHoldout=false`.
- This is not a semantic near-duplicate or model-contamination audit. Gold replay accuracy is NOT live-model accuracy.

### M14-D. Closed-conversation publication race (fixed)

- `FencedTurns.claim` and `FencedTurns.publish` check actor ownership and `closed_at IS NULL` inside the DB transaction, taking a shared lock on the conversation row. This serializes these mutations against future conversation-close/erasure operations and prevents a stale attempt from becoming canonical after a conversation has closed.
- Real-DB negative QA asserts that another actor cannot claim a conversation, a valid pending attempt cannot publish after the test conversation closes, and canonical pointer stays absent.
- No new close/erasure endpoint; the test modifies only disposable AI fixture rows.

## Important open issues, not mislabeled PASS

- **RAG provenance:** an audit-ID echo from the same upstream RAG is not independent source-wide review count verification. Reconcile using independently approved signed/versioned manifest and Commerce source-product map before enabling audited-real G2 recommendations.
- **Evaluation:** independent human/agent blind adjudication and true model-evaluated data are absent; similarity/semantic duplication still requires review.
- **Data retention:** abandoned attempts, checkpoint blobs/writes, logs and backups require an approved deletion/tombstone/retention policy. No destructive delete feature is enabled.
- **Legacy upgrade:** actual v8→v9 migration and old-user regression remain NO-GO until approved backup/rollback and independent staging QA.
- **Operations:** multi-DB failover/PITR, distributed rate limits, real provider 429/timeout latency and user-facing mobile/accessibility security review are not yet verified.
- **Commerce:** broad legacy Commerce unit audit has known non-gating failures. Green Brain CI never certifies the entire Commerce service.
- **Actions:** Brain remains read-only; no autonomous cart, checkout or cancellation until Commerce authorization, explicit approval and side-effect idempotency.

## Independent validation gates

CI must confirm typecheck, frontend build, isolated Brain unit and deterministic evaluation replay, `brain-eval-audit.ts`, disposable PostgreSQL full integration suite, authenticated HTTP/Mock RAG, Chromium E2E, and dependency immutability.

**Do not claim CI PASS for a new HEAD until that exact run completes successfully.** Capture the run URL, commit SHA and per-layer test counts; keep the PR Draft and `main` unmodified.
