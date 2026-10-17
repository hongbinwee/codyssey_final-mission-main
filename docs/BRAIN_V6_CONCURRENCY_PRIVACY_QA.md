# Brain v6 — concurrency, retry and limited-memory-erasure QA

**Branch:** `feature/brain-core`. The user explicitly prohibits merging or pushing to `main`.

## Changes
- `src/brain/graph.ts`: per-instance `inFlight` map coalesces requests only when `actorUserId`, `conversationId`, `clientActionId` and `userMessage` all match. This prevents duplicate LLM/RAG work during same-process concurrent retries. A different action on an active conversation is rejected rather than racing through LangGraph.
- `src/brain/api.ts`: conflicting new requests return HTTP 409 `CONVERSATION_BUSY` instead of incorrectly implying an upstream provider outage. Same action ID with different message remains invalid.
- `tests/brain-db/brain-pg.test.mjs`: disposable PostgreSQL assertions verify same-action coalescing, different-action contention, duplicate-ID mismatch, cross-user denied access, post-lock progress, crash/reconnect recovery from a failed RAG turn and single source-message storage.
- `src/web/components/BrainPreview.tsx`: explicitly describes the limited scope of a preference DELETE. The canonical `user_preferences` row is removed, but a prior message, task-local preference and checkpoint can still exist.
- `tests/brain-browser/brain-browser.test.mjs`: uses real Chromium to delete the saved price preference and inspect the limited-scope notice.

## Crucial distinction: memory DELETE vs complete erasure

`DELETE /api/brain/preferences/price_priority` deletes **only the actor-scoped canonical long-term preference**. It does not redact stored message content, previous `shoppingPlan.currentPreferences`, checkpoint snapshots, user-provided source messages or the database's WAL/backups. Do not tell a user that their entire memory/history was erased when this endpoint succeeds.

Full privacy deletion requires a separate reviewed protocol for actor-owned conversations, checkpoint rows/metadata, pending proposals, retention, service backups, replay and audit logs. No such production deletion API is added in this milestone; implementing an unverified destructive endpoint would be unsafe.

## Known limitations and release blockers

1. **Distributed concurrency**: in-process `Map` is not a database lock, so multiple backend replicas can still simultaneously run one conversation. Production requires cross-process fencing/serialization, probably PostgreSQL advisory session lock or an external queue with ownership-scoped lease and replay tests. This test suite does **not** claim cross-process consistency.
2. **Crash timing**: one failed-RAG checkpoint restart scenario now passes. A crash precisely between LangGraph write phases, provider 429, hard timeouts and partial network responses remain additional controlled chaos-test work.
3. **Data authenticity**: the test RAG feeds CI-only invented products/reviews and has zero proof about real Amazon provenance. No synthetic v4/v5 product data has been merged into real data.
4. **Independent blind annotation**: 60 v2 cases and a blind-review template exist, but an external reviewer has not returned labels; no final holdout certification yet.
5. **Full legacy Commerce regression**: protected fixture-dependent old suites are non-gating. A Brain CI green signal cannot be described as all Commerce tests passing.

## Acceptance and verification

- Run the branch-only Brain GitHub Actions workflow, including full TypeScript/build, Brain unit/contract, isolated PG, authenticated HTTP mock RAG, real Chromium browser and mock-only measurements.
- Report the latest run ID after completion; do not assert a PASS before the run concludes.
- Use no Commerce production DB and do not run migrations against the real database.
