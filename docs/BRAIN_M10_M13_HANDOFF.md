# M10–M13 Brain integration-readiness QA (2026-10-17)

**Scope:** `feature/brain-core` only. `main`, Commerce migrations/DB, Draft PR merge state and deployment must not change.

## M10 — v9 operational startup safety

- `src/brain/schema-guard.ts` validates the expected **AI-only** DB identity, presence of `conversations`, `messages`, `user_preferences`, `turn_fence`, `turn_receipts` and critical v9 column types before running `PostgresSaver.setup()`.
- `src/brain/runtime.ts` fails closed on absent/incompatible version 9 schema. It does NOT auto-run destructive or automatic DB migrations.
- `tests/unit/brain-schema-guard.test.ts` covers missing receipts, wrong database, missing columns and incompatible JSONB column.
- **Existing v8 conversations are NOT migrated**. The existing v9 fail-closed guard prevents silently resetting old plans. Migration requires reviewed backup/rollback procedure and actual data inventory, not just a code change.
- Abandoned per-attempt checkpoint writes/blobs may persist; privacy inventory is read-only and remains documented. No production retention cleanup introduced without policy approval.

## M11 — Prompt context and memory security

- `src/brain/context.ts` now serializes previous plan, explicitly confirmed Memory and latest user message as one JSON user-level payload. Literal user-supplied delimiters cannot forge adjacent `previous_plan` or `latest_user_message` sections.
- Trusted static Skill guidance remains in the system prompt; past plan, current user input and long-term preference values remain lower-trust data. JSON encoding mitigates structural delimiter spoofing, **not every possible LLM prompt-injection effect**.
- `tests/unit/brain-context-injection.test.ts` asserts malicious text cannot change encoded previous-plan structure or enter trusted Skill instruction.
- Existing authenticated user ownership checks, explicit opt-in preference write confirmation, read-only Brain API and Graph source-message deduplication remain unchanged.
- Outstanding release gates: independent prompt-injection red-team on live model, distributed rate limits, CSRF strategy, secrets/privacy/retention review, full user data erasure.

## M12 — Reproducible intent quality evaluation

- `src/brain/eval-summary.ts` adds deterministic per-group and per-split case count/accuracy, query/budget/requirements/preference field accuracy, timeout/rate-limit/invalid-output buckets and latency p50/p95.
- `scripts/brain-intent-eval.ts` retains existing v1/v2 gold replay and explicit live opt-in. It adds the new quality metrics and suppresses raw provider exception text in machine-readable reports (potential sensitive data).
- Costs remain **NOT_MEASURED** instead of fabricating tokens or USD amounts. Real model latency, accuracy, token spend, and model-to-model comparison need explicit API access/budget, model identity, and independent holdout review.
- CI gold replay uses model-output fixtures; **60/60 replay is not 100% live LLM accuracy**, nor does it certify a human-reviewed holdout.
- `tests/unit/brain-eval-summary.test.ts` checks grouping, latency, error privacy and empty-dataset handling.

## M13 — RAG contract hardening before team API handoff

- `src/brain/rag-adapter.ts` rejects duplicate candidate `(productId,variantId)` pairs.
- Each candidate's aspect `evidenceIds` and hard-requirement condition proofs must map to existing evidence for the **same Commerce product** and its variant (or product-level `variantId=null`). Cross-product/variant borrowing fails closed.
- `tests/unit/brain-rag.test.ts` adds negative cases for mismatched product/variant evidence, misbound hard condition and duplicate candidate.
- Product existence, price, shipping and stock remain Commerce authoritative. RAG cannot authorize purchase/Cart writes.
- Current adapter checks a configured audit ID from the same upstream response; **matching an ID string is NOT independent external verification of Amazon-wide review counts**. Shipping requires audited source manifest/ETL proof and class-isolated synthetic vs real indices.
- **Integration handoff requirements from RAG team**: explicit `BRAIN_RAG_URL`, auth token if required, profile, canonical Commerce product/variant IDs, dataset class/version/checksums, review-count provenance, unique evidence IDs, aspect score method, expected error responses and valid fixtures; run negative and actual-data tests before calling the service connected.
- Existing CI runs against a local Mock RAG. No evidence of team Hybrid RAG production availability, actual Amazon data provenance or live LLM accuracy is claimed.

## QA acceptance and release decision

Gate on branch-HEAD: full TypeScript check, frontend build, Brain isolated unit, evaluation gold replay, isolated disposable `brain_ci` PostgreSQL, authenticated HTTP and Mock RAG, Chromium E2E. Legacy broad Commerce unit audit remains non-gating with known protected fixture/environment failures; do not label it PASS.

**No-Go remains:** external live-model quality and cost, real audited RAG/dataset ingestion, legacy v8 migration, distributed operational security/privacy, deployment and 5+ user tests. No merge to `main`.
