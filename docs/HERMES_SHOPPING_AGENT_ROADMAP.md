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
