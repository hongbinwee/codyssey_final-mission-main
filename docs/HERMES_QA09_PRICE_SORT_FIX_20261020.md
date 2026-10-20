# Hermes QA09 명시 가격순 최종 수정

2026-10-20. 기준 `bf0137faac1533eeef05e41a700a79e33c212522`, 대상 브랜치 `feature/hermes-agent`. 기존 H6 3136 / DB15442 / Cloudflare / 인증·세션은 유지. 서버 전환·실제 Claude/DGX/Commerce E2E는 **NOT_RUN**.

## 원인과 변경

이전 코드는 가격순 요청에서 `reviewSortAspect`만 해제하고 `curateRecommendations`를 다시 적용했다. 따라서 29,000원 장바구니 상품이 19,000원 상품보다 먼저 나왔고 가격순 요청이 무시됐다.

- `src/brain/shopping-plan.ts`: 기존 서버 소유 Task-local ShoppingPlan에 선택적 `priceSortOrder: ASC | DESC` 추가. 장기 Memory/DB 스키마 변경 없음.
- `src/brain/price-sort.ts`: 가격 정렬 요청과 가격 범위/일반 가성비 선호를 구분. 취소된 표현 제외, 가격 대조 표현 처리. Commerce 검증 상품가 + 배송비의 안전 정수 합계만 정렬하며 상품별 옵션 범위 유지·중복 상품 제거. 개인화는 동률의 기존 결정 순서에만 남는다.
- `src/brain/read-flow.ts`: 정렬을 명시하면 개인화/추천 슬롯보다 우선 적용. 새 가격/리뷰 기준은 서로 대체한다. 후속 대화는 유지, 명시 취소는 개인화 복귀. 가격 범위·필수 조건은 그대로 유지하고 새 query/category/인터뷰 상품 전환에서 기존 정렬 승계 차단. 인터뷰가 가격 정렬 문장을 새 상품명으로 저장하지 않도록 경계 보완.
- `src/brain/graph.ts`, `grounded-response.ts`: 가격순은 검증된 순서에 대한 결정적 설명 사용. 검증 합계 및 단조 정렬이 확인된 경우에만 정렬 성공 문구 제공. 후보가 없거나 합계/순서 미확인이면 성공 주장 없음.
- `.github/workflows/hermes-h3-check.yml`: 신규 가격순 회귀를 기존 지정 회귀에 추가.

기존 rankProducts의 예산·필수 조건·가격 검증과 RAG→Commerce의 판매 가능 옵션 검증을 재사용한다. 배송비 null을 0원으로 처리하지 않고 Commerce 미확인·합계 overflow도 가격순 확정 후보에서 제외한다. DGX 요청 계약·DB·실결제·모의 구매 안전장치 변경 없음.

## 합성 입력의 실제 함수/그래프 회귀

신규 `tests/unit/brain-hermes-qa09-price-sort.test.ts`: **19/19 PASS**. 외부 API/DB 없이 실제 resolver/retrieve/rank/grounded response/MemorySaver LangGraph를 실행했다. 실환경 연결 성공으로 합산하지 않는다.

| 사례 | 확인 결과 |
|---|---|
| 19,000 / 29,000원 오름차순 | cheap → expensive-cart, 장바구니·찜 affinity보다 우선 |
| 동일 후보 내림차순 | expensive-cart → cheap |
| 상품가15,000+배송10,000 vs 상품가19,000+배송0 | 합계19,000 → 25,000원 |
| 배송비 미확인·Commerce 미확인·안전정수 overflow | 확정 가격 순위 제외 |
| 예산 초과·필수 조건 미확인 | 기존 hard gate에서 제외 |
| 가격 범위만 지정 | 가격순 신규 설정 없음, 개인화 유지 |
| 리뷰→가격 / 가격→리뷰 | 이전 기준 해제, 새 기준 우선, 기존 리뷰 정렬 정상 |
| 그냥 추천 / 정렬 취소 / 가격순 말고 / 저렴한 순 말고 | 정렬 해제, 개인화 복귀, 범위·필수 조건 유지 |
| 같은 조건 후속 대화 | 체크포인트에서 정렬 방향·예산 유지 |
| 새 query·category·인터뷰 상품 선택 | 이전 정렬 자동 승계 없음 |
| 인터뷰 중 가격 높은 순 요청 | 상품 query 유지, 가격 방향만 변경 |
| 무후보 / 순서 불일치 | 정렬 성공 주장 없음 |
| 동률·다중 옵션 | 안정적 기존 순서, 상품별 하나의 해당 옵션 |

