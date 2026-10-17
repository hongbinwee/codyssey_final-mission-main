# Brain v8 — Fencing protocol and failure-injection QA

**Scope:** `feature/brain-core` ONLY. `main`, Commerce DB/migrations, checkout and full-erasure API are out of scope. This is a **design + isolated test milestone**, not a claim of production exactly-once.

## Baseline and why current checks are insufficient

Baseline: v7.1 commit `727c29389fab88e78d5a71333d99f6deb9bf0329`.
`turn-lock.ts` holds a session-scoped advisory lock and checks its owner from an independent DB connection. `graph.ts` checks after nodes. If session A disappears **after** a successful check and **before** PostgresSaver's write on its unrelated database connection, the stale write can still commit. Its success acknowledgment and external provider call are likewise not atomic with Postgres.

LangGraph PostgresSaver may write separate checkpoints, blob channels and intermediate task writes. A process crash can therefore leave **partial progress** but not a completed user action. Restore from the most recent **fully validated** state; a raw latest checkpoint is not automatically an application-level completed result.

## Complete fencing contract (design; NO-GO until implemented and independently reviewed)

1. **Single authority:** AI-only Postgres `shopping_brain.turn_ownership` keyed by `conversation_id`. Columns: `generation BIGINT NOT NULL` (monotonic, never reused), `holder_id UUID`, `status` (RUNNING / COMMITTED / RECOVERY_REQUIRED), `client_action_id`, `input_digest`, `updated_at`. A `turn_receipts` table has unique `(conversation_id, client_action_id)` and a stable request digest, `PENDING/COMPLETED/UNKNOWN`, and committed result pointer.
2. **Claim/reclaim:** Under a row lock, check authenticated ownership + action ID/digest; return prior COMPLETED receipt if identical; reject same ID/different digest; if an old holder is certified dead, increment `generation` and install a new holder in a single transaction. A timeout alone is *not* evidence that the prior external side effect did not happen.
3. **Atomic fenced write:** Every **authoritative** checkpoint commit, incremental write, blob mutation, receipt/status change and canonical result-pointer update must execute in a transaction that locks `turn_ownership`, checks `generation = supplied_generation AND holder_id = supplied_holder` and only then writes. Reject stale writers without touching canonical state. A separate `assertHeld()` SELECT prior to an unguarded PostgresSaver `put()/putWrites()` is **not fencing**.
4. **Saver integration gate:** Inspect pinned JS `@langchain/langgraph-checkpoint-postgres@1.1.0` semantics (especially `put`, `putWrites`, writes/blobs and connections). The current `PostgresSaver.fromConnString()` owns independent connections. Do **not** claim transaction-level fencing without an audited adapter/saver change that puts both generation validation and actual mutation on the **same** transaction/connection. Avoid generic client-side callback wrappers with a time-of-check/time-of-use gap. Alternately, allocate physically isolated per-generation checkpoint threads and *only publish* a canonical generation pointer in an atomic fenced transaction, while proving deterministic previous-state transfer, resume and cleanup.
5. **Commit boundary:** Only a validated final `respond` output, evidence IDs, request digest and fully persisted checkpoint graph can atomically transition `PENDING → COMPLETED` and publish the canonical pointer. On unknown network acknowledgment, read the receipt from a new connection; never assume no work happened.
6. **Stale worker:** Node process crash releases its advisory lock; generation remains stored. An old worker that resumes, or an old asynchronous provider response, cannot commit or change the canonical pointer using generation N after ownership has advanced to N+1. Fail closed and don't send success.
7. **Side effects:** A DB fence does **not** provide exactly-once execution of a remote LLM/RAG call. For future Commerce Cart/Checkout/Cancel, separate user authorization, Commerce-level idempotency key, authoritative outcome reconciliation and its own transactional guards are mandatory. Keep Brain read-only until approved.
8. **Privacy:** Full erasure requires tombstoning new claims/writes, erasing all generations/checkpoint blobs/writes/receipts and addressing backup/processor retention. No full-erasure endpoint in this milestone.

### Minimal SQL transaction sketch (conceptual, not installed migration)

