# Hermes QA 11 — 가격 선호 저장 UI/UX 선택적 개선

작성: 2026-10-20. 저장소 `hongbinwee/codyssey_final-mission-main`, 브랜치 `feature/hermes-agent`.
브랜치 병합 없음. QA09~10 및 H1~H6 동작 보존. `main`·`feature/brain-core`·기존 H6 QA 서버(3136)·분리 DB(15442)·Cloudflare Tunnel 변경/재시작 없음.

## 요구사항과 기존 구조 대조

- 기존 `BrainPreview.tsx`에서 `POST /api/brain/preferences/proposals` → `POST /api/brain/preferences/confirm` 2단계 승인을 사용했고 `DELETE /api/brain/preferences/price_priority` 삭제 경로도 제공했음. 서버 `PersistentConversations.confirmPreference`가 소유자, 원본 메시지, 만료·사용 여부를 DB 트랜잭션으로 검증하는 구조임.
- 기존 결함/불편: `가격 선호를 장기 기억으로 저장할까요?`, `가성비 중심`, `선호 저장 요청`, `이 선호를 기억하도록 확인` 문구가 딱딱함. 기본 선택값 `value`가 이미 저장된 `balanced/performance`와 동기화되지 않음. 저장 상태를 현재 저장값과 별도 boolean으로 관리하고, 가격 선호가 없는 상태에서도 삭제 버튼이 보일 수 있었음. 편의 버튼 배치와 선택 박스 크기가 일관되지 않음.

## 실제 변경

### UI — `src/web/components/BrainPreview.tsx`, `src/web/styles.css`
- 제목 **이 가격 기준을 기억해둘까요?** / 설명 **다음 상품 추천에도 선택한 기준을 반영할 수 있어요.**
- 내부 키·값 보존: `price_priority:value` = **가성비를 우선해요**, `balanced` = **가격과 품질을 균형 있게 봐요**, `performance` = **품질을 더 중요하게 생각해요**. 데이터베이스 스키마와 API 계약 변경 없음.
- 기존 `저장된 장기 선호`와 내부 구현 문구를 사용자 중심의 **저장된 선호**, **현재 저장된 기준이에요**, **저장한 가격 기준 삭제**로 정리.
- 선택 필드 아래에 내용 너비에 맞는 **저장하기** 버튼. 1단계에서는 백엔드 proposal만 만들며 실제 영구 저장 안 함. 2단계에서는 선택한 기준을 명시하며 **저장 확인 / 취소**; 최종 확인 전까지 영구 값 불변. 변경 시 이전 미사용 proposal ID를 UI에서 폐기. 사용하지 않은 서버 토큰은 만료될 때까지 DB에 남을 수 있으므로 `취소`를 서버 revocation으로 주장하지 않는다.
- 현재 저장값은 `GET /api/brain/preferences` 결과로 동기화. 저장된 값과 선택값이 같으면 신규 proposal 요청을 만들지 않음. 저장값을 불러오지 못한 경우 저장 요청 비활성화 후 **저장된 선호 다시 확인** 제공.
- 제출 직후 ref lock + disabled로 빠른 중복 클릭을 차단. `CONFIRMATION_REQUIRED`, HTTP 응답 유실 같은 애매한 경우에는 저장값을 다시 읽어 실제로 저장된 경우만 성공을 안내. 실패 시 기존 저장값을 덮어쓰지 않고 재시도 안내.
- 다른 쇼핑 탐색 버튼 **조건 바꾸기 / 다른 상품 보기**를 보조 선호 저장 카드보다 앞에 표시.
- 필드와 버튼 모두 최소 높이 44px. 버튼이 가로폭 전체를 차지하지 않고, 모바일 420px 이하에서는 패딩·너비/줄바꿈을 고려하는 보조 카드 스타일. 기존 디자인 토큰 `--bg-elev`, `--accent`, `--line` 재사용.
- 실제 가격 선호가 저장된 경우에만 가격 선호 삭제 버튼 표시. 기존 다른 기억 값 삭제 경로·대화 기록·쇼핑 계획 변경 없음.

