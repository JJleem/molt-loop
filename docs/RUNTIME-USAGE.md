# Runtime 사용법과 효율 개선

기존 Task 스키마와 명령은 유지한다. 이전 프로젝트 설정에 새 필드가 없으면 순차 실행과
기존 독립 검증 정책을 유지한다. 이 Starter의 설정은 작업 자료 제공, Worker 격리,
최대 Worker 2개, 제한된 Gate-only 완료, 그리고 `quick` 프로필을 켜 두었다. 예산 숫자는 사용자가 지정한다.

처음이면 [QUICKSTART](QUICKSTART.md) 한 장부터 읽는다.

## 빠른 경로: `quick`과 프로필 (V0.3)

```powershell
.\loopctl quick "README에 설치 절차를 추가한다"
.\loopctl quick --file phase-prompt/03-small-fix.md --file phase-prompt/04-next.md
.\loopctl quick "..." --profile <name>      # quick 대신 다른 프로필
.\loopctl start --file ... --profile quick   # start에도 같은 프로필을 줄 수 있다
```

`quick`은 `start`와 같은 승인 경계를 쓴다 — 명령 자체가 지정한 목표에 대한 승인이며, 다른 파일로
범위를 넓히지 않는다. 인라인 목표는 `.loop-local/goals/quick-<hash>.md`로 남기고, 그 파일이 범위 기록의
기준이 된다. 같은 목표 문장을 다시 `quick`하면 끝난 범위는 다시 계획하거나 실행하지 않는다.

프로필은 `.loop/project.yaml`의 `runtime.profiles.<name>`이다. **속도·비용에 관한 키만** 허용한다:
`worker_model` `verifier_model` `planner_model` `worker_effort` `verifier_effort` `planner_effort`
`worker_timeout_seconds` `verifier_timeout_seconds` `planner_timeout_seconds` `max_call_budget_usd`
`goal_verification` `max_tasks_per_plan`. 그 밖의 키(예: `gate_only_completion`)는 설정 로드 자체가 실패한다.
Gate, `requires_verifier`, 승인 경계, 정지·재시도 한도는 프로필로 바꿀 수 없다.

Starter의 `quick` 기본값: Worker·Verifier effort `low`, Planner effort `medium`, Plan당 최대 4 Task,
Goal 검증 끔, Worker timeout 600초. 모델은 지정하지 않는다(CLI 기본값).
`--profile`은 먼저 적용되고 명시적 `--effort`/`--model` 플래그가 그 위를 덮는다. 적용된 값은 명령 출력에
그대로 나오고, Worker/Verifier/Planner Envelope에 `profile`·`effort_requested`로 기록된다.

## Effort와 호출당 상한

```yaml
runtime:
  worker_effort: null          # low · medium · high · xhigh · max. null이면 플래그를 넘기지 않는다
  verifier_effort: null
  planner_effort: null
  max_call_budget_usd: null    # AI 호출 1회 상한(USD). null이면 없음
```

`run`/`retry`/`execute`/`execute-plan`/`start`/`quick`의 `--effort`는 Worker effort, `verify --effort`는
Verifier, `plan --effort`는 Planner effort다. `execute`/`execute-plan`에는 `--verifier-effort`도 있다.

2026-09-15 Claude Code 2.1.272에서 `--print`와 함께 두 플래그의 동작을 확인했다. 응답 payload에는
effort가 없으므로 Envelope의 `effort_requested`는 **요청값**이다. `--max-budget-usd`는 provider가 호출
**뒤에** 검사한다: 상한을 넘기면 exit 1, `terminal_reason: budget_exhausted`, 결과 없음, 비용은 그대로
보고된다. 첫 응답이 상한을 넘길 수 있다(0.05 상한에 $0.0899 청구 관찰). 실시간 hard cap이 아니다.
누적 예산(`limits.yaml`의 `budget.*`)과는 별개이며 둘 다 켤 수 있다.

## Triage: 사람을 부르기 전에 먼저 보는 판단 역할 (V0.4)

