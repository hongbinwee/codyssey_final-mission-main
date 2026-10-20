# Hermes Shopping Brain — 실행 계획 및 검증 기준

## 목표
특정 8개 문장을 외우는 챗봇이 아니라, 범용적인 쇼핑 Tool + 상황별 Skills + LangGraph 상태 관리 + LLM의 결과 기반 다음 행동 선택을 결합하는 에이전트. 기존 LangGraph checkpoint/fencing, Commerce 검증, RAG 근거와 사용자 승인·모의 구매 경로는 보존한다.

개발 브랜치: `feature/hermes-agent`만. `main`과 `feature/brain-core`는 변경하지 않으며 QA 서버 재시작·배포는 별도 승인 필요.

## 현재 구현 (H1 1차)
- `src/brain/wishlist-task.ts`: 찜 목록 조회 요청과 순서 선택을 판별하는 고신뢰 단축 경로.
- LangGraph `wishlist` 노드: 세션 사용자만의 찜 목록을 다시 읽어 선택 대상을 검증하고, 외부 RAG/설명 모델 호출 없이 응답.
- `src/brain/runtime.ts`: 기존 `getWishlist`를 인증된 actor로 조회 (read-only), Hermes가 비활성화되면 도구 미노출.
- `src/brain/hermes-tools.ts`: 기존 구매 이력·상품 검색과 함께 읽기 전용 `get_wishlist` Tool을 등록.
- `BrainPreview`: 찜 목록과 상품 상세 이동 UI. 주문·장바구니 직접 변경 없음.
- 단위 테스트는 `tests/unit/brain-wishlist-task.test.ts`에 추가. 실행 결과는 별도 확인 필요.

**제약**: 찜 기반 리뷰 조건 비교, 장바구니 변경, 결제 실행, 배송·취소는 이 단계에서 구현하지 않음. 찜 목록의 금액은 활성 옵션 최저가이며 배송비 포함 최종 결제액은 아님. 기존 쇼핑 경로의 강제 재검색·동적 재판단은 차기 핵심 작업.

## 후속 마일스톤
| 단계 | 작업 | 검증 |
| --- | --- | --- |
| H2 | 유효한 `taskType`, 대상 ID, 최근 표시 순서, 조건·중단/재개를 갖춘 상태 모델. 계획/상품 근거와 단순 인터뷰 분리 | 찜·추천·주문 간 의도 전환, “상관없어”, “그중 두 번째”, stale checkpoint |
| H3 | `get_cart`, `get_product_detail`, `get_reviews`, `get_orders` 읽기 도구를 기존 세션·Commerce/RAG에 연결 | 본인 데이터만 조회, 없는 리뷰·가격·재고 추정 금지 |
| H4 | Tool 호출 → 결과 확인 → 필요 Tool 재선택/추가 질문/종료를 LangGraph에서 결정. 단순 요청 Fast Path 보존 | 동일 문장뿐 아니라 우회 표현·비정형 도구 결과에도 올바른 Tool 선택 |
| H5 | 상품·옵션 확인 → UI 사용자 승인 → 기존 장바구니·모의 구매 및 취소 화면 핸드오프 | AI의 단독 결제·취소·찜 변경 없음, 멱등·충돌·승인 처리 |
| H6 | 실제 DB/브라우저/LLM 통합 평가, p50/p95, tool-choice precision, 재시도/중단·멀티테넌트 QA | 기능 회귀, 후속 대화 근거, 지연·비용과 장애 복구 수치 |

## 우선 회귀 시나리오
1. “내가 찜했던 상품 사고 싶어” → 본인 찜 조회, 상품 종류·예산 질문이나 신규 검색 없음
2. “그중 두 번째 상품 살게” → 이전 목록 순서로 대상을 찾고 최신 찜 상태 재검증
3. 다른 계정 / 찜 해제 직후 / 비활성 상품 → 다른 사용자 상품이나 이전 상태로 구매 시작 금지
4. “상관없어요” → 현재 찜 작업 유지
5. “전에 구매한 이어폰보다 싸고 리뷰 많은 거” → 구매 이력 뒤 상품·전체 리뷰 수 검증
6. “장시간 착용하기 편한 건?” → 리뷰 근거 조회 후 재판단
7. “두 번째 장바구니 담아줘” → 옵션 검증 + 사용자 승인된 변경 경로
8. “내 배송 확인해 줘 / 취소해 줘” → 본인 주문 읽기 및 취소 확인 UI

