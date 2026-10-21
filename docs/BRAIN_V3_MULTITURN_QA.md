# Brain v3 — multi-turn Shopping Plan, context assembly and evidence-bound response

**Branch**: `feature/brain-core` only. **Do not merge to main** without explicit authorization.
**Design principle**: Commerce First, AI as an Extension.

## Architecture delivered in this milestone

Four distinct PostgreSQL-checkpointed LangGraph stages:

```text
Authenticated HTTP session
  → prepare (verify conversation ownership, idempotent source message, load actor-only confirmed Memory)
  → plan (LLM via existing Responses Provider + typed plan update; preserve old constraints)
  → retrieve (existing RAG adapter or honest Commerce reference-only fallback;
              Commerce confirms latest product/variant price, availability, stock)
  → respond (deterministic source-ID-bounded Korean explanation, no free-form speculative claims)
  → existing React BrainPreview (shopping_plan + explanation + ranked/reference-only/rejected)
```

- Stored per-thread task-local `shoppingPlan` includes `query`, `maxTotalWon`, `requiredConditions`, `currentPreferences`, `revision`.
- Saved long-term `user_preferences` is a **separate canonical table**; it is reloaded for each turn and never overwritten by the short-term task plan.
- Explicit budget operations `KEEP/SET/CLEAR`, requirement operations `KEEP/ADD/REPLACE/CLEAR`, query operations `KEEP/SET` and preference merge/clear are parsed from a strict tool-free JSON intent response. A new category task with query SET must decide the budget explicitly; no silent inherited budget.
- Older single-turn intent responses without operation modes remain valid. If a follow-up omits budget, the previous budget is retained; context revision increases on each new turn.
- **Current explicit user preference wins over confirmed long-term preference**, with unchanged ranking-eligibility G2 requirements (rating >3.5/5 and verified source-wide review count >=10).
- Existing test and production API shapes are backward-compatible (new `shopping_plan` and `explanation` keys are optional for old mock implementations).
- A repeated latest `client_action_id` + same user message reuses the prior checkpoint result; conflicting message is rejected, without Commerce writes. Older non-latest replay and multi-process concurrency are not yet solved for production.
- System policy and built-in Shopping Skill texts are fixed in code. Previous plan, confirmed Memory and the latest message are bundled as **user-level untrusted context**. Dynamic user strings cannot become system/Skill instructions.
- Built-in initial procedures: monitor, audio and general; this is NOT arbitrary procedural self-editing or a full Hermes Skills subsystem.
- `buildGroundedExplanation` only reports verified Commerce item name/price, upstream normalized Aspect scores and matching source IDs. Review meaning/benefit is **not validated from raw review excerpts**, so no unsolicited claims about physical comfort, lifetime or performance are made. No additional LLM narrator call or Tool side effects.

## CI validation scope

- Static `npm ci`, complete TypeScript check, frontend build and isolated Brain unit tests.
- Disposable `brain_ci` PostgreSQL for preference confirmation, owner isolation, Graph Plan checkpoint restart, carryover budget/specs, explicit reset and duplicate latest-action replay.
- HTTP integration: temporary mock Commerce DB, local Responses mock and local RAG mock prove authenticated sessions, Memory-driven ranking reversal, provenance fail-closed and zero Cart writes.
- Historical Commerce tests dependent on protected dumps are visible as non-gating audit; **do not claim all legacy Commerce suites passed**.
- Always check the latest GitHub Actions for PASS before reporting implementation complete.

## What remains deliberately outside the claim of completion

- Real Amazon/RAG service and independently audited review-total provenance; current test products are CI-only fixtures.
- Real external model latency, recommendation quality and review-level semantic grounding (including whether Aspect scores are calibrated).
- Full real-browser Playwright E2E, cloud deployment, 5+ user feedback and privacy retention/deletion hardening.
- Agent Cart/Order writes are still disabled in the new Brain; existing Commerce business rules remain canonical.
- Advanced Hermes features (session semantic search, autonomous Skill authoring, learning/continuous memory improvements) are future phases.

## Reviewer checklist

1. Verify `src/brain/graph.ts` only accesses actor-owned checkpoints and all phases preserve read-only Commerce behavior.
2. Verify `src/brain/shopping-plan.ts` semantics: KEEP must not clear historical hard requirements; explicit CLEAR must work; new category must not inherit stale criteria.
3. Verify `src/brain/intent.ts` + `context.ts`: no user/provider Memory or RAG text in system instructions.
4. Verify `src/brain/grounded-response.ts`: no unsupported review or physical-performance claims; every displayed evidence ID matches the same product/variant.
5. Verify `src/brain/personalization.ts`: synthetic review evidence cannot qualify a ranked candidate.
6. Run feature-branch CI; keep Draft PR and main unchanged.
