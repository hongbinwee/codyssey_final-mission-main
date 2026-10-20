# Hermes H5 — verified shopping action handoffs (2026-10-20)

Development: `feature/hermes-agent`. No modification of `main`, `feature/brain-core`, external QA deployment or restart.

## Goal and security boundary
H5 does NOT allow the language model to purchase, cancel, select an unavailable variant, update a cart, or create checkout confirmation. It allows the Agent to propose **server-validated screen navigation only**. Existing Commerce UI is the only actor that accepts the user's selected option/quantity and explicit confirmation, and Commerce re-checks current variants, stock, quote, cancellation eligibility and idempotency before mutation.

## Implemented
- `src/brain/shopping-handoff.ts` produces typed `ShoppingHandoff[]` with fixed labels and no model-written URLs or action payloads:
  - `PRODUCT_DETAIL(productId, optional validated variantId)`: from Commerce-verified, finally displayed recommendation candidates; verified active/available wishlist selection; or current actor-owned wishlist / product-detail read observations.
  - `CART_REVIEW`: only when a server read returned cart facts.
  - `CHECKOUT_REVIEW`: only if the current cart observation has items and `canCheckout=true`. This routes to the **quote page**; it is NOT a charge, payment or checkout confirmation.
  - `ORDER_LIST`: authenticated order read or explicit cancellation UI handoff when the user's existing Commerce-orders port is available.
  - `ORDER_DETAIL(orderId)`: only for an ID from authenticated order/shipping-read output; the screen fetches current order status and its cancel eligibility separately.
- The H5 action descriptor is derived **after** grounded response selection in `graph.ts`, is persisted as optional `shoppingHandoffs` in the canonical turn, and is exposed as optional `shopping_handoffs` in the Brain response/history.
- When dataset version changes, both old ranking and `shoppingHandoffs` are cleared.
- `BrainPreview` renders navigation controls, suppresses duplicate product buttons where ranked cards or wishlist already show details, disables Checkout Review if actual catalog context does not enable checkout, and disables inactive/unpriced wishlist product buttons.
- `AgentPanel` passes navigation callbacks to the Brain in the shopping experience; legacy prop callers remain supported. `app.tsx` opens the existing Product, Cart, Checkout, Orders, OrderDetail screens and closes the Agent panel. No extra mutation API was introduced.
- "두 번째 찜 상품 장바구니에 담아줘" selects the **reverified second product** and directs the user to its detail/options first; no automatic cart write.
- Cancel requests still require navigation to the order screen and the existing `CancelSheet` eligibility, quote, reconfirmation and final user consent; an Agent cannot call its execute endpoint.

## Verification
[GitHub Actions run 39354074203](https://github.com/hongbinwee/codyssey_final-mission-main/actions/runs/39354074203), commit `73384f1e7d9ecebc4a0df8bc9bd2bc4cf5e60e36`:
- `npm ci`, `npm run check`, `npm run build` — PASS.
- Gated H1–H5 regression tests — **94/94 PASS**. Includes direct handoff contract tests (verified/final-ranked product, wishlist, sold-out, empty/noncheckout cart, observed orders, no change actions, stale dataset) and **actual MemorySaver LangGraph tests** for cart→quote handoff, wishlist ordinal→Product, guarded order cancellation→Orders, verified recommendation→Product.
- Diagnostic full `npm run test:unit` — **1,010 total, 965 pass, 44 fail, 1 skipped**. It is intentionally nonblocking and should NEVER be presented as passing; failures include unavailable historical QA snapshots/backups and live test credentials, and some older expectations. These require separate fixture inventory and baseline reconciliation, not invented fixtures.
- NOT_RUN: authenticated real Commerce DB integration under the chosen QA catalog, actual user click-through with browser E2E, playwright on the target deployment, human final checkout/cancel confirmation, live model Tool selection latency, all prior regression suites passing without environment fixtures.

## H5 acceptance walkthrough (real QA next)
1. "내가 찜했던 것 중 두 번째 장바구니에 담아줘" after a wishlist list → Product detail of exactly the second currently saved, sellable product; user chooses variant/qty and explicitly presses add; Commerce server revalidates version.
2. "내 장바구니 확인해 줘" → Cart Review; only an actually purchasable current cart offers Checkout Review. Opening the quote page never executes checkout automatically.
3. "내 주문 배송 상태 확인해 줘" → actor-owned order detail navigation. Stale/foreign orders never get access through the UI.
4. "이 주문 취소해줘" → Orders; user chooses own order and CancelSheet handles the eligible quote and separate confirmation; AI performs zero cancellation writes.
5. "상품 추천" → only Commerce-verified and actually displayed recommendation cards are linked, not unshown candidates or RAG references.
6. Re-login as another actor, rotate dataset or modify stock while an old conversation is open → every screen uses its own authenticated fresh read, no write authority from a chat snapshot.

## Next
H6 should execute actual model, RAG, Commerce and browser evaluation; record Tool choice precision, unnecessary-RAG percentage, task completion, p50/p95 latency, stale references, concurrency fencing, authenticated tenant isolation and checkout/cancel re-confirmation before any QA deployment.
