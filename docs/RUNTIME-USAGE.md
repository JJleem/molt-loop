# Runtime 사용법과 효율 개선

기존 Task 스키마와 명령은 유지한다. 이전 프로젝트 설정에 새 필드가 없으면 순차 실행과
기존 독립 검증 정책을 유지한다. 이 Starter의 설정은 작업 자료 제공, Worker 격리,
최대 Worker 2개, 제한된 Gate-only 완료를 켜 두었다. 예산 숫자는 사용자가 지정한다.

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
