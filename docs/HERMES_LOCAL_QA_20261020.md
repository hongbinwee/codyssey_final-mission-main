# Hermes local integration QA — 2026-10-20

Merged Brain Core d57f811 into Hermes 4ceb00e (merge 64ef0bd), then integrated the newer Brain Core 01d7d84, using a dedicated worktree and local port. Existing QA servers, tunnel, original worktree, accounts, sessions and Brain storage were preserved. HERMES_QA_ENABLED=1 and HERMES_AGENT_ENABLED=1; optional HERMES_DEEP_MODEL unset.

## Corrections

- Reuse preloaded QA snapshots only when canonical source identity and product details match. Preserve local stock reductions and compare option values independently of JSON key order.
- Resolve model category disagreement from authenticated purchase context only for the same product type; persist the effective shopping plan.
- Match the simulated-purchase notice to explicit checkout capability.
- Add an explicitly approved, local-only minimum permission script for the existing isolated QA Commerce role. No DGX permission changes.

## Verification

- Typecheck and frontend build PASS.
- Core regression suite: 164 PASS, 0 FAIL. Includes checkout atomicity/idempotency/tenant boundaries, read-only external catalog, Hermes unsafe-tool rejection, purchase actor scoping, price/review filters, timeout fallback, latest Core conversation/interview/retrieval-failure behavior on both Hermes and Fast paths, snapshot collisions and stock preservation.
- Actual headless browser flow PASS: existing QA login -> DGX product -> cart -> selected-item quote -> explicit simulated payment button -> completion -> order detail/list.
- Local DB confirmed SIMULATED/PAID payment, CONFIRMED order, PREPARING shipment and local stock decrement. No order was created before explicit confirmation.
- Actual Decisions, default Claude Tool Calling and DGX RAG purchase comparison PASS: two verified alternatives satisfied lower-price and greater-review-count conditions relative to the authenticated purchase.
- Final generated explanation timed out after 20 seconds. Verified-candidate fallback returned the alternatives with MODEL_TIMEOUT. Rich generated review explanation is not verified by that run.
- Existing TLS/read-only DGX connection and SELECT-only SQL guard remain in effect. Catalog projection, inventory, order and payment writes use the isolated local pool. Mock checkout has no payment-provider request. Outbound HTTP remains restricted to existing DGX RAG, Decisions and Claude endpoints.
- Alternate Deep model was not configured or tested.

Account-specific evidence remains in ignored local QA files and is excluded from this report.