## 검증
`npm run check`, `npm run build`, `node --test tests/unit/brain-wishlist-task.test.ts tests/unit/brain-hermes-loop.test.ts`, Brain API/graph 회귀, 실 DB actor-isolation 및 브라우저 E2E를 실행해야 한다.
미실행은 PASS로 표시하지 않는다. 배포 여부도 별도로 기록한다.

## H1 local isolated verification — 2026-10-20

Scope: exact committed blobs `wishlist-task.ts`, `hermes-tools.ts`, `dataset-state.ts` and their three test files; Git blob SHA verified against the branch. This was **not** an entire-repository checkout: the sandbox cannot resolve github.com or install this repository's dependencies. The test harness uses the real `skills.ts`, a lightweight SHOPPING_POLICY stand-in, and narrow type declarations for type-only imports.

```sh
node --experimental-strip-types --test \
  tests/unit/brain-wishlist-task.test.ts \
  tests/unit/brain-hermes-loop.test.ts \
  tests/unit/brain-dataset-state.test.ts
# 11 tests, 11 pass, 0 fail (isolated sandbox)
tsc -p tsconfig.json
# PASS (isolated typecheck with stand-in dependency declarations)
```

Bugs discovered and fixed while executing the tests:
- `두 번째 상품 살게` failed ordinal purchase recognition; token patterns updated and verified.
- Compound wishlist review/price comparisons were intercepted as list-only requests; fast-path now leaves them to planner/Tool selection.
- Partial dispatch of a multi-tool model response could create an inconsistent transcript; whole unhandled batch is rejected.
- Model-owned reference now returns bounded actor-owned wishlist observations for subsequent reasoning.
- Dataset change invalidates previously displayed wishlist snapshot.
- Wishlist route is enabled only when the actor-owned read tool is actually configured.

**NOT_RUN:** full repository Typecheck/Build, full unit suite, existing CI at new HEAD, real database actor isolation, actual LLM/RAG tests, browser E2E and QA-server deployment. A mocked provider conditioned its second Tool choice on actual first Tool output; this validates the loop contract, *not* real model Tool-choice accuracy.

Next priority: **H2/H3/H4** — first-class shopping Task State, additional bounded read Tools (cart/product/reviews/orders), and genuine LangGraph choose→execute→observe→replan control. The current `deep` graph can still perform mandatory retrieval; the wishlist task fast path alone does not make the whole application autonomous.

## H2 – Scoped, versioned Task State (2026-10-20)

### Implementation
- `src/brain/task-state.ts` is the canonical server-side bounded task contract: `schemaVersion=1`, `actorUserId`, `conversationId`, `datasetVersion`, `kind` (WISHLIST / DISCOVERY / REVIEW_COMPARE / ORDER), `phase` (ACTIVE / AWAITING_INPUT / UNAVAILABLE), `revision`, bounded ordered `displayedProductIds`, optional `selectedProductId` and `pendingQuestion`.
- `ownedTask` validates provenance and structure; a mismatched actor, conversation, dataset, duplicate/oversized product ID array, unavailable selection or malformed state does not qualify as current context. The existing Graph actor/session authorization and fencing remain the access-control authority.
- `nextTask` creates a fresh revision on task transition, removes previous selected IDs and unanswered question keys, and cannot insert a selected product not present in the verified displayed list. The task state is **not** an authorization token and cannot perform orders, purchases or cart mutations.
- `src/brain/graph.ts` routes via the scoped task, persists `taskState` in the server canonical `ResearchResult`, retains it through social interruptions, resets it on new recommendations/review comparisons/order requests, mirrors interview pending questions, and invalidates references on retrieval failure. Explicit "처음부터 시작" resets current Shopping Plan and Task State together but leaves long-term preferences and order data unchanged.
- Wishlist selection no longer depends on the immediately previous `agentUi`: the prior displayed IDs come from the scoped task, while the selected product is **re-read from the current actor's wishlist**. The current bounded view must still contain that selected product.
- `src/brain/dataset-state.ts` invalidates both `agentUi` and `taskState` on dataset changes. Public Brain turn/history responses do not expose the internal task-owner identity.
- H2 adds no DB migration or new framework. Persistent canonical results already pass through the existing fenced LangGraph/turn-receipt checkpoint path.

