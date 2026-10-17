# Brain v7 — distributed turn serialization, provider failures and privacy erasure plan

**Only `feature/brain-core`**. `main` may not be pushed, modified or merged.

## Delivered implementation

- `src/brain/turn-lock.ts`: SHA-256 domain-separated, deterministic signed 64-bit advisory lock key derived from server-owned conversation UUID. Uses a **reserved connection to the separate AI-only PostgreSQL database**, `pg_try_advisory_lock` before any LangGraph checkpoint read/write, `pg_advisory_unlock` in a `finally` block and returns the connection to its pool.
- `src/brain/runtime.ts` injects this TurnLock when the feature-flagged Brain is initialized. Existing code-only/isolated Graph mocks may omit the lock but never claim multi-process isolation.
- `src/brain/graph.ts` keeps local in-flight same-action coalescing, while the session lock blocks overlapping executions in a **different worker process**. The second worker returns a retryable `CONVERSATION_BUSY` response (409); after the first worker commits, the second can retry the same action and retrieve the completed checkpoint without repeating search or planning.
- `src/brain/api.ts` reports generic, non-sensitive model 429 as `MODEL_RATE_LIMIT` and timed-out model calls as `MODEL_TIMEOUT`, with 429/504 statuses. Unexpected internal errors remain generic 503.
- `BrainPreview` supplies distinct Korean UI retry guidance without clearing draft input or producing a fake successful answer.
- `tests/brain-db/brain-pg.test.mjs` creates two independent Graph/DB-pool/Checkpointer instances in disposable CI PostgreSQL. One holds its advisory lock during a blocked retrieval; a second cannot execute either the same or a different action until release. Completed checkpoint replay does not duplicate retrieval.
- `tests/unit/brain-provider-failure.test.ts` classifies injected 429, timeout and unsafe internal errors; Chromium test injects 429 and asserts draft preservation / retry / budget carryover. No protected Commerce DB is used.

## Why this is safer than a process-local mutex

A single-process `Map` cannot coordinate parallel Node processes or serverless instances. PostgreSQL advisory session locks operate on a shared, AI-only DB and serialize a conversation across instances that use the same runtime, even with separate LangGraph Checkpointers. They require a **single reserved connection throughout the Graph operation**, never a transaction-scoped lock that is released before long external model calls. Contended requests fail quickly, rather than queueing unbounded model calls.

## Distributed/operational limits — do not claim everything is solved

- A dropped database session releases advisory locks. The v7.1 lock-ownership check detects the common case of a lost owner at graph node boundaries, but **it cannot make a check and LangGraph checkpoint write atomic**. A session may disappear after verification. **Transactional fencing / a versioned ownership claim remains required before formal exactly-once semantics or Commerce write tools**. Killing the lock PostgreSQL backend is now exercised in CI; it is NOT a full process-kill or network-partition/failover test.
- All participating workers must point to the **same AI PostgreSQL cluster** with the same versioned hash-key algorithm. Different database clusters cannot share an advisory lock.
- The key is 64-bit and collision-resistant with SHA-256 truncation, not mathematically collision-free. A hash collision only causes unnecessary contention across different conversation IDs, not data crossover.
- Checkpoint writes and external model calls are still not a distributed atomic transaction. A provider may have processed a request before the app lost the response. Completed-action replay is safe for read-only Brain, but **DO NOT** reuse this pattern to automatically execute Cart/Checkout writes.
- 429 and timeout classification is not automatic retry/backoff: it intentionally leaves user-controlled retry so repeated model calls don't expand spend without consent. Production Retry-After, bounded exponential backoff and circuit breaking require subsequent work.

## Follow-up session-loss QA (2026-10-17 KST)