Runtime은 지금까지 두 층이었다: 결정론적 자동 처리와 사람. 판단이 조금이라도 필요하면 전부 사람에게 갔다.
Triage는 그 사이의 층이다. Planner · Worker · Verifier와 같은 격리된 읽기 전용 AI 호출이며, **정지 지점에서만**
호출된다. 성공하는 Task에는 비용이 0이다. **기본으로 켜져 있다.**

```yaml
# .loop/policies/limits.yaml
triage:
  enabled: true
  max_decisions_per_task: 2   # Task당 Triage 호출 수
  max_retries_per_task: 1     # 그중 RETRY_WITH_LESSON 횟수
  max_replans_per_plan: 1     # Phase당 REPLAN 횟수 (start/quick 아래에서만 실행)
  max_answers_per_plan: 1     # Phase당 Planner 질문 자동 답변 횟수
```

절을 지우면 이전처럼 곧바로 사람에게 간다. `--profile manual`(Starter 기본 프로필)로 명령 하나에만 끌 수도 있다.
`triage_adapter` · `triage_model` · `triage_effort` · `triage_timeout_seconds`는 `project.yaml`에 있다. adapter가
null이면 verifier_adapter를 쓴다.

**Triage가 고를 수 있는 것** — Runtime이 정지 사유별로 만든 메뉴에서만 고른다. 메뉴는 사람이 `resume` ·
`retry` · `gate --rerun` · `verify --rerun`으로 할 수 있는 복구 행동과 같다.

| 정지 | 메뉴 |
| --- | --- |
| 검증 중 저장소 변경(`RECOVERY_AMBIGUOUS`), Gate TIMEOUT | `RERUN_GATES` / `ESCALATE` |
| Verifier 자체 사고(timeout · crash · 결과 형식 오류) | `RERUN_VERIFIER` / `ESCALATE` |
| 재시도 사다리 소진, `STALLED`, Verifier FAIL 반복 | `RETRY_WITH_LESSON`(lesson 한 줄) / `REPLAN` / `ESCALATE` |
| Worker가 BLOCKED 요청 | `UNBLOCK`(설명을 다음 Context에 주입) / `REPLAN` / `ESCALATE` |
| Goal 검증 실패 | `REPLAN` / `ESCALATE` |
| Planner 질문 중 `spec` · `implementation` 분류만 있을 때 | `ANSWER`(스펙·저장소에 적힌 답만) / `ESCALATE` |

**Triage가 절대 할 수 없는 것.** DONE 전이는 메뉴에 없다. 정책 위반 · Verifier 쓰기 위반 · 예산 소진 ·
PAUSE · 보안/비가역/제품 갈림길 질문(`security` · `irreversible` · `product` · `other`)은 메뉴가 `ESCALATE`뿐이라
AI를 부르지도 않는다. 결정마다 Verifier와 같은 `evidence_basis` · `evidence_refs`가 필수이고 Runtime이 경로의
존재를 확인한다. 메뉴 밖 결정 · 없는 경로 · 결과 없음은 전부 `ESCALATE`로 처리되어 사람에게 간다.

**기록.** Task 수준 결정은 `.loop-local/runs/<RUN>/triage/<n>/`(context.md · triage-result.json · triage-envelope.json),
Plan 수준은 `.loop-local/plans/<PLAN>/triage/<n>/`에 남는다. Execution Report의 events에 `triage` 단계로 들어가고
`status`의 latest execution 줄에 `[triage: …]`로 보인다. `usage --all`은 `triage` 단계 시간, `triage decisions` 수,
`stops by reason` 표를 보여준다. 비용은 Plan 예산에 포함된다.

**REPLAN과 ANSWER는 `start`/`quick` 아래에서만 실행된다.** 그 명령이 해당 Goal 파일에 대한 계획 권한이기 때문이다.
REPLAN은 남은 Task를 DROPPED로 내리고(DONE은 유지) 실패 맥락을 Goal 아래에 붙여 다시 계획한다. ANSWER는 Goal 아래에
DECISIONS 절(답과 출처)을 붙여 다시 계획한다. 둘 다 `.loop-local/workflows/`의 기록에 `superseded`로 남는다.
`execute-plan` 단독 실행에서는 REPLAN이 메뉴에 오르지 않는다.

