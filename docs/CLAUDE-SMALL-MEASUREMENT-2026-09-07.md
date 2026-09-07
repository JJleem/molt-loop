# Claude 구독 소규모 실측 — 2026-09-07

## 실행 범위

- 실제 프로젝트: `Clean_Section_POC`.
- 작업: `extractSlice` 구현·타입·테스트 3개 파일의 읽기 전용 정적 검토.
- 입력 파일: `src/point-cloud/slice.ts`, `src/point-cloud/types.ts`, `test/slice.test.ts`.
- 사용자 요청에 따라 작은 표본만 실행. `ply-converter`에서는 Claude를 실행하지 않았다.
- Claude Code 2.1.263, 기존 claude.ai 구독 로그인 사용. API key 인증으로 전환하지 않았다.
- 요청 모델 별칭 `sonnet`, effort `low`; 반환된 실제 모델은 `claude-sonnet-5`.
- 도구 없음, safe-mode, MCP 제외, 세션 재사용 없음, 자동 재시도 0회, 제한 시간 120초.
- CLI 직접 호출 1회이며 Loop Runtime의 Planner→Worker→Gate→Verifier 전체 Phase 측정은 아니다.

## 실제 반환 사용량

| 항목 | 측정값 |
| --- | ---: |
| 벽시계 실행 시간 | 21.615초 |
| Provider API 소요 시간 | 21.178초 |
| CLI 실행 / 사용자 작업 turn | 1 / 1 |
| 전달한 프롬프트 크기 | 22,103 bytes |
| 일반 입력 토큰 | 9,201 |
| 캐시 생성 입력 토큰 | 12,786 |
| 캐시 읽기 입력 토큰 | 3,289 |
| 출력 토큰 | 1,507 |
| 입력 범주 합계 | 25,276 |
| 입력+출력 범주 합계 | 26,783 |
| Provider가 보고한 USD 환산값 | 0.0759798 |

USD 값은 구독 청구액이나 구독 한도 소모율이 아니다. 캐시 입력도 일반 입력과 같은 비용으로
취급하지 않았다. 구독 사용량 UI의 전후 수치는 수집하지 못했으므로 잔여량 감소율은 알 수 없다.

상단 `usage`에는 Sonnet 입력 16,077 / 출력 1,488이 기록되었다. 그러나 `modelUsage`에는
CLI 내부 보조 모델 `claude-haiku-4-5-20251001` 입력 9,199 / 출력 19도 별도로 있었다.
위 표는 누락을 피하기 위해 모델별 사용량을 합산했다. 별도 에이전트나 두 번째 검토를
요청한 것은 아니다. 내부 보조 호출의 목적은 이 응답만으로 확정할 수 없다.

## 품질·변경 확인

- 제공한 세 파일의 전후 SHA-256 동일. 대상 프로젝트 Git 상태도 전후 clean.
- Claude 답변은 확정적 결함을 제시하지 못했고, typed array 범위 밖 접근이 NaN이라는
  부정확한 설명을 포함했다. 로컬 JavaScript 실행 결과는 `undefined`였다.
- Claude가 제안한 소수 경계 사례를 실제 TypeScript 소스의 메모리 내 transpile 결과로
  실행했으며 정상 통과했다. 이 사례를 재현된 버그로 집계하지 않았다.
- 별도 로컬 확인에서는 `position = thickness = Number.MAX_VALUE`일 때 slab 상한이
  Infinity로 넘쳐 판정 축의 Infinity 점이 선택되는 극단 입력 사례를 재현했다.
  이는 Claude가 찾아낸 결과가 아니며, 이번 요청은 실측만이므로 제품 코드는 수정하지 않았다.
- 전체 테스트 스위트·브라우저·제품 Phase 완료를 검증한 결과가 아니다.

## 해석

작은 검토 1회도 약 2.68만 토큰이 기록됐다. 따라서 호출 횟수만으로 소비량을 판단하면 안 된다.
또한 이번 표본은 도구·프로젝트 자동 문맥을 제한했으므로 실제 구현 Phase 비용으로 확대 추정할 수 없다.
한 번의 표본만으로 기존 대비 절약률이나 최적 모델을 결론 내리지 않는다.
추가 AI 호출은 중단했고, 두 프로젝트의 구현·설정·Task 상태는 변경하지 않았다.

원본 측정 자료는 `.loop-local/measurements/measurement.json`, `provider-result.json`,
`started.json`, `prompt.txt`, `stderr.log`에 보존했다. 원본 자료에는 프로젝트 코드가 들어 있으므로
외부 공개용 자료가 아니다.