RED 증거: 첫 신규14건 중7 FAIL/7 PASS; 인터뷰 가격순 오인 RED 1건, 취소/새상품 전환 RED 2건을 확인한 뒤 수정했다. 로그는 검증 Worktree `.local-data/price-sort-final/`에 별도 보존.

## 최종 검증

- Typecheck / Build / diff 공백 검사: PASS.
- H1–H6 및 기존 지정 회귀: 112/112 PASS.
- QA09–11 + 신규 가격순 + RAG v4: 96/96 PASS.
- CI 지정 회귀(위에서 RAG v4 23건 제외): 185/185 PASS.
- 전체 로컬 단위: 1,103 total / 1,061 PASS / 41 FAIL / 1 기존 SKIP.
- 기존 41 FAIL은 기존 고정 QA 자료 누락37 / DB 설정 의존3 / mock 모델 설정1이며 실패 source별 수정 전후 비교. 이번 범위에서 아티팩트 생성·키 주입·삭제·SKIP으로 통과시키지 않는다.
- 기존 Linux CI Windows 경로 fixture 실패(v4-import.test.ts:40)는 별도 환경 의존 실패이며 이번 수정 범위 밖. 최종 GitHub CI 결과와 실제 진단 수치는 로컬 전환 계획 및 최종 보고에 기록한다. diagnostic continue-on-error의 workflow 성공을 전체 단위 PASS로 표현하지 않는다.

## 실행 후보 준비

검증 Worktree의 detached HEAD를 원격의 동일 검증 tree 커밋에 연결한다. 다른 Worktree에 붙은 로컬 feature/hermes-agent 브랜치·기존 H6는 변경하지 않는다. hongbinwee GitHub 플러그인으로 원격 HEAD 재확인 후 부모/expected SHA 일치 + non-force update만 수행한다.

기존 `.local-data/preflight/start-candidate.mjs`와 `candidate-release.json`을 최종 SHA·web/app.js 빌드 SHA256에 고정하고 `approved:false`를 유지한다. 후보 source/manifest/build/launcher hash와 기존 running/auth/services hash를 오프라인 점검한다. 실제 후보 시작·3136 Node 정지·재시작·공개 QA는 수행하지 않는다.

기존 롤백 대상은 `f686d42e61b671f1e5a3ef988905195f49f45540`. 이전 승인대기 전환/롤백 계획의 Node-only graceful stop, DB/Tunnel 유지, local/public health·기존 로그인 확인과 실패 시 복구 조건을 보존한다. 롤백 재기동은 NOT_RUN이며 DGX health 장애가 재기동에 영향을 줄 수 있다. 중단 시간은 실측·보장하지 않는다.


독립 검수(gpt-6-luna/max)에서 `product_type` 대기 중 LLM이 순수 가격순 문장을 query SET으로 오판하면 상품 검색어·조건이 덮이는 경계 1건을 재현했다. 실패 회귀 후, 기존 Task가 있는 순수 가격순 요청은 서버가 직접 적용하여 추출기를 호출하지 않게 보완했다. 새 상품명과 가격순을 함께 요청하면 기존 의도 추출 경로를 유지한다. 검수 추가 RED/GREEN은 `.local-data/price-sort-final/review-*.log`에 보존한다.

검수의 존댓말 요청 변형(추천해주세요/보여주세요/정렬해 주세요)도 같은 순수 정렬 경로로 처리하도록 종결형을 공유했고, 모델 호출 금지 회귀를 추가했다.

최종 독립 재검수: 두 finding의 보완과 관련 회귀를 읽기 확인했고 추가 blocker 없음. 검수 에이전트는 파일 수정·전체 테스트를 수행하지 않았다. Main의 최종 release-verification 로그에서 Typecheck/Build PASS, 112+96 PASS, 전체1,103/1,061/41/1 및 기존41 FAIL source 완전 동일을 확인했다.