**Triage 재시도는 판단 예산이다.** `stop.max_attempts`와 `escalation.*`(결정론적 사다리)과 별개로 센다. 같은 실패가
같은 저장소 상태로 반복되면 `STALLED`가 잡고, 결정 상한이 끝을 잡는다. Triage를 켜고 쓸 때는 `budget.plan_usd`를
같이 켜는 것을 권한다 — Triage가 틀려도 결과는 잘못된 DONE이 아니라 비용이며, 예산이 그 상한이다.

**남는 사람의 몫.** 스펙과 Goal 파일(Triage가 답하는 근거), 최종 인수(DONE은 "Goal과 일치"이지 "원한 것"이 아니다),
그리고 위의 절대 자동화하지 않는 정지들. 관찰되지 않은 실행(브라우저 · 수동 조작)이 필요한 AC는 Triage가 있어도
PASS할 수 없다 — 그런 Task는 e2e 같은 자동 Gate가 있어야 사람 없이 끝난다.

## `latest`와 `NEXT`

`plan-show` · `plan-approve` · `execute-plan` · `usage`의 `<PLAN>` 자리에 `latest`를 쓰면 가장 최근 Plan이다.
승인 여부는 보지 않으므로 각 명령이 자기 자격을 그대로 검사한다.

`recovery_paths` 기본값은 `docs/` · `README.md` · `CLAUDE.local.md` · `START-HERE.md`다. 검증 중에 이 경로만 바뀌면 사람도
Triage도 부르지 않고 새 subject로 Gate를 다시 돌린다(OBS-003). 그 밖의 변경은 Triage가 본다.

`status`는 맨 아래 `NEXT`에 다음에 칠 명령 하나를 보여준다. 기록된 파일 상태에서만 결정론적으로 고른다:
실행 중 → PAUSE → 깨진 Task → 사람이 필요한 정지(`diagnose`) → 승인된 Plan의 남은 Task(`execute-plan`) →
Plan 밖의 검증/실행 대기 Task → 승인 대기 Plan(`plan-show`) → 아무것도 없음(`start`/`quick`). AI 호출은 없다.

## 기존 사용법

```powershell
.\loopctl plan --file phase-prompt/01-foundation.md
.\loopctl plan-show PLAN-...
.\loopctl plan-approve PLAN-...
.\loopctl execute-plan PLAN-...
.\loopctl status
```

`plan`은 Task를 만들지 않고, `plan-approve`는 실행하지 않는다. 명령 이름과 의미는 같다.
`execute-plan`을 반복하면 DONE은 건너뛰고 REVIEW/IN_PROGRESS의 중단 단계부터 이어간다.
BLOCKED, 정책 위반, 풀리지 않은 충돌에서는 멈춘다. 실제 파일명과 Plan ID로 바꿔 실행한다.

## 승인한 범위를 한 번에 실행

Bootstrap이 끝나고 Gate가 준비된 프로젝트에서 사용한다.

```powershell
.\loopctl start --file phase-prompt/01-foundation.md
# 여러 Phase를 미리 승인하는 경우, 실행 순서대로 명시한다.
.\loopctl start --file phase-prompt/01-foundation.md --file phase-prompt/02-viewer.md
```

이 명령 자체가 지정한 목표 파일들의 계획·승인·구현에 대한 승인이다. 자동으로 다른 파일을
찾아 범위를 늘리지 않는다. `.loop-local/workflows/`에 목표 내용의 해시와 Plan ID를 기록한다.
같은 명령과 같은 파일 내용으로 재실행하면 기존 Plan과 완료 상태를 사용한다. 목표 내용이
바뀌면 새 범위다. NEEDS_HUMAN이나 무효·오래된 Plan은 자동 승인하지 않는다.
배포·push·외부 메시지 전송은 수행하지 않는다.

## 중단에서 복구

```powershell
.\loopctl diagnose TASK-001
.\loopctl resume TASK-001
.\loopctl resume PLAN-...
# 표시된 변경 내용을 확인한 뒤, 현재 코드에 대해 Gate부터 다시 검사한다.
.\loopctl resume TASK-001 --rerun-gates
```

