# Hermes V2 hardening — architecture review and implementation plan

Target: `feature/hermes-agent` as of 2026-10-21. V1 remains default; V2 requires `BRAIN_AGENT_ARCH_V2=1` plus the existing Hermes switch. No QA server changes, schema migration, or write-Tool expansion.

## Why
The new Agent controls search/Tool decisions, but follow-up plan operations could unintentionally reset a task; a short product ordinal with pros/cons could trigger fresh RAG search; the post-search fast exit was keyword-driven; and the separately-called explanation LLM lacked the purpose/attribute context already captured in the Shopping Plan.

## Changes and the reasons
1. **Plan consistency** — Same query + accidental `SET` no longer resets a task. `KEEP` cannot claim a new category. An omitted or empty attribute array does not clear explicitly recorded task preferences. Explicit, separately validated `CLEAR` still exists. Numeric budgets and hard constraints keep their earlier server checks.
2. **Scoped product follow-up** — A narrow pros/cons reference ("아까 2번 상품 단점") may use the Agent read Tool path, but only when a matching actor-owned, Commerce-verified displayed snapshot exists and Commerce exposes the review port. Full comparisons and recommendation requests keep the established research/QA paths. The selected product ID must match the observed, displayed set. Keep the original displayed product set after this read.
3. **Data-aware early completion** — Skip the extra post-search Agent decision only for a simple `SHOPPING_SEARCH` with verified ranked candidates, no task-local aspect requests and no other Tool interactions. Review comparison, underspecified/aspect search, and empty results retain the bounded Agent decision loop. The Agent loop still has a 5-Tool limit and a 45s loop budget.
4. **Grounded explanation intent** — The optional explanation-model prompt includes verified task purpose, attribute preferences, sort and price context. Model-generated reasoning remains limited to server-verified fact IDs/review quotes. The deterministic fallback does not present "cheapest" as the recommendation reason unless the user prioritizes price.
5. **Tests** — Add Plan persistence, illegal category transition, evidence-required fast-exit, trusted ordinal review access, and live graph two-turn tests. Maintain existing V1/H1-H6/QA09-QA11 CI.

## Architectural boundaries that are still open
- No successful real-model/DGX RAG/Commerce E2E is claimed by CI. All new Agent behavior is exercised using deterministic provider stubs and isolated DB/UI tests.
- Only a *scoped*, previously-displayed pros/cons lookup is newly sent to the Agent. QA13 cross-product, source-restricted semantic review comparison remains dependent on DGX server-side scoped retrieval support.
- The final explanation may still be a separate LLM invocation when review evidence exists. This is deliberately retained to enforce strict evidence selection; there is not yet a single LLM producing every free-form final answer.
- Agent review Tool observations are summarized in verified read responses, not automatically converted into new catalog ranking facet scores. An evidence-specific integration design remains needed.
- V2 routing still has explicit fast paths and a regex-assisted guard. A broader multi-intent router change requires a labeled connected E2E benchmark, not untested removal of QA behavior.
- `Full unit regression` is currently a diagnostic CI step with `continue-on-error`; look at the actual step outcome, not only the overall workflow state.

## Acceptance / rollout
- Typecheck, build, targeted Hermes/QA test, real isolated PostgreSQL and UI tests pass.
- New same-query follow-up retains hard and soft constraints and displayed scope.
- Explicit product ordinal with drawbacks reads the observed product via Commerce review Tool, without whole-catalog RAG.
- No changed behavior when V2 is disabled.
- Leave QA deployment, live-Claude nested function schema, review tool/RAG performance, p50/p95 and multi-turn user QA to Phase 5; don't enable V2 on the existing QA server without approval.
- To roll back in an approved candidate process, unset `BRAIN_AGENT_ARCH_V2` and use V1; do not delete DB, checkpoints or receipts.