**Code CI PASS**: [run #38936920334](https://github.com/hongbinwee/codyssey_final-mission-main/actions/runs/38936920334), `feature/brain-core` commit `0c29c315`. Real disposable PostgreSQL tests **8/8 PASS**, including two newly gated lock-loss scenarios. Existing unit/typecheck/build/authenticated HTTP/Mock RAG/Chromium gates also passed. Historical Commerce tests remain separately non-gating; this does NOT prove production LLM/RAG behavior.

### Defect demonstrated and minimal hardening
1. `tests/brain-db/brain-lock-loss.test.mjs` kills the reserved advisory-lock backend with `pg_terminate_backend`. A different worker then acquires the same conversation lock: session locks alone do **not** fence a still-running Node worker.
2. An initial attempt to query the terminated `postgres.js` reserved connection crashed in the driver with `TypeError: Cannot read properties of null (reading 'write')`. That failed CI run is a genuine observed test failure, not an operating guarantee.
3. `src/brain/turn-lock.ts` now checks for the original backend PID's granted advisory lock using a **separate AI-only observer pool**. It never intentionally probes the dead reserved socket after detecting owner loss. `runtime.ts` uses distinct lock-reservation and observer/store pools to avoid pool exhaustion deadlock.
4. `src/brain/graph.ts` verifies lease ownership after each graph node's work and after checkpoint operations. In the injected delayed-RAG test, the old worker rejects and the new worker's completed checkpoint remains authoritative. A live lost owner returns a generic safe error; it never becomes a successful answer in this test.
5. `.github/workflows/brain-check.yml` now gates both existing `brain-pg.test.mjs` and new `brain-lock-loss.test.mjs`. The reproduction tests have bounded waits rather than hanging CI indefinitely.

### Remaining explicit NO-GO
- **Not exactly-once**: ownership verification and LangGraph PostgresSaver checkpoint writes are independent operations, leaving a time-of-check/time-of-use race; there is no DB-enforced fencing generation on every checkpoint commit.
- Test currently terminates the *lock backend*, not a Node/OS process or full primary failover. True worker kill, network partition, partial checkpoint commit, action-outcome reconciliation and automated recovery are not comprehensively proven.
- No unattended Cart/Checkout/Cancel writes through the Brain. An approved design must cover transactional action idempotency, fencing against stale checkpoint writers and actual rollback/restart behavior.
- 429/504 error classification remains user-retry only; `Retry-After` policy, circuit breaker and real provider/network hard-timeout tests remain open.
- Full privacy erasure remains **design only**; no full-delete endpoint or destructive production action was added.

## Privacy: deletion scope and proposed full-erasure lifecycle

The current `DELETE /api/brain/preferences/{key}` removes the canonical preference row **only**. It does NOT delete:
1. `shopping_brain.messages.content` (including the preference's original user utterance),
2. `shopping_brain.conversations` and pending `preference_proposals`,
3. LangGraph checkpoint state, checkpoints' incremental writes / blobs, or the server's snapshots,
4. PostgreSQL WAL, replicas, backups and observability logs,
5. data already sent to a remote LLM or RAG service.

**No full-erasure API should be exposed yet.** Any production implementation needs a separately approved retention policy and an auditable deletion procedure:
- Verify the authenticated actor on the server. Use an explicit **full-conversation/account erasure** confirmation distinct from deleting one preference.
- Block new turns and memory writes for the actor (persisted deletion-intent/tombstone, not an in-memory flag) and acquire a shared distributed turn lock before purging.
- Delete all actor-owned checkpoints using the approved `PostgresSaver` deletion API or fully verified checkpoint schema transactions, and delete source message/proposal/preference rows according to tested foreign-key rules. Beware cross-conversation preferences that reference a message to be erased.
- Confirm zero remaining references for actor and conversation, including checkpoint writes/blobs, before confirming live-row deletion.
- Document data processors' retention, export and erasure capabilities, backup expiration windows and retry after partial failure. Deletion in the live DB is **not** a guarantee of immediate erasure from backups.
- Never copy synthetic product data, CI fixtures or evaluation goldsets into production for erasure tests. Test deletion only in disposable AI-only DB with a separate reviewer-approved data lifecycle design.

## Verification matrix

- Full TypeScript check, frontend build and isolated unit tests.
- Isolated real PostgreSQL with **two** concurrently running Brain workers and Checkpointer instances.
- Authenticated HTTP tests, mock RAG preference reversal, real Chromium with RAG 503 / LLM 503 / LLM 429 error + retry.
- Legacy Commerce broad non-gating audit still has protected-fixture/environment failures, and model input accuracy / actual source review quality remain blocked by the absence of independent external data.

Only describe this milestone as PASS once the latest GitHub Actions workflow at the final branch HEAD completes successfully.