검증 중 저장소가 바뀌면 ADDED/CHANGED/REMOVED 경로를 보여준다. 과거 Run에 파일별
지문이 없으면 모른다고 표시한다. `--rerun-gates`는 Worker를 다시 호출하지 않는다.
제어 파일 변경·Verifier 정책 위반·손상된 기록은 이 옵션으로 무시하지 못한다.
제어 설정을 의도적으로 수정했다면 검토 후 기존 `gate TASK --rerun`으로 새 증거를 만들고 재개한다.
매 실행에서 자동 Gate 재실행은 한 번까지다. 계속 바뀌는 저장소에 무한 재검사를 하지 않는다.

자동 재검증을 사전 허용하려면 `.loop/project.yaml`의 `runtime.recovery_paths`에
정확한 파일명 또는 끝이 `/`인 디렉터리 경로를 적는다. 기본값은 `[]`다. 해당 경로를
검증에서 제외하는 것이 아니라 **새 subject로 Gate를 다시 실행**한다.

## 시간·비용 확인과 예산

```powershell
.\loopctl usage --all
.\loopctl usage PLAN-...
.\loopctl usage TASK-001
```

전체/Plan 집계는 Planner·Worker·Gate·Verifier 시간, Task별 호출·재시도, 알려진 비용,
비용 미보고 호출 수, 입력·캐시 입력·출력 토큰을 구분한다. 이전 검증 기록도 한 번씩 합산한다.
`usage TASK`의 기존 개별 Worker telemetry 출력은 유지한다.

`--all`/`PLAN` 집계 끝에는 Task별 추세 표가 붙는다(OBS-005 · CI-004): Worker 비용, 직전 Task 대비 증감(`vs prev`),
Verifier 비용, 호출 수, 재시도, Worker 출력·캐시 입력 토큰, 시간. 비용을 보고하지 않은 호출이 섞이면
`?`를 붙이고 0으로 세지 않는다.

`.loop/policies/limits.yaml` 예시(숫자는 권장 가격이 아니라 설정 예시):

```yaml
budget:
  task_usd: 5
  plan_usd: 20
  task_output_tokens: 50000
  on_unknown_cost: stop
```

기본값 `null`은 무제한이다. 예산은 **다음 유료 호출 전** 검사한다. provider가 호출 종료 후
비용을 보고하므로 진행 중인 호출은 한도를 넘길 수 있다. 실시간 hard cap으로 광고하지 않는다.
비용 미보고/도중 중단된 호출은 예산이 설정된 경우 기본적으로 진행을 멈춘다.
`on_unknown_cost: continue`는 미보고 비용을 0으로 간주하지 않고, 불완전한 비용 기록에도
진행하겠다는 명시적 선택이다. Plan 예산이 있으면 Worker 호출을 하나씩 시작한다.
재실행이나 낮은 수준 `run`/`verify` 명령으로 누적 예산을 초기화하지 않는다.

## 작업 자료와 모델

Worker 입력에 실제 관련 파일 최대 10개, 현재 SHA-256, 진입점 일부, 선행 Task의 짧은
설명과 증거 경로를 최대 6,000자로 제공한다. 매 시도에 해시를 다시 계산한다. 이전 대화나
Planner/Verifier의 서술은 복사하지 않는다. `runtime.task_resources: false`로 끌 수 있다.
Worker는 허용된 `node tools/loop-runtime/loopctl.mjs self-check [gate ...]`를 사용한다.

기존 `worker_model` / `planner_model` / `verifier_model`은 그대로다. 선택적으로
`worker_simple_model`을 지정하면 verifier가 필요 없고 모든 AC가 Gate인 Task의 첫 시도에만
그 모델을 사용한다. 재시도에는 기본 Worker 모델을 쓴다. 명시적 CLI `--model`이 우선한다.
모델 이름은 설치된 provider에서 실제 지원하는 값으로 지정한다.

## 검증과 병렬 실행

- `gate_only_completion: true`: `requires_verifier: false`이고, 비어 있지 않은 모든 AC가
  실제 Gate PASS로 판정됐을 때만 Runtime이 DONE으로 전이한다. 독립 검증을 했다고 기록하지 않는다.
- `isolate_workers: true`: Worker마다 독립 파일 복사본과 Git 저장소를 만든다. 기존 dirty 변경도
  작업 시작 기준으로 포함하며 원래 저장소의 커밋·인덱스를 수정하지 않는다.
