# Hermes QA09–11 독립 결함 수정 및 전환 전 검증

2026-10-20. 기준 `c1e22b0b2b945039eb81182a839dafdf583ed1bc`, 대상 `feature/hermes-agent`.
기존 H6 전환과 실환경 E2E는 승인 전이므로 **NOT_RUN**. 검증은 실제 함수/체크포인트 그래프와 합성 fixture/mock을 사용했으며 실제 Claude·DGX·Commerce DB 성공으로 간주하지 않는다.

## 원인과 최소 수정

| 결함 | 원인 / 수정 파일 | 수정 전 → 후 실제 재현 |
|---|---|---|
| QA09 정렬 취소 무시 | `src/brain/review-sort.ts`, `read-flow.ts`: 긍정 정렬 추출이 취소보다 우선이고 현재 Task State에 정렬이 남음. 취소 판별을 공유하고 현재 상태에서도 해제 | “촉촉하다는 리뷰가 많은 순 말고 그냥 추천해줘” aspect=촉촉 → null, 개인화 복귀. 가격 범위·다른 조건 유지, 후속 유지/명시 재설정 검증 |
| QA09 축약 부정 긍정 오집계 | `review-sort.ts`: `진 않다`/부정 종결 누락, 서로 다른 속성 평가를 한 범위에서 판정. 절 경계 및 요청 속성 부정 검사 보완 | “촉촉한 것 같진 않다” true → false. 질문·인용 제외, 무관한 향 부정 뒤 직접 사용 긍정 유지 |
| QA09 리뷰 표본 없는 상품 편입 | `review-sort.ts`: 확인한 표본 0과 긍정 언급 0을 같은 점수로 처리 | C ranked/count=0 → ranked 제외/count 없음/referenceOnly. 실제 표본 있으나 긍정 0은 표본 순위에 유지. 옵션별 범위 유지 |
| QA10 원본 ID 충돌 누락 | `src/brain/review-summary.ts`: 중복 시 본문/옵션/출처 종류 일부만 비교했고 필터 뒤 검사하여 잘못된 행의 충돌 은폐 | 같은 ID 별점·source_ref 변경 SUMMARY → NOT_FOUND. 본문/상품/옵션/별점/source_kind/source_ref 6필드 양방향 충돌 거부, 완전 동일 중복만 sampled=1 |
| QA11 보조 버튼 32px | `src/web/styles.css`: 저장 기준 삭제·다시 확인 규칙이 별도로 32px 지정됨 | 두 규칙 32px → 44px; fit-content/max-width:100%/줄바꿈. 320/375/390px에 적용되는 공통·420px 미디어 CSS 점검. 실제 렌더·키보드 E2E NOT_RUN |

회귀 파일: `tests/unit/brain-hermes-qa09.test.ts`, `brain-hermes-qa10.test.ts`, `brain-hermes-qa11.test.ts`, `brain-rag-v4.test.ts`.
RAG의 낡은 동일 원본 ID 무조건 거부 기대값을 동일 상품·옵션·출처 dedup / 범위 충돌 거부로 분리했다. 테스트 삭제·추가 SKIP 없음. Memory API·스키마·2단계 승인·결제/취소 안전장치 변경 없음.

독립 검수(gpt-6-luna/max)는 첫 수정의 “많은 순 취소해줘” 누락과 광고 인용을 `지만`에서 나누어 긍정 처리하는 문제를 추가 발견했다. 실패 회귀(24 PASS/2 FAIL) 후 보완했고 재검수에서 새 blocking finding 없음. 검수 에이전트는 전체 테스트를 별도로 실행하지 않았다.

## 실행 결과

Node v24.15.0. 운영 DB/API 키 주입, 감사 snapshot/backup 임의 생성 없이 실행했다.

| 검증 | 결과 |
|---|---|
| Typecheck / Build / git diff --check | PASS |
| H1–H6 및 기존 지정 회귀 | 112/112 PASS |
| QA09 / QA10 / QA11 | 26/26, 18/18, 10/10 PASS |
| CI 지정 회귀 합계 | 166/166 PASS |
| RAG v4 추가 회귀 | 23/23 PASS |
| 전체 단위 | 1,084 total / 1,042 PASS / 41 FAIL / 1 기존 SKIP |
| 기존 전체 단위와 비교 | 1,070/1,027/42/1 → 위 결과, 기존 실패 1건 해결, 신규 실패 없음 |
| 공개 서버 전환·실제 Claude/DGX/Commerce E2E | NOT_RUN |

나머지 41 FAIL은 파일별 실패 수까지 기존과 일치한다: 고정 QA 아티팩트 누락 37(원본 dump·audit·preflight 없음), 테스트 DB 환경 설정 의존 3, mock 모델 설정 누락 1. 전체 PASS가 아니다. 원본 증거·외부/운영 키로 실패를 숨기지 않았다.

새 증거: 검증 Worktree `.local-data/final-checked/`의 `results.json`, `failure-comparison.json`, `independent-probes-green.json`, 각 로그. 수정 전 RED는 `.local-data/preflight/fixes-*-red.log`, 추가 검수 RED/GREEN은 `.local-data/final-verification/review-feedback-*.log`. 기존 증거 보존.

## 별도 OPEN: 명시 가격순 미지원