## 직접 검증 / CI

[GitHub Actions 39426820674](https://github.com/hongbinwee/codyssey_final-mission-main/actions/runs/39426820674)

- `npm ci`: PASS.
- `npm run check`: **PASS**.
- `npm run build`: **PASS**.
- H1~H6 + QA09~QA11 지정 회귀: **153/153 PASS / 0 FAIL / 0 SKIP**. 신규 QA11 9건: 사용자 문구/내부 값, 카드 CSS 계약, 쇼핑 CTA 우선 배치, 저장값 동기화/중복 방지, 2단계 승인/값 일치/취소, 응답 유실 후 읽기 재확인, proposal과 DB 저장 API 분리, 재사용 토큰·타 actor 차단, 변경·삭제 보존. 신규 테스트의 영구 저장 API는 **모의 서비스 상태**를 사용했으며 실 DB가 아님. CSS 테스트도 파일/렌더 계약 수준으로, 실제 픽셀/브라우저 확인이 아님.
- 전체 `npm run test:unit` 참고 진단: **1,070건 중 1,026 PASS, 43 FAIL, 1 SKIP**. Workflow는 `continue-on-error`여서 초록색이어도 전체 단위 테스트 PASS가 아니다. 남은 실패는 누락된 내부 QA `shots/` 파일, 미설정 LLM 키, 이전 RAG 파서 중복 기대값 등으로 구성되어 있으며 모두를 환경 문제로 단정해서는 안 됨.
- **NOT_RUN**: 실제 DB 선호 저장/변경/삭제, 새 브라우저·새 대화 연결, 실제 모바일 시각/키보드·접근성 확인, 외부 QA 서버의 실제 Claude/Commerce 결합, UI E2E. 서버나 Tunnel에 새 코드를 배포하지 않았음.

## QA 09~11 실환경 검증 인수인계

다음 문서의 코드는 이미 `feature/hermes-agent`에 Push된 상태다. Brain Core의 로컬-only 통합 커밋 `2a9cc6c`은 이번 단계에서 병합하지 않는다.

- [QA09](./HERMES_QA09_PRICE_REVIEW_SORT.md): Commerce 배송비 포함 범위, 명시적 긍정 리뷰 정렬, DGX RAG top_k=10 실제 수락/응답/리뷰 출처와 옵션 검증
- [QA10](./HERMES_QA10_PRODUCT_REVIEW_SUMMARY.md): 상품명·이전 2번·이 제품 단점 전용 리뷰 흐름, 실제 Claude 한국어 감성/인용 의미 평가, React 전용 근거 UI
- **QA11**: 실제 영구 DB에서 `value/balanced/performance` 저장(제안만으로 DB 미변경)→2차 확인→값 변경→삭제→새 대화 유지, 중복 클릭·만료·응답 유실, CSRF/소유자 격리, 모바일 320/375/390/데스크톱 시각 검증

**중요 권한 경계:** 기존 QA 실행 Worktree가 detached HEAD인 상태에서는 GitHub Push만으로 서버가 자동 갱신되지 않는다. Codex는 먼저 로컬/원격 HEAD, 미커밋 작업, 현재 서비스 실행 SHA를 **읽기 전용으로 확인**해야 한다. 기존 3136/15442/Cloudflare 서버의 파일 동기화·재빌드·배포·재시작 또는 DB 변경은 별도 승인 전까지 하지 않는다. 승인된 분리 테스트 환경에서 실행할 수 없는 항목은 `NOT_RUN`으로 구분한다. 실제 DGX 기존 422 사안의 계약 변경은 범위 밖이며 실패하면 원인 기록만 한다.

최종 실환경 보고에는 QA09/QA10/QA11 별 PASS/FAIL/NOT_RUN, RAG/LLM/DB/브라우저 근거, 회귀 오류/대응 계획, p50/p95 및 모델 비용(가능한 경우), 정확한 실행 SHA를 포함한다.