- `max_parallel_workers: 2`: 승인된 Plan에서 의존성이 없는 READY Worker를 최대 2개 실행한다.
  결과 반영은 직렬로 하고 Gate와 Verifier는 반영된 원래 저장소에서 실행한다.
- `max_parallel_gates: 2`: `parallel_safe: true`로 명시한 인접 Gate들만 병렬 실행한다.
  공통 출력 디렉터리를 수정하거나 실행 순서에 의존하는 Gate에는 이 값을 설정하지 않는다.

충돌이 나면 원래 파일을 덮어쓰지 않고 `.loop-local/workspaces/`와 Run의 `integration.json`을
보존한다. 충돌을 해소한 뒤 `resume`하면 보존된 결과를 다시 반영하며 Worker를 다시 부르지 않는다.
이는 파일 작업 격리이며 OS 보안 sandbox를 대신하지 않는다.

`node_modules`가 있으면 공유 쓰기를 피하기 위해 복사한다. 대형 의존성이면 이 준비 비용이
클 수 있다. 내부 링크는 복사본 내부로 연결하며 외부로 나가는 링크/저장소 symlink는 거부한다.
Python 가상환경 등 다른 ignored 실행 환경은 자동 준비하지 않는다. 이런 환경은 복사본에서
실행 가능한 전역 도구를 쓰거나 `isolate_workers: false`, `max_parallel_workers: 1`로 실행한다.
작업 공간은 자동 삭제하지 않는다. 복구가 필요 없는 시점에 정리할 수 있다.

동일 저장소의 Runtime 쓰기 명령은 작업 잠금으로 충돌을 막는다. 조회와 self-check는 계속 가능하다.
heartbeat는 긴 Worker 호출 중에도 갱신된다. 사람의 직접 편집까지 잠그지는 않으므로 최종 검증
중에는 원래 저장소를 수정하지 않는 편이 좋다.

## 검증 범위

`runtime.goal_verification: true`이면 모든 Task DONE 뒤 원래 Plan Goal을 독립 읽기 전용
Verifier가 검사한다. Task 분해에서 누락한 요구나 관찰되지 않은 실행 주장은 통과 근거가 아니다.
실패하면 Task 상태는 보존하고 `GOAL_CHECK_FAILED`로 Phase를 멈춘다. 결과는 Plan의
`goal-checks/`에 Goal/저장소 해시별로 기록하고 같은 상태의 판정을 재사용한다.
이 최종 검사는 추가 AI 호출이며 Plan 누적 비용과 예산에 포함한다. 미완료 호출은 자동 중복하지 않는다.

`runtime.adaptive_recovery: true`이면 저장소 지문이 같은 검증기의 crash/timeout/schema 실패는
검증기만 한 번 재호출한다. 재시작해도 보존된 이력으로 상한을 유지한다. 실제 구현 실패는
Gate 오류/실패한 AC 중심으로 Worker에 전달한다. Worker 결과 형식 실패는 기존 구현을 보존하고
결과 형식을 복구하도록, timeout은 남은 작업을 작은 체크리스트로 줄이도록 안내한다.
환경 설정 오류·권한 위반·불명확한 변경은 자동 수정하지 않고 멈춘다.

격리 Worker 복구는 private Git HEAD가 아니라 `integration.json`의 원본 반영 지문을 사용한다.
반영 기록이 없거나 그 이후 원본 파일이 바뀌면 안전하다고 추정하지 않는다.

실제 Phase 측정은 대상 프로젝트에서 기존 `start --file <Phase목표파일>`로 실행하고
`usage <PLAN-ID>`와 Plan의 `executions/` 보고서로 시간, 호출 수, 토큰, 비용, 중단을 확인한다.
전후 비교에는 같은 초기 코드·Goal·모델·예산이 필요하다. mock 결과는 실제 절약률이 아니다.

회귀는 임시 Git 프로젝트와 mock adapter로 실행한다. 실제 provider 비용과 실제 제품의
속도 개선율은 측정하지 않았으며, 위 기능이 일정 비율의 절약을 보장하지 않는다.
자동 replan/decompose, 실행 중 정밀 비용 차단, 배포, Goal 밖 작업 자동 발견은 구현하지 않았다.
