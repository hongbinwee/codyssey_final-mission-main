# Hermes V2: Agent-first semantic entrypoint

Target: `feature/hermes-agent`, gated by `BRAIN_AGENT_ARCH_V2=1` **and** `HERMES_AGENT_ENABLED=1`; legacy V1 unchanged by default.

## Goal and change
The former V2 first ran `guardBrainMessage` / `routeBrainMessage` and only entered Hermes for certain recognized requests. This caused ordinary variants (e.g. `넌 뭘할수있어?`) to receive a fixed product-clarification phrase without reaching the Agent. A Tool-calling Agent cannot understand a mixed request if an upstream regex cuts it off.

With V2 enabled, the Graph `route` node provides a **neutral execution permission**, not a semantic class, and immediately enters the same Agent decision loop for all ordinary user turns. The model selects:
- `respond_to_user` or a bounded text response (non-Tool action);
- `ask_user` (one explicit clarification);
- any enabled **read-only** Commerce/RAG Tool, with strict server-side argument/ID/actor/Shopping Plan validation.

The current Shopping Plan, verified displayed-product snapshot, bounded conversation history, and per-turn Tool Call/Result transcript remain the Agent context. Real prices, order facts, reviews, and Tool observations are not made authoritative by model prose. When the Agent did a Commerce read, the server retains verified summaries rather than treating free-form model assertions as facts.

## Non-negotiable boundaries
- No model-selected writes, order cancellation, checkout, cart mutation, arbitrary DB access or authentication bypass.
- `RAG` product candidates are Commerce revalidated. `get_product_detail` and `get_product_reviews` must target a verified prior displayed/observed product ID.
- `get_order` and `get_shipping_status` must target orders returned by the current authenticated user's Tool read.
- `V1` rules, Decisions router and pre-existing QA paths stay unchanged when the opt-in flag is off.
- User messages/previous Tool results are data, not instructions overriding server policy.

## Validation
Targeted mock Graph E2E must demonstrate:
1. `넌 뭘할수있어?` goes to the LLM and receives a natural capability reply; 0 regex router calls, 0 RAG, 0 legacy Planner calls.
2. `안녕! 내가 찜한 상품도 보여줄래?` reaches `get_wishlist` and returns authenticated facts; no greeting route interception.
3. The Agent can ask a question and preserve existing task status across the next social message.
4. Unsupported model-requested write never executes a Commerce Tool.
5. Existing V1/H1-H6/QA09-QA11, Commerce auth/isolation, Typecheck/Build and isolated PostgreSQL tests still pass.

## Limitations and release gate
- An Agent-first architecture does NOT mean every human response can safely be taken verbatim after a Tool read. Read results remain server-grounded. Natural explanatory composition over multi-Tool results remains a separate quality goal.
- This does NOT certify actual Claude function schema adherence, RAG V4 search relevance, QA13 scoped semantic-review search, response latency or p95.
- Do not enable on the existing QA server or deploy publicly without explicit approval and connected V1/V2 comparison.