```sql
BEGIN;
SELECT generation, holder_id FROM shopping_brain.turn_ownership
 WHERE conversation_id = $1 FOR UPDATE;
-- compare generation and holder to the caller's verified claim;
-- on mismatch ROLLBACK, surface STALE_TURN;
-- the next statements must be inside THIS VERY transaction:
-- write checkpoint/blob/intermediate-write, or publish canonical pointer;
UPDATE shopping_brain.turn_ownership SET updated_at = now()
 WHERE conversation_id = $1 AND generation = $2 AND holder_id = $3;
COMMIT;
```

The **illustrative** `UPDATE` by itself is insufficient: the check AND protected writes must share the transaction, and eligibility must also include closed/erasure status.

### Failure/quality gate matrix

| Test | Must prove | Completion |
|---|---|---|
| Forced `SIGKILL` of real child Node worker during blocked RAG | OS reclaims old lock; replacement survives; no stale final reply; single source message/action | PASS (isolated QA) |
| Checkpoint saved but acknowledgment lost / injected saver failure | prior completed task state preserved, retry doesn't double-update budget, message idempotency | PASS (isolated QA) |
| SQL generation-CAS isolated experiment | old generation cannot commit after takeover; stale writes rolled back | PASS (isolated QA) |
| 429 model response with `Retry-After` | 429 without internal disclosure; no silent model retry; same action retry recovers | PASS (isolated QA) |
| True model hard timeout / aborted signal | one bounded failed request, no fabricated recommendation, retry preserves state | PASS (isolated QA) |
| Full typecheck/unit/Postgres/HTTP/Chromium | PASS/FAIL per layer; no Commerce test waiver expansion | PASS (isolated QA) |

## Executed evidence (2026-10-17 KST)

- **CI run [#38939959830](https://github.com/hongbinwee/codyssey_final-mission-main/actions/runs/38939959830)**, tested commit `1cadb0d6`: SUCCESS. Typecheck, full frontend build, Brain unit/isolated contracts, `brain_ci` PostgreSQL **13/13 PASS**, authenticated HTTP/Mock RAG and Chromium E2E passed.
- `tests/brain-db/brain-worker-kill.test.mjs` + `fixtures/held-brain-worker.mjs`: a real Node child executes graph prepare→plan, waits mid-RAG, is terminated with SIGKILL, and a separate graph recovers the partial persisted state. Source user message remains unique, plan revision is one and there is no earlier completed answer. **Not** a network partition, multi-region failover or full replay-order proof.
- `tests/brain-db/brain-checkpoint-failure.test.mjs`: a proxy injects a lost acknowledgment **after** a PostgresSaver `put()` returns a committed checkpoint write; API shows 503 instead of a fake success; recreating saver + same action recovers and does not duplicate the message or plan revision. Does not emulate on-disk corruption or an arbitrary partial SQL transaction.
- `tests/brain-db/brain-fencing-prototype.test.mjs`: CI-only guard `/brain_ci`; validates transactional generation compare-and-swap rejects the stale holder and accepts the new one. **This is not plugged into production LangGraph checkpoint I/O.**
- `tests/brain-db/brain-model-recovery.test.mjs`: both 429 and model timeout failures return safe API errors. After Checkpointer restart, explicit same-action retry carries 500,000 KRW previous state, applies 300,000 KRW update exactly once, preserves single source message and completed replay without extra RAG.
- `tests/unit/brain-network-failure.test.ts`: mocked Responses transport produces actual HTTP 429 with `Retry-After: 120` and a pending fetch aborted by `AbortSignal`; failures cause zero hidden retries and explicit retries can succeed. **Retry-After is not currently parsed or honored by a scheduled/backoff retry policy.**
- No real LLM provider, external team Hybrid RAG, production deployment, multi-region concurrency, Commerce writes or destructive erasure were exercised.
- The separate legacy Commerce broad audit remains **non-gating**, with known protected fixture/environment failures. A green Brain workflow does not mean all Commerce tests passed.

**Shipping gate:** Formal exactly-once and automatic Commerce Tool writes are **BLOCKED** until transactional fencing (or provably isolated canonical publishing) and real multi-instance/failover tests PASS. This test milestone does not remove that gate.