### Verification (isolated)
The **exact committed Git blobs** for `task-state.ts`, `wishlist-task.ts`, `dataset-state.ts` and their unit-test files were copied to an isolated Node environment; matching Git blob hashes were checked. Executed:
```sh
node --experimental-strip-types --test \
  tests/unit/brain-task-state.test.ts \
  tests/unit/brain-task-multiturn.test.ts \
  tests/unit/brain-wishlist-task.test.ts \
  tests/unit/brain-dataset-state.test.ts
# 18/18 PASS
tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext \
  --allowImportingTsExtensions src/brain/task-state.ts src/brain/wishlist-task.ts
# PASS
```

**NOT_RUN:** full repository `npm run check` / `npm run build`; LangGraph+Postgres checkpoint/fencing integration; real authenticated HTTP/Browser E2E; live LLM Tool-choice accuracy; other regression suites. The execution sandbox cannot resolve the public GitHub host or install the full repository, so a passing isolated TS check does **not** prove the integrated graph compiles. Codex in an existing full checkout should run these before deployment.

### Next: H3, then H4
H2 provides safe task identity and continuity; it does **not** implement autonomous replanning. H3 must expose a small set of actor-owned cart/product/review/order read Tools. H4 must remove mandatory searches from non-search requests and actually use Tool observations to decide the next permitted Tool, ask a question, or finish. Never replace this with eight hard-coded dialog scripts.

## H3 — Reusable read-only Shopping Tools (2026-10-20)

Implementation: `src/brain/hermes-read-ports.ts`, `src/brain/hermes-tools.ts`, `src/brain/read-flow.ts`, `src/brain/graph.ts`, `src/brain/runtime.ts`.

- H3 adds six bounded read capabilities: `get_cart`, `get_product_detail`, `get_product_reviews`, `get_orders`, `get_order`, `get_shipping_status`. Together with `get_purchase_history`, `get_wishlist`, `search_products`, there are nine registered names, **conditionally exposed** according to the available tool ports.
- `get_cart` intentionally uses `SELECT` on an existing actor-owned cart followed by the existing read-only `cartView`. **Do not** use the ordinary `getCart` here: it creates a cart with `INSERT` on an empty account.
- Product facts (current variants, price, shipping, stock availability) come from Commerce. Review reads return up to five excerpts with rating and `REAL`/`SYNTHETIC` provenance; a review-filter query is not a claim about the full review population.
- Orders are scoped by authenticated session actor in the underlying Commerce services. H3 sends only bounded order/status/amount/item summaries to the model, never address snapshots or payment details.
- Owned-cart/orders tools are enabled only when `qaCommerceActivityAllowed` confirms an explicitly matching QA Commerce DB + catalog identity. Product/review reads use the configured catalog. No model-chosen actor/user IDs.
- Product detail/review tool arguments must refer to product IDs observed in an earlier tool response. Order detail/shipping IDs must first appear in the authenticated `get_orders` result. Strict JSON argument schemas, unknown field rejection, no parallel partial dispatch, distinct-call tracking, at most five read Tool calls and a bounded decision deadline are enforced.
- The Tool Loop exposes observed results to the LLM for selection of the **next** enabled read Tool; it never accepts its final free text as canonical product rankings, factual order results, or permission to mutate state.

### Real CI execution

The dedicated branch-only `.github/workflows/hermes-h3-check.yml` executed the committed repository, installed dependencies with `npm ci`, then ran `npm run check`, `npm run build`, and the H1/H2/H3 unit-test selection.

**PASS: Typecheck, Build, 31/31 unit tests**, run `39348239920` at commit `92218dca34f005a9adc9bcdc2afe6e56ca29f537`. CI record: https://github.com/hongbinwee/codyssey_final-mission-main/actions/runs/39348239920

Tests exercise cart no-create/no-write, actor-gated read ports, product/review facts, redaction of sensitive order fields, two-step Tool-result-conditioned selection, unknown IDs, unexpected JSON arguments, and order→shipping lookup sequences.

**Still NOT_RUN:** real connected Commerce DB/API actor-isolation, browser E2E, live LLM/RAG quality and latency measurement, full unit suite beyond this named selection, QA server deployment.

### Important H3/H4 boundary

H3 **exposes the reusable read tools to the existing deep Hermes loop**. It does not yet reroute standalone user messages such as "내 주문 보여줘" away from the existing CS static response. Nor does it remove the `graph.ts` deep recommendation path's mandatory retrieval or replace current recommendation explanation logic. Those are **H4 dynamic action-policy/replanning** work, not evidence that H3 enables every multi-step user workflow. Keep scenario examples as evaluation cases, never hard-code eight conversational scripts.