실제 MemorySaver 그래프에 “이번엔 가격순으로”를 입력하면 리뷰 정렬은 해제되지만 장바구니 개인화가 29,000원 상품을 19,000원보다 앞세울 수 있다. 설명도 미지원 사실을 알리지 않는다. `.local-data/preflight/price-sort-diagnostic.json`에 재현 기록. 이번 승인된 5건의 최소 수정 범위를 넘어 가격 정렬 기능을 추가하지 않았으며, **사용자 요청 기준을 지킨다고 PASS 처리하지 않는다**.

## 안전한 Git 반영

기존 `feature/hermes-agent` 로컬 브랜치는 다른 Worktree에 연결돼 있으므로 옮기거나 강제로 checkout하지 않는다. 검증 Worktree는 detached 유지. 명시한 수정 파일과 이 보고서만 Git tree에 담아 `hongbinwee` GitHub 플러그인으로 기존 원격 HEAD를 부모로 commit한다. Push 직전 HEAD 재확인 후 expected SHA + non-force ref update로 `feature/hermes-agent`만 갱신한다. 원격 커밋을 fetch하고 검증 tree와 일치할 때 같은 커밋에 detached HEAD를 붙여 유실을 막는다. main/brain-core/원본 Worktree 변경 없음.

## 승인 후 전환 계획 — 아직 실행하지 않음

- 후보 Worktree: `C:/Users/proje/.codex/worktrees/hermes-qa0911/codyssey_final`. 엔트리 `src/server.ts`, 정적 번들 `web/app.js`, CSS `src/web/styles.css`.
- 후보 launcher: `.local-data/preflight/start-candidate.mjs`, manifest `candidate-release.json`, runtime/log/sentinel은 `preflight/runtime/`로 분리. manifest SHA·번들 SHA256·clean 소스를 대조하고 명시 승인 + 일치 SHA 없이는 시작 거부. manifest는 최종 원격/로컬 동일 SHA로 고정한다.
- 기존 H6: `C:/Users/proje/.codex/worktrees/hermes-h6-live/codyssey_final`, SHA `f686d42e61b671f1e5a3ef988905195f49f45540`, Node PID18672 (`C:/Program Files/nodejs/node.exe`), port3136. DB PID9232/15442, Tunnel PID37144/metrics20336 유지. 기존 URL 유지.
- `services.json`, QA auth/6계정, SESSION_SECRET, DB/BRAIN_DATABASE_URL, Memory/Checkpoint·사용자 세션 및 승인된 Claude/Decisions/DGX 설정을 기존 파일에서 참조한다. 비밀값 복사/출력/커밋 없음. 기존 auth/services/launcher/running 파일 해시 동일 확인.
- 전환 직전 두 SHA/clean/build hash/포트 소유자/진행 요청을 다시 확인하고 DGX health 및 기존 설정 의존 파일이 유효한지 승인 범위에서 선점검한다. 원격 사전 점검 실패면 기존 Node를 중지하지 않는다.
- 승인 후에만 기존 `stop-server-release` sentinel로 **Node만** graceful stop. 진행 요청은 종료까지 기다리므로 시간 제한 안에 포트가 해제되지 않으면 상태를 보고하고 강제 종료하지 않는다. 새 요청에는 일시 접속 실패가 생기며 진행 요청은 Node/LLM 상태에 따라 실패 가능하다. 쿠키·세션 버전은 유지한다. 10–30초는 실측/보장 시간이 아니다.
- 포트 해제 확인 후 후보 cwd에서 Node를 `Start-Process -WindowStyle Hidden`으로 별도 timestamp 로그와 함께 실행한다. 후보 running.json의 PID/3136/승인 SHA 대조.
- 전환 후 local/public `/health`, 기존 `/api/session` 로그인과 기존 세션, Brain/Commerce API를 검증한다. 이후 별도 승인된 합성 계정으로 QA09–11 실제 Claude/RAG/Commerce E2E 진행. RAG profile/in_stock 422 미해결 계약은 유지, 오류 시 FAIL/차단 항목으로 기록한다.
- 자동 복구 판단 조건: 후보 exit/listen 실패·manifest SHA 불일치·local/public health가 관찰 한도(초안 60초) 내 정상화되지 않음·기존 인증/세션 회귀·DB/Brain 연결 실패. 더 이상의 상태 변경 테스트 중단 후 기존 버전 복구. 60초는 검증 정책이지 서비스 복구 보장 시간이 아니다.
- 복구: 후보 runtime의 stop-server로 후보 Node만 종료/3136 해제 → 이번 승인 전환에서 만든 기존 stop-server-release만 제거 → 원래 H6 cwd에서 기존 `.local-data/h6/start-release.mjs`를 숨김 실행·새 로그 → f686d42/PID/3136/local/public health/기존 로그인 확인. DB·Tunnel 중지/재설정·migration/seed/reset 없음.
- 롤백 정적 준비 PASS: 기존 f686d42 clean 소스, web/app.js·의존성 존재, Node24 launcher 구문 정상, 현재 해당 버전 프로세스 실행 중. **실제 중지 후 재기동 검증 NOT_RUN**. 기존 launcher도 시작 시 DGX health를 요구하므로 외부 장애가 복구를 지연/차단할 위험은 남는다.

2단계 실행 준비물은 위 launcher·manifest·계획 및 최종 SHA로 갖추되, 기존 3136 재시작/실제 버전 전환/공개 실환경 QA는 사용자 승인까지 수행하지 않는다. 가격순 OPEN과 전체 41 FAIL을 포함해 승인 판단해야 한다.
