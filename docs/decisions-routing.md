# Decisions → LangGraph → Claude 라우팅

`feature/system-prompt-integration`의 현재 실행 계약이다. JEV 라우터는 이미 통합되어 있으며 별도 라우터나 Graph를 병렬로 추가하지 않는다.

## 환경 설정

`.env.example`의 기본값은 `BRAIN_ROUTE_MODE=rules`다. 키가 있어도 자동으로 Decisions가 활성화되지 않는다. 승인된 독립 실행 환경에서만 `decisions`로 선택한다. 이 문서 추가는 기존 QA 서버의 실행 설정을 바꾸지 않는다.

- `OPENAI_DECISIONS_API_KEY`: 서버 전용 Decisions 키. 없으면 `OPENAI_API_KEY`를 사용한다. 키가 없으면 Decisions 모드 시작에 실패한다.
- `BRAIN_DECISIONS_TIMEOUT_MS=4000`: 허용 범위 250~30000ms.
- `BRAIN_DECISIONS_CONFIDENCE=0.35`: 허용 범위 0~1. 선택 확률 최소 0.45 조건도 별도로 적용한다.
- Claude 대화는 기존 `LLM_PROVIDER`, `LLM_API_FORMAT`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` 설정의 Provider를 사용한다. Decisions 키와 별개이며, Claude를 쓰려면 해당 Provider가 Claude live로 설정되어 있어야 한다. 코드가 모델을 임의로 바꾸지 않는다.

## 실행 흐름

`runtime.ts`가 라우터와 대화 응답기를 한 번 구성하고 기존 LangGraph에 주입한다.

1. `prepare`: 인증된 대화 소유권 확인, 사용자 메시지 기록, 해당 사용자의 Memory 조회.
2. `route`: Decisions 모드에서는 OpenAI의 의도 분류만 수행한다. 규칙 라우터를 사전 실행하거나 실패 후 fallback하지 않는다.
3. `GREETING / SOCIAL / CAPABILITY / UNCERTAIN`: `converse` 노드가 기존 Provider로 자연어 답변을 생성한다. Claude QA 설정에서는 Claude를 호출하며 tools는 빈 배열이다. RAG나 추천 계획 추출을 호출하지 않는다.
4. `CS_REQUEST`: 기존 제한 안내만 반환한다. 추가 Provider 호출이나 주문·취소·환불 실행은 없다.
5. `SHOPPING_SEARCH / SHOPPING_FOLLOWUP / REVIEW_COMPARE`: 기존 `plan → retrieve → respond` 경로를 사용한다. 검증된 RAG/Commerce 근거, A/B Ranking과 근거 기반 응답 흐름을 유지한다.

규칙 모드는 기존 호환 경로를 유지하며 새 자연어 conversation responder를 활성화하지 않는다. Decisions 응답에는 사용자에게 보여줄 자연어 답변이 포함되지 않는다.

## 프롬프트·안전성·상태

- 공통 `SHOPPING_POLICY`는 의도 추출, 자연어 대화, grounded 응답에 기존 방식으로 조립된다. Decisions는 분류 역할만 가지며 Tool 권한을 부여하지 않는다.
- Decisions에는 최신 메시지와 제한된 이전 검색 조건(쿼리·예산·필수 조건)만 보낸다. 전체 대화·사용자 ID·Memory·Checkpoint를 보내지 않는다.
- 거절, HTTP 오류, 타임아웃, 파싱 실패, 낮은 confidence/probability는 `UNCERTAIN / search:false`다. 이 경우에도 기존 `converse`는 구성된 Provider를 호출할 수 있으나 RAG·Commerce write는 실행하지 않는다.
- 대화 Provider 오류/timeout/잘못된 출력은 명시적인 안전한 오류 응답으로 종료한다. 성공한 고정 대화나 상품 근거를 조작하지 않는다.
- 소유권, Memory 확인, PostgreSQL Checkpoint, 재시도·락·fencing은 기존 Graph 계약을 유지한다. 사용자 메시지 저장과 Checkpoint 기록은 발생하므로 '아무 write도 없다'고 해석하지 않는다.

## 2단계 비교 결과

비교 기준: 원격 JEV `0f786fe`와 통합본 `b06699a`.

- `src/brain/decisions-route.ts`는 동일하다. LangGraph의 비동기 route·분기와 runtime의 Decisions 모드도 이미 통합됐다.
- JEV보다 통합본에 Claude 자연어 대화, 공통 프롬프트·가드레일, A/B Ranking 및 QA 수정이 추가되어 있다.
- JEV의 `.env.example` 설정 안내가 누락되어 최소 복원했다. 구버전 '비검색 의도는 모두 고정 응답' 설명은 가져오지 않았다.
- 로컬 미Push JEV 검증 커밋 `54d8060`의 timeout 테스트 수정은 `b06699a`에 이미 있다. 합성 QA15·실험 실행 스크립트·Mock+DB 테스트·과거 지연 기록은 실행 기능이 아니므로 이번 최소 설정/문서 통합에는 추가하지 않았다. 원래 로컬 JEV 커밋은 보존했다.
- 기존 통합 Worktree의 staged QA 수정 15개 경로는 통합 기준 HEAD와 내용이 모두 동일함을 hash로 확인했다. 해당 staged 상태 자체는 변경하지 않았다.

## 검증 범위

`npm run check`, `npm run build`, `node --test --test-concurrency=1 tests/brain-sandbox/*.test.mjs tests/unit/brain-*.test.ts tests/unit/qa-prompt-isolation.test.ts tests/unit/subcategory-mapping.test.ts`로 핵심 회귀를 확인한다.

이번 변경은 설정 예시·문서만 수정한다. 실제 API·운영 RAG·공유 DB·Cloudflare Tunnel 재검증이나 배포는 수행하지 않는다. Mock PASS는 실호출 PASS가 아니다. 이전 JEV 실호출 결과를 현재 통합 브랜치의 새 실호출 결과로 재사용하지 않는다.

2026-10-20 이번 실행 결과: Typecheck PASS, Build PASS, 핵심 단위·sandbox 통합 243 PASS / 0 FAIL / 0 SKIP, diff 공백 검사 PASS. 실제 모델 API 및 실제 DB 통합은 이번 단계 NOT_RUN이다.
