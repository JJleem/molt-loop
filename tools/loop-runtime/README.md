# loop-runtime (V0)

Loop Engineering Runtime의 구현. 설계 원본은 `.loop/DESIGN.md`이며, Worker에게는 전달되지 않는다.

## Quick Start

프로젝트 루트에서 실행한다. 내부 경로(`tools/loop-runtime/loopctl.mjs`)를 알 필요가 없다.

```bat
REM Windows (cmd / PowerShell)
.\loopctl doctor
.\loopctl status
.\loopctl ready

.\loopctl run TASK-001
.\loopctl gate TASK-001
.\loopctl verify TASK-001

.\loopctl status
```

```sh
# WSL / macOS / Linux
./loopctl doctor
./loopctl status
```

진입점은 인자를 그대로 넘기고 exit code를 그대로 돌려주는 얇은 wrapper다
(`loopctl.cmd` · `loopctl`). Runtime 로직은 들어 있지 않다.

Worker · Gate · Verifier는 **각각 명시적으로 호출한다.** 자동 연결은 아직 없다.

```text
loopctl run <TASK>       Worker 1회      (AI 호출)
loopctl gate <TASK>      결정론적 Gate   (AI 호출 없음)
loopctl verify <TASK>    독립 Verifier   (AI 호출)  -> PASS면 Runtime이 DONE으로 전이

실패하면:
loopctl diagnose <TASK>  결정론적 진단   (AI 호출 없음)
loopctl retry <TASK>     Worker 재시도 1회 (AI 호출) -> REVIEW. Gate/Verifier는 다시 직접 호출한다.

또는 전부 자동으로:
loopctl execute <TASK>   Worker -> Gate -> Verifier -> Diagnose -> Retry 를 정지 조건까지

Task 자체가 없으면 먼저:
loopctl plan "<GOAL>"        Goal -> Task 제안  (AI 호출 1회 · Task를 만들지 않는다)
loopctl plan-show <PLAN>     검토             (AI 호출 없음)
loopctl plan-approve <PLAN>  승인 -> Task 생성 (AI 호출 없음 · 실행하지 않는다)
```

`loopctl status` · `help` · `tasks` · `ready` · `verify-ready` · `gates` · `usage` ·
`verification` · `diagnose` · `execution` · `validate` · `version` ·
`plans` · `plan-show` · `plan-approve`는 **AI를 호출하지 않는다.**

Run ID가 정본이다. Task ID는 Runtime이 결정론적으로 해석할 수 있을 때만 쓰는 편의 입력이며,
해석되면 선택된 Run을 출력한다:

```text
Task: TASK-001
Resolved Run: RUN-20260826T...  (latest completed worker run)
```

exit code:

```text
0  성공 / 요청한 검사 통과
1  명령은 실행됐지만 요청한 작업이 실패하거나 거부됨 (Gate FAIL · Verifier FAIL · Task 없음 ...)
2  잘못된 CLI 사용법 (알 수 없는 명령 · 인자 누락 · 알 수 없는 옵션)
```

예상 가능한 운영자 실수에는 stack trace를 보이지 않는다.
진짜 Runtime 버그는 `LOOPCTL_DEBUG=1`로 전체 stack을 볼 수 있다.

## 왜 여기인가

- 애플리케이션 소스는 `src/` (Vite 관례)에 들어간다. Runtime은 제품 코드가 아니므로 `tools/` 아래에 둔다.
- 프로젝트가 Node + TypeScript 스택을 전제하므로 Runtime도 Node로 구현한다.
- 아직 `package.json`이 없으므로 **의존성 없는 Node ESM(.mjs)** 으로 시작한다.
  앱 scaffold 후 TS 툴체인이 생기면 그때 옮긴다. 지금 빌드 단계를 만들지 않는다.

## 구조

```text
loopctl.cmd          Windows 진입점 (얇은 wrapper, Runtime 로직 없음)
loopctl              POSIX 진입점 (얇은 wrapper, Runtime 로직 없음)
tools/loop-runtime/
loopctl.mjs          CLI. 명령 dispatch와 출력만 담당한다.
task-store.mjs       Task 로드 · 검증 · 상태 쓰기 (Task 파일의 유일한 Writer)
transitions.mjs      V0 상태 기계. 여기 없는 전이는 존재하지 않는다.
context-builder.mjs  Worker Context 구성 + Run snapshot 생성
config.mjs           .loop/project.yaml 읽기
yaml-lite.mjs        Task YAML용 최소 파서 (의존성 없음, 모르는 문법은 에러)
subject.mjs          Verification Subject Fingerprint (Gate·Verifier 공용, LLM 없음)
adapters/
  index.mjs          Provider Adapter 레지스트리 (detect / runWorker / runVerifier)
  claude.mjs         Claude Code CLI 어댑터 (Worker + Verifier 모두 구현됨)
  codex.mjs          자리만 있음 — 이 환경에서 codex CLI가 실행되지 않아 미구현
  mock.mjs           Runtime 테스트용 test double (LLM 호출 없음)
worker/
  runner.mjs         Worker 1회 실행 · 보호 파일 무결성 검사 · Runtime Envelope 작성
  policy.mjs         Worker 권한 경계 한 곳 — deny 규칙 · fingerprint 예외 · self-check allow
  result.mjs         Worker Result 계약과 검증
  telemetry.mjs      Runtime이 관찰한 사용량 (LLM 호출 없음)
gate/
  resolver.mjs       Gate 설정 로드 · Task별 필수 Gate 계산 · 참조 검증
  runner.mjs         Run 해석 · 실행 자격 검사 · subprocess 실행 · VERIFY_READY 파생
  self-check.mjs     Worker용 참고 실행 — 설정된 Gate 명령만, Report를 만들지 않는다
  report.mjs         Gate Report 구성 · 저장 · 재실행 시 이전 증거 보존
verifier/
  runner.mjs         자격 검사 · 독립 Verifier 1회 실행 · 읽기 전용 무결성 검사 · Envelope
  result.mjs         Verifier Result 계약 · 구조화 출력 스키마 · 결정론적 검증
  context-builder.mjs  Verifier Snapshot (Worker context를 재사용하지 않는다)
  canonical-diff.mjs   결정론적 변경 표현 (유계, git 기반)
  report.mjs         Runtime이 쓰는 최종 Verification Report
recovery/
  diagnose.mjs       결정론적 실패 분류 (LLM 호출 없음)
  failure-memo.mjs   실패를 유계 lesson으로 증류
  retry.mjs          재시도 자격 · lineage · 재시도 Snapshot
  limits.mjs         재시도 예산 (policies/limits.yaml 하나에서만 온다)
stages.mjs           단계 실행의 단일 진입점 — 수동 CLI와 자동 루프가 같이 쓴다
loop/
  orchestrator.mjs   Task 하나를 정지 조건까지 자동 실행 · 활성 표식 heartbeat
  plan-executor.mjs  승인된 Plan의 Task를 한 번에 하나씩 (결정론적 · 추가 LLM 호출 없음)
  reconcile.mjs      사람이 CLI로 끝낸 복구를 Execution Report로 기록
  next-action.mjs    다음 합법 행동 결정 (결정론적) · 정체 감지
  stop-evaluator.mjs 정지 판단을 한 곳에 모은다
  execution-report.mjs  Execution ID · 실행 보고서 · 사용량 요약 · 활성 표식 판정
planner/
  runner.mjs         Planner 1회 실행 · 읽기 전용 무결성 검사 · Planner Envelope
  result.mjs         Planner Result 계약 · 구조화 출력 스키마 · Planner 규약
  validator.mjs      Plan에 대한 결정론적 검증 (기존 validateTask를 그대로 재사용)
  graph.mjs          제안 의존 그래프 검증 · 위상 정렬 (LLM 없음)
  context-builder.mjs  Planner Snapshot (Worker/Verifier context를 재사용하지 않는다)
  store.mjs          Plan artifact 위치 · Plan ID 발급 · 목록/해석
  report.mjs         Runtime이 쓰는 Plan Report — Plan에 대한 정본
  approval.mjs       승인 -> canonical Task 생성 (AI 호출 없음)
  task-yaml.mjs      Task YAML 직렬화 + 재파싱 왕복 검증
test/
  fixture.mjs        임시 git 프로젝트 발판 (mock adapter 전용)
  planner.test.mjs · dependencies.test.mjs · regression.test.mjs
```

`stages.mjs`가 있는 이유: `loopctl run/gate/verify/retry`와 오케스트레이터가 **같은 함수**를 부르게
하기 위해서다. 오케스트레이터는 CLI를 subprocess로 띄우지 않고, 단계 로직을 다시 구현하지도 않는다.

`adapters/`가 `worker/` 밖에 있는 이유: Worker와 Verifier 두 단계가 같은 provider 어댑터를
쓰기 때문이다. 같은 어댑터를 쓰더라도 **항상 별개의 invocation**이며 세션을 공유하지 않는다.

## 명령

`loopctl help`가 실제 구현된 명령을 전부 보여준다.

```bash
./loopctl status                 # 전체 상태 요약 (읽기 전용 · AI 호출 없음)
./loopctl doctor                 # 구조 점검
./loopctl tasks                  # id · 저장된 status · request
./loopctl show TASK-001          # 정규화된 Task 정보
./loopctl ready                  # Worker 실행 준비된 Task (파생 상태)
./loopctl verify-ready           # Verifier 대기 목록 (파생 상태)
./loopctl gates                  # project.yaml Gate 설정 (실행 안 함)
./loopctl adapters               # Provider Adapter 사용 가능 여부

./loopctl run TASK-001           # Worker 1회 실행       --adapter --timeout --model
./loopctl gate TASK-001          # 결정론적 Gate 실행     --rerun
./loopctl verify TASK-001        # 독립 Verifier 1회 실행 --rerun --adapter --model --timeout
./loopctl retry TASK-001         # 진단 기반 Worker 재시도 1회
./loopctl execute TASK-001       # DONE 또는 정지 조건까지 자동 실행
./loopctl execute-plan PLAN-...  # 승인된 Plan의 Task를 한 번에 하나씩 순차 실행
./loopctl self-check [build ...] # 설정된 Gate 명령만 참고용으로 실행 (판정 아님)

./loopctl diagnose TASK-001      # 실패 진단 + Failure Memo (AI 호출 없음)
./loopctl execution TASK-001     # 기록된 Execution Report
./loopctl usage RUN-...          # 기록된 Worker telemetry
./loopctl verification RUN-...   # 기록된 Verification Report

./loopctl validate               # Task 전체 검증 (실패 시 exit 1)
./loopctl transition TASK-001 IN_PROGRESS
./loopctl context TASK-001       # Worker Context를 stdout에
./loopctl snapshot TASK-001      # .loop-local/runs/ 에 Run snapshot
./loopctl help                   # 도움말
./loopctl version                # Runtime 버전
```

`gate` · `verify` · `usage` · `verification`은 `RUN-...`과 `TASK-...`을 모두 받는다.
Task ID는 편의 입력일 뿐이고, 산출물은 언제나 정본 Run ID 아래에만 만들어진다.

## 지켜지는 원칙

- **Single Writer** — Task 파일을 쓰는 코드는 `task-store.writeStatus()` 하나뿐이고,
  그 안에서 `transitions.checkTransition()`을 반드시 통과해야 한다. 우회 경로는 없다.
  전이가 거부되면 파일은 **전혀 수정되지 않는다.**
- **READY는 저장되지 않는다** — Runtime이 매번 계산하는 파생 상태다.
  (status == TODO · 예제 아님 · 구조적으로 유효 · `auto_dispatch != false` · PAUSE 없음)
- **조용한 복구 금지** — 잘못된 Task는 고치지 않고 사람이 읽을 수 있는 에러로 보고한다.
  유효하지 않은 Task에는 `show` · `transition` · `context` · `snapshot` 모두 거부된다.
- **Context 최소화** — Context에 들어가는 것은 KERNEL · Role Skill · Task · AC · Failure Memo뿐이다.
  DESIGN.md · 다른 Task · 무관한 Evidence · 세션 기록 · Runtime 소스는 들어가지 않는다.
- **상태 쓰기는 원자적** — temp 파일 + rename. `status:` 한 줄만 바꾸므로 주석과 서식이 보존된다.

## Acceptance Criteria 스키마

모든 AC는 **구체적인 판정 방법**을 가져야 한다. 판정 방법이 없는 AC를 가진 Task는
검증 실패로 처리되어 dispatch되지 않는다.

```yaml
acceptance_criteria:
  - id: AC1
    description: Example deterministic criterion
    verification:
      type: gate          # 결정론적 판정
      ref: example_gate   # gate일 때 필수

  - id: AC2
    description: Example reasoning-based criterion
    verification:
      type: verifier      # 독립적인 판단이 필요
      instruction: >      # 선택. description만으로 판정 가능하면 생략한다.
        Inspect the canonical diff and evidence and determine whether
        this criterion is satisfied.
```

V0가 지원하는 `verification.type`은 `gate`와 `verifier` 둘뿐이다.
`human` · 복합식(AND/OR) · threshold는 아직 없다. 알 수 없는 type은 거부된다.
`ref`는 `gate`에서만, `instruction`은 `verifier`에서만 허용된다.

## Worker 실행

```text
Load Task -> Validate -> 실행 가능 확인 -> TODO->IN_PROGRESS -> Snapshot
-> 보호 파일 해시 기록 -> Worker 실행 -> 프로세스 지표 수집 -> provider 사용량 수집
-> Worker Result 검증 -> 무결성 재확인 -> 변경 파일 관찰 -> Runtime Envelope 기록
-> 요청된 전이 검증 -> IN_PROGRESS -> REVIEW | BLOCKED
```

Run 디렉터리(`.loop-local/runs/RUN-.../`):

```text
context.md            불변 snapshot (Worker 입력)
manifest.json         snapshot 해시
worker-result.json    Worker의 주장
runtime-envelope.json Runtime이 관찰한 사실 + telemetry
stdout.log stderr.log 진단용. 다음 Run의 Context에 넣지 않는다.
```

- **Worker 성공 != Task 완료.** impl Worker가 요청할 수 있는 최대치는 `REVIEW`다.
  `DONE`은 어떤 경우에도 Worker가 요청할 수 없고, Gate + Verifier 단계에서만 도달한다.
- **주장과 관찰을 분리한다.** `changed_files`는 Worker의 주장이고,
  `observed_changes`는 Runtime이 read-only git으로 직접 관찰한 것이다.
- **Runtime 소유 파일 보호** — `.loop/` 전체(단 `.loop/evidence/` 제외)를 Run 전후로 해시 비교한다.
  하나라도 바뀌면 policy violation이고, Worker Result가 유효해도 전이를 적용하지 않는다.
- **실패 시 전이 없음** — launch 실패 · timeout · 비정상 종료 · result 누락/불량 · 무결성 위반은
  모두 명시적으로 보고하고 Task를 IN_PROGRESS에 남긴다. 자동 재시도는 하지 않는다.
- **Telemetry는 Context에 들어가지 않는다.** 토큰·비용·duration은 Envelope에만 기록한다.
  provider가 사용량을 노출하지 않으면 `tokens: { "source": "unavailable" }`로 남기고 추정하지 않는다.

설정(`.loop/project.yaml`):

```yaml
runtime:
  worker_adapter: claude
  worker_timeout_seconds: 900
  worker_model: null
```

## Gate 실행 (결정론적 검증 층)

```text
Worker -> REVIEW -> Gate Runner -> build · lint · test · Task별 Gate -> PASS / FAIL
```

`loopctl gate`는 **LLM을 호출하지 않는다.** 판정 근거는 프로세스 사실(exit code · signal · timeout)뿐이며,
테스트 출력을 모델에게 해석시키지 않는다. Gate 실행 비용은 토큰이 아니라 시간과 프로세스다.

### Gate 설정 — Runtime 소유

Gate 명령은 `.loop/project.yaml`에만 존재한다. Worker Result · Worker stdout · Task 서술 ·
AC description에서 온 문자열은 **절대 실행되지 않는다**. Worker는 Gate 명령을 바꿀 수 없다.

```yaml
runtime:
  gate_timeout_seconds: 300   # 기본 timeout

gates:
  build:
    enabled: true
    command: npm run build
    timeout_seconds: 600      # 선택. 이 Gate만 덮어쓴다.
    cwd: packages/app         # 선택. 루트 기준 상대경로이며 루트 밖은 거부된다.
  test:
    enabled: false
    command: null
    reason: "package.json 없음 - test script 미정의"
```

현재 이 repository에는 실제 build/lint/test 명령이 없다. 세 Gate는 `enabled: false`로 남아 있으며
없는 명령을 추정해서 채우지 않는다. Gate 층 검증은 임시 fixture로 수행하고 fixture는 제거한다.

### 필수 Gate 계산

```text
required = stop_condition.gates  ∪  acceptance_criteria[].verification.ref (type == gate)
```

중복은 제거하되 최초 등장 순서를 유지한다(stop_condition 먼저, 그다음 AC 순서).
`project.yaml`의 모든 Gate를 실행하지 않는다. **Task가 요구한 것만** 실행한다.

참조가 설정에 없으면 조용히 무시하지도, Verifier 기준으로 강등하지도 않는다:

```text
TASK-001: unknown gate reference "conversion_test" (from acceptance_criteria.AC1; configured: build, lint, test)
```

이 검사는 `validate` · `doctor` · Gate 실행 preflight 셋 다에서 수행된다.
예제 Task는 실행 대상이 아니므로 참조 해석을 요구하지 않는다.

### 실행 자격

Gate는 **완료된 Worker Run 하나**에 귀속된다. Task ID가 아니라 Run ID가 정본이다.
`gate TASK-001`은 편의 경로이며, 그 Task의 최신 완료 Run을 결정론적으로 고른다
(run id의 timestamp 접두사가 사전식 정렬 = 시간순, 같은 초는 `-2` 접미사로 갈린다).

전부 만족해야 실행된다:

```text
Task가 구조적으로 유효  ·  예제 Task가 아님  ·  status == REVIEW
Run 디렉터리와 manifest가 읽힘  ·  manifest.task_id == Task
runtime-envelope.json 존재 · run_id/task_id 일치
worker-result.json이 다시 검증해도 유효   (Envelope의 기록을 그대로 믿지 않는다)
policy_violation 없음  ·  필수 Gate 참조가 전부 resolve됨
```

Gate 실행은 새 Worker Run을 만들지 않고, Worker를 다시 부르지 않으며, Task 상태를 쓰지 않는다.

### Gate 상태 모델

```text
PASS     명령이 실행되어 exit code 0
FAIL     명령이 정상 실행되어 non-zero 종료
ERROR    Runtime이 Gate를 올바르게 기동/실행할 수 없었다
         (비활성 Gate · command 없음 · cwd 없음 · spawn 실패 · artifact 기록 실패)
TIMEOUT  설정된 timeout 초과
```

Gate Run 전체는 **모든 필수 Gate가 PASS일 때만** `PASS`다. 그 밖은 전부 `FAIL`이다.

- 비활성(`enabled: false`) Gate를 Task가 요구하면 `ERROR`다. PASS를 지어내지 않는다.
- Gate 하나가 실패해도 **나머지 필수 Gate를 모두 실행한다.** 한 번의 실행으로 완전한 진단을 얻기 위해서다.
- 순차 실행이다. 병렬 Gate는 아직 없다.
- timeout은 process group 전체를 SIGTERM -> SIGKILL로 정리한다(shell이 만든 손자까지).
  timeout된 Gate를 자동으로 재시도하지 않는다.

### Gate 증거와 Report

Gate 산출물은 Runtime이 만든 정본이다. Worker가 쓸 수 있는 `.loop/evidence/`와 분리해서 Run 디렉터리에 둔다.
Worker가 신고한 evidence 경로는 Gate PASS의 근거가 되지 않는다.

```text
.loop-local/runs/RUN-.../
  context.md  manifest.json  worker-result.json  runtime-envelope.json   <- Worker 층
  gates/<name>/stdout.log  stderr.log  result.json                       <- Gate 층 (정본)
  gate-report.json
  gate-history/<n>/...                                                   <- --rerun 시 보존
```

`gate-report.json` 주요 필드:

```text
schema · run_id · task_id · attempt
started_at · finished_at · duration_ms
required_gates[]              이 Task가 요구한 Gate (실행 순서)
gate_sources{}                각 Gate가 어디서 요구됐는지 (stop_condition / AC id)
no_gates_required             "요구된 Gate 없음"과 "Gate 설정 없음"을 구분한다
configured_gates[]            project.yaml에 설정된 Gate 목록
result                        PASS | FAIL
gates[]                       name · status · command · cwd · enabled · 시각 · duration_ms
                              exit_code · signal · timed_out · timeout_seconds
                              stdout_bytes · stderr_bytes · 로그 경로 · 로그 sha256 · error
acceptance_criteria[]         gate 타입 AC -> 참조 Gate의 상태 그대로
                              verifier 타입 AC -> DEFERRED_TO_VERIFIER
telemetry{}                   total_duration_ms · gate_duration_ms_total · gate_count
                              pass/fail/error/timeout_count · stdout/stderr_bytes_total
                              llm_calls: 0 · llm_tokens: 0
runtime{}                     platform · node · shell · executed_by
```

Worker의 self-evaluation은 들어가지 않는다. Verifier 출력도 없다(아직 존재하지 않는다).
Gate 결과는 telemetry라서가 아니라 **검증 사실**이라서 나중에 Verifier에게 전달된다.
Worker 사용량(토큰·비용)과 Gate 사용량(프로세스·시간)은 끝까지 분리해서 기록한다.

### 재실행

이미 만들어진 `gate-report.json`은 조용히 덮어쓰지 않는다. 기본은 거부다.

```bash
loopctl gate RUN-... --rerun     # 이전 증거를 gate-history/<n>/ 으로 옮긴 뒤 다시 실행
```

### Gate 이후 Task 상태

```text
Gate PASS -> Task는 REVIEW 그대로. Verifier 단계로 갈 자격이 생겼다는 뜻일 뿐이다.
Gate FAIL -> Task는 REVIEW 그대로. 검증이 성공하지 않았고 Verifier는 아직 자격이 없다.
```

Gate는 새 persisted 상태를 만들지 않는다. `DONE`으로 바꾸지 않고,
실패해도 자동으로 `IN_PROGRESS`로 되돌리지 않는다(retry/rework 루프가 아직 없다).

### VERIFY_READY (파생 상태, 저장되지 않는다)

```bash
loopctl verify-ready
# TASK-001     RUN-20260826T...-TASK-001     REVIEW   GATES PASS
# 없으면: No tasks ready for verifier.
```

조건: `status == REVIEW` · Worker Result 유효 · policy violation 없음 ·
현재 필수 Gate 집합에 대한 정본 Gate Report 존재(집합이 바뀌었으면 stale) ·
전체 결과 PASS · 그 Task가 Verifier 판정을 필요로 함.
Task YAML에 기록되지 않으며, 이 명령도 LLM을 호출하지 않는다.

## 독립 Verifier (판단 기반 검증 층)

```text
Worker -> REVIEW -> Gate PASS -> Independent Verifier -> PASS -> DONE
                                                      -> FAIL -> REVIEW 유지
```

### 독립성은 Input 분리에서 나온다

Verifier는 Worker의 서사를 **받지 않는다.** 세션을 새로 여는 것만으로는 독립이 아니다.

Verifier Snapshot(`verification/context.md`)에 들어가는 것:

```text
--- VERIFIER CONTRACT ---     .loop/skills/verifier.md
--- TASK ---                  request · stop_condition
--- ACCEPTANCE CRITERIA ---   gate AC는 사실로, verifier AC는 판정 대상으로
--- CANONICAL DIFF ---        변경 파일 manifest + unified patch
--- GATE RESULTS ---          Gate Report의 결정론적 사실
--- EVIDENCE ---              Runtime 정본 artifact + Worker 주장(라벨 분리)
--- RUNTIME FACTS ---         Run/Task 식별자 · 프로세스 사실 · 관찰된 변경 파일 · subject
```

들어가지 **않는** 것 (테스트가 이 목록을 그대로 검사한다):

```text
Worker summary · self-evaluation · progress narrative · stdout/stderr
Worker requested_transition · 이전 세션 기록 · 대화 transcript
KERNEL.md(Worker 계약) · DESIGN.md · 다른 Task
```

Worker Result가 구조적으로 유효했다는 **사실**은 Runtime Fact로 전달되지만,
Worker가 쓴 문장은 한 줄도 복사되지 않는다.

### Verification Subject Fingerprint

Gate와 Verifier가 **같은 저장소 상태**를 봤다는 것을 증명하는 결정론적 값이다.

```text
sha256( HEAD commit + git이 보고하는 변경/미추적 파일의 (경로, 상태, 내용 sha256, 크기) )
```

- gitignore된 것(빌드 캐시·의존성)은 git이 이미 제외한다.
- `.loop-local/`은 Runtime 자신의 Run 산출물이므로 명시적으로 제외한다.
  Gate Report를 쓰는 행위가 검증 대상을 바꾸면 안 된다.
- LLM은 이 계산에 관여하지 않는다.

Gate Report는 자신이 실제로 검사한 subject를 `verification_subject`에 기록한다.
Verifier는 실행 **전에** 현재 subject와 대조하고, 다르면 AI를 띄우기 전에 거부한다:

```text
Gate Report is not bound to the current repository state.
Run Gates again for this Worker Run.
```

실행 **후에도** 다시 대조한다. 검증 도중 저장소가 바뀌었으면 `STALE_VERIFICATION_SUBJECT`로
결과를 쓰지 않고 Task를 REVIEW에 남긴다.

> **V0의 의도된 엄격함:** subject는 저장소 전체다. 작업 트리가 하나뿐이고 worktree/staging이
> 아직 없으므로, 다른 Task의 Worker가 트리를 건드리면 대기 중인 Gate 결과는 실제로 신뢰할 수 없다.
> 그래서 관련 없어 보이는 변경도 pending 검증을 무효화한다. `verify-ready`는 이런 항목을
> 감추지 않고 `STALE — rerun gates`로 표시한다. Worktree 격리가 생기면 완화된다.

### Canonical Diff

범위는 **Runtime이 관찰한 변경 파일**(Runtime Envelope의 `observed_changes`)이다.
Worker가 신고한 `changed_files`는 진실의 근거가 아니라 대조 대상이며, 관찰되지 않은 주장 경로는
`provenance: worker-claimed-only`로 표시해서 함께 싣는다.

- 추적 중인 파일: `git diff HEAD -- <path>`
- 미추적 신규 파일: Runtime이 생성한 결정론적 unified patch (`/dev/null` 임시파일에 의존하지 않음)
- 파일당 64 KB · 전체 512 KB 상한. 초과분과 바이너리는 경로/크기/sha256 manifest로만 표현한다.
- Verifier는 참조된 파일을 읽기 전용으로 직접 확인할 수 있다.

### Verifier 실행 자격

AI를 띄우기 전에 전부 확인한다. 하나라도 실패하면 호출하지 않는다.

```text
Task 유효 · 예제 아님 · status == REVIEW
Worker Run 존재 · Worker Result 재검증 통과 · Envelope 일치 · policy violation 없음
Gate Report 존재 · Run/Task 일치 · 필수 Gate 집합 일치 · 전체 결과 PASS
Gate Report가 현재 subject에 묶여 있음
Task가 실제로 독립 검증을 요구함 (requires_verifier 또는 verifier 타입 AC)
```

Gate가 FAIL/ERROR/TIMEOUT이면 Verifier는 호출되지 않는다. Worker를 다시 부르지도 않는다.

### 읽기 전용 Verifier

Verifier는 감사자이지 구현자가 아니다. Worker보다 엄격하다.

- 설치된 CLI에서 실제로 확인한 옵션만 쓴다:
  `--tools Read,Grep,Glob` (built-in tool 집합 자체를 제한) +
  `--disallowedTools Edit Write NotebookEdit Bash WebFetch WebSearch` + `--settings`의 deny 규칙.
- `--no-session-persistence`로 항상 새 세션이다. Worker의 session_id를 넘기지 않는다.
- 결과는 **파일이 아니라 구조화 출력**(`--json-schema` -> payload의 `structured_output`)으로 받는다.
  Verifier에게 쓰기 권한을 주지 않기 위해서다. 대화 텍스트는 판정으로 인정되지 않는다.
- provider의 sandbox를 믿지 않고 Runtime이 직접 확인한다:
  실행 전후로 `.loop/` **전체**(evidence 예외 없음)의 해시와 subject fingerprint를 대조한다.
  하나라도 바뀌면 `verifier_policy_violation: true`이고 결과를 쓰지 않는다.

### Verifier Result 계약

```json
{
  "run_id": "RUN-...", "task_id": "TASK-001",
  "verification_subject_sha256": "...",
  "result": "PASS | FAIL",
  "criteria": [{ "id": "AC2", "status": "PASS | FAIL", "reason": "..." }],
  "failed_criteria": [],
  "reason": "..."
}
```

전이 요청 필드는 **존재하지 않는다.** Verifier는 완료를 요청할 수 없다.

결정론적으로 거부되는 것: malformed · 구조화 출력 없음 · run_id/task_id/subject 불일치 ·
지원하지 않는 result/status · verifier AC 누락 · 중복 · 알 수 없는 AC ·
**gate AC를 verifier가 판정했다고 주장** · FAIL AC가 있는데 PASS · `failed_criteria` 불일치 ·
빈 reason. 잘못된 출력을 추측으로 고치지 않는다.

개별 AC가 전부 PASS인데 `result: FAIL`인 경우는 전역 사유(범위 밖 변경·테스트 약화)로 인정하고
`verifier_global_failure: true`로 기록한다.

### Verification Report — 완료 판정의 정본

`verification/verification-report.json`은 **Runtime이** 쓴다.
Verifier의 `result: "PASS"` 한 필드를 그대로 믿지 않는다.

```text
result == PASS  <=>  아래가 전부 참
  Gate Report가 PASS
  모든 gate AC가 PASS (Gate Report 출처)
  Verifier Result가 유효
  모든 verifier AC가 PASS (Verifier Result 출처)
  Verifier 프로세스가 정상 종료 (launch 실패·timeout·non-zero exit 아님)
  Worker policy violation 없음
  Verifier policy violation 없음
  subject가 실행 전후로 동일
```

한 AC의 판정 출처는 하나뿐이다. Gate가 판정한 AC는 Gate Report에서, Verifier가 판정한 AC는
Verifier Result에서 온다. 어느 쪽도 상대의 영역을 덮어쓰지 않는다.

### Run 디렉터리 (Verifier 산출물)

```text
.loop-local/runs/RUN-.../
  context.md manifest.json worker-result.json runtime-envelope.json   <- Worker 층
  gates/... gate-report.json                                          <- Gate 층
  verification/
    context.md                Verifier Snapshot (Worker context 재사용 안 함)
    manifest.json             snapshot 해시 · 포함 섹션 · 제외 목록
    subject.json              subject fingerprint + canonical diff manifest
    canonical-diff.patch      결정론적 변경 표현
    verifier-result.json      Verifier가 돌려준 원본 + 검증 결과 + 정규화본
    verifier-envelope.json    Runtime이 관찰한 사실 + Verifier telemetry
    verification-report.json  Runtime이 쓴 최종 판정 (정본)
    stdout.log stderr.log     진단용. 판정 근거가 아니다.
    history/<n>/...           --rerun 시 이전 검증 전체를 보존
```

### DONE 전이

```text
Gate PASS -> 새 Verifier invocation -> 유효한 Verifier PASS -> subject 불변
-> Runtime Verification Report PASS -> transitions 표 검증 -> Runtime이 REVIEW -> DONE
```

- Verifier는 Task YAML을 절대 쓰지 않는다. `verifier/` 어디에도 `writeStatus` 호출이 없다.
- 전이를 실행하는 코드는 `loopctl`의 단 한 줄이며, 그 전에 Report가 PASS여야 한다.
- Verifier FAIL이면 Task는 REVIEW에 남는다. 자동으로 IN_PROGRESS로 돌리지 않고 재시도하지 않는다.

### 중복 검증

Verifier 호출은 토큰을 쓴다. 암묵적으로 다시 돌리지 않는다.

```bash
loopctl verify RUN-... --rerun   # 이전 검증 전체를 verification/history/<n>/ 로 보존한 뒤 재실행
```

### Verifier telemetry

Worker/Gate/Verifier 사용량은 끝까지 분리해서 기록한다. 단계 간 비용 합산은 아직 하지 않는다.

```text
Worker Usage    -> LLM 토큰/비용 (runtime-envelope.json)
Gate Usage      -> 프로세스/시간, llm_calls: 0 (gate-report.json)
Verifier Usage  -> LLM 토큰/비용 (verifier-envelope.json)
```

`verifier-envelope.json`의 `usage`: `context{bytes,characters,lines}` ·
`process_output{stdout_bytes,stderr_bytes}` · `tokens{source,...}` · `adapter` · `model` ·
`provider_cost_usd` · `verifier_attempt_number`.

설치된 Claude Code CLI(2.1.246)는 `--output-format json`에서 실제로 다음을 노출한다:
`input_tokens` · `output_tokens` · `cache_read_input_tokens` · `cache_creation_input_tokens` ·
`total_cost_usd` · `modelUsage`(실제 모델 이름). 노출되지 않는 값은 만들지 않는다 —
provider가 사용량을 주지 않으면 `tokens: { "source": "unavailable" }`로 남기고 추정하지 않는다.
합계(`total`)도 CLI가 주지 않으면 합성하지 않는다.

## Diagnose · Failure Memo · Retry

```text
Worker #1 -> Gate 또는 Verifier 실패 -> Diagnose -> Failure Memo -> (운영자) retry -> Worker #2 -> REVIEW
```

**Retry != Loop.** 실패를 분류하고 다음 Attempt가 받을 정보를 바꾼 뒤에만 다시 실행한다.
진단 없는 재시도는 자동화가 아니라 비용이다.

### Diagnose는 결정론적이다

"왜 실패했는가"를 모델에게 묻지 않는다. Runtime이 이미 기록해 둔 사실만 본다:
Runtime Envelope · Gate Report · Verification Report. **LLM 호출 0회, 토큰 0.**

실패 분류(관찰 가능한 것만. 종류를 늘리지 않는다):

```text
PROCESS_CRASH · TIMEOUT · SCHEMA_FAILURE · GATE_FAILURE · VERIFY_FAILED
PERMISSION_DENIED · POLICY_VIOLATION · STALE_VERIFICATION_SUBJECT · RECOVERY_AMBIGUOUS
```

권고 action(V0에서 실제 Worker 재시도로 이어지는 것은 앞의 둘뿐이다):

```text
RETRY · RETRY_WITH_HINT · RERUN_GATES · REPLAN_REQUIRED · NEEDS_HUMAN · NO_ACTION
```

단계별 매핑:

```text
worker  프로세스 비정상 종료      -> PROCESS_CRASH            RETRY
worker  timeout                   -> TIMEOUT                  RETRY_WITH_HINT
worker  Result 누락/불량          -> SCHEMA_FAILURE           RETRY_WITH_HINT
worker  .loop 변경                -> POLICY_VIOLATION         NEEDS_HUMAN

gate    정상 실행 후 non-zero     -> GATE_FAILURE             RETRY_WITH_HINT
gate    ERROR (설정/환경 문제)    -> RECOVERY_AMBIGUOUS       NEEDS_HUMAN
gate    TIMEOUT (모호함)          -> TIMEOUT                  NEEDS_HUMAN

verifier  AC 불충족               -> VERIFY_FAILED            RETRY_WITH_HINT
verifier  Result 불량/사고/timeout -> SCHEMA_FAILURE 등        NEEDS_HUMAN  (verify --rerun 쪽)
verifier  검증 중 트리 변경        -> STALE_VERIFICATION_SUBJECT  RERUN_GATES
```

Gate `ERROR`는 구현이 틀렸다는 증거가 아니라 Gate 설정·환경 문제다. Gate `TIMEOUT`은
멈춘 구현과 느린 환경 사이에서 모호하다. 둘 다 보수적으로 사람에게 올린다.
Verifier 쪽 사고(프로세스 실패·timeout·불량 Result)도 구현 재시도의 근거가 아니다.

### Failure Memo는 로그 보관소가 아니다

다음 Attempt가 같은 실패를 반복하지 않는 데 필요한 것만 증류한다.
들어가지 않는 것: 이전 Worker의 요약·자기평가·narrative · stdout/stderr 전문 ·
Gate 로그 전문 · Verifier transcript · 이전 AI 세션 기록.

로그 발췌는 유계다(최대 2 KB · 마지막 20줄). 전문은 Run artifact에 그대로 남아 있다.

**증거 없는 hint를 지어내지 않는다.** 안전하게 뽑을 lesson이 없으면 Memo를 만들지 않고
`NEEDS_HUMAN`으로 간다. 예를 들어 프로세스 crash Memo에는 recovery hint가 없다 —
그 실패에서 구현에 대해 배울 수 있는 것이 없기 때문이다.

### 재시도 안전성 — 저장소 상태

재시도는 실패한 Attempt가 남긴 저장소 상태 위에서만 안전하다.
Worker Envelope도 이제 `verification_subject_before/after`를 기록하므로
Gate 이전 단계 실패에도 권위 있는 기준이 있다.

```text
현재 subject != 실패한 Attempt의 subject   ->  RECOVERY_AMBIGUOUS, 재시도 거부
권위 있는 subject 자체가 없음              ->  RECOVERY_AMBIGUOUS, 재시도 거부 (fail-closed)
```

자동 rollback이나 변경 폐기는 하지 않는다. 추측하지 않는다.

### 재시도 예산

정책은 `.loop/policies/limits.yaml` **한 곳**에서만 온다
(project.yaml의 중복 `limits:` 블록은 제거했다).

```yaml
stop:
  max_attempts: 3            # Task당 총 Worker Attempt
  max_consecutive_failures: 2
escalation:
  retry_max: 1               # 평범한 재시도(transient)
  hint_retry_max: 1          # Failure Memo를 주입한 재시도
  then: needs-human
```

사다리: `attempt 1` -> `RETRY` 1회 -> `RETRY_WITH_HINT` 1회 -> needs-human.
Task가 `stop_condition.max_consecutive_failures`를 직접 정하면 그것이 우선한다.
예산을 넘기면 조용히 초과하지 않고 거부한다.

### Attempt와 lineage

Attempt 번호는 Runtime이 소유한다. Worker가 신고한 값을 믿지 않는다.
provider session id는 lineage가 아니다 — Runtime Run ID만 쓴다.

```json
"attempt": 2,
"lineage": {
  "root_run_id": "RUN-FIRST",
  "parent_run_id": "RUN-FAILED",
  "retry_reason": "GATE_FAILURE",
  "retry_action": "RETRY_WITH_HINT",
  "parent_failure_fingerprint": "...",
  "failure_memo": "RUN-FAILED/recovery/failure-memo.json"
}
```

`failure_fingerprint`는 stage · failure class · 실패한 Gate와 AC id · 정규화된 사유로만
만든다(timestamp도, LLM이 쓴 문장도 넣지 않는다). 같은 실패가 반복되면 같은 값이 나온다.
Step 6에서는 metadata일 뿐이며 Stall Engine은 아직 없다.

### 산출물

```text
.loop-local/runs/RUN-ATTEMPT-1/
  ... worker · gate · verification 산출물 ...
  recovery/
    diagnosis.json          Runtime이 쓴 진단 (llm_calls: 0)
    failure-memo.json       증류된 lesson
    history/<n>/            증거가 달라져 다시 진단했을 때 이전 것을 보존

.loop-local/runs/RUN-ATTEMPT-2/
  context.md manifest.json worker-result.json runtime-envelope.json
```

같은 증거에 대한 진단이 이미 있으면 그대로 재사용한다. 증거가 달라지면 다시 계산하되
이전 것을 지우지 않고 `history/`로 옮긴다.

재시도 Run에 이전 Attempt의 artifact를 복사하지 않는다. lineage로만 연결한다.
**이전 Gate PASS / Verifier PASS는 새 subject에 적용되지 않는다** — 역사적 증거로만 남고,
새 Run은 Gate와 Verifier를 처음부터 다시 통과해야 한다.

### 상태 전이

```text
Gate/Verifier 실패 후 재시도:  REVIEW -> IN_PROGRESS -> (Worker) -> REVIEW
Worker 실패 후 재시도:         IN_PROGRESS 유지 -> (Worker) -> REVIEW
```

기존 전이 표를 그대로 통과한다. 새 저장 상태를 만들지 않고,
`IN_PROGRESS -> TODO -> IN_PROGRESS` 같은 인위적 왕복도 만들지 않는다.

### 격리는 그대로다

- **Verifier에는 Failure Memo를 주입하지 않는다.** Failure Memo는 Worker 회복용 context다.
  이전 실패 서사가 독립 판정을 흔들면 안 된다.
- **Gate는 Failure Memo를 쓰지 않는다.** Gate 명령은 Runtime 소유 설정에서만 온다.
- **Acceptance Criteria는 재시도로 바뀌지 않는다.** Memo는 회복 안내이지 계약 변경이 아니다.
  계약 자체가 틀렸다면 올바른 결론은 `NEEDS_HUMAN`이다.

### 자동 연쇄는 없다

`loopctl retry`는 Worker Attempt를 **정확히 한 번** 실행하고 멈춘다.
Gate도 Verifier도 자동으로 부르지 않고, 다시 재시도하지도 않는다.

## 자동 Task 실행 (Full Loop)

```bash
.\loopctl execute TASK-001
```

Runtime이 알아서 이어 붙인다:

```text
Worker -> Gate -> Verifier -> Diagnose -> Retry -> Gate -> Verifier -> ...
```

멈추는 지점:

```text
DONE · BLOCKED · 한도 소진 · 정체 감지 · 회복 불명확 · 사람 판단 필요 · 중단 · PAUSE
```

Task **하나만** 실행한다. READY Task를 전부 돌리지 않는다(공유 작업 트리라 모호해진다).
승인된 Plan 단위로 이어서 돌리려면 `execute-plan`을 쓴다 — 그것도 한 번에 Task 하나씩이다.
`execute-all` · `auto` · `daemon`은 없다. 낮은 수준 명령은 디버깅·수동 제어용으로 그대로 남아 있다.

### 오케스트레이터는 조합만 한다

단계 로직을 다시 구현하지 않고, CLI를 subprocess로 띄우지도 않는다.
Worker · Gate · Verifier · Diagnose · Retry 전부 기존 모듈(`stages.mjs` · `recovery/`)을 그대로 부른다.
**다음에 뭘 할지도, 멈출지 말지도 전부 결정론적이다 — 오케스트레이션 자체는 토큰을 쓰지 않는다.**

### 상태에서 이어서 시작한다

`execute`는 Task가 항상 TODO에서 시작한다고 가정하지 않는다. 매 단계 전에 디스크에서
Task와 Run artifact를 **다시 읽고** 안전한 지점에서 이어간다.

```text
TODO                          -> 첫 Worker
REVIEW, Gate Report 없음       -> Gate
REVIEW, Gate PASS, verifier 필요 -> Verifier
REVIEW, Gate FAIL             -> Diagnose -> (허용되면) Retry
REVIEW, Verifier FAIL         -> Diagnose -> (허용되면) Retry
IN_PROGRESS, Worker 실패       -> Diagnose -> (허용되면) Retry
IN_PROGRESS, Run 없음          -> STOP_AMBIGUOUS (Worker가 아직 도는지 알 수 없다)
DONE                          -> no-op 성공
BLOCKED                       -> 멈춘다. 자동으로 풀지 않는다.
DROPPED                       -> 실행 거부
```

수동으로 `loopctl run`만 해 둔 Task에 `execute`를 걸면 Worker를 또 띄우지 않고 Gate부터 잇는다.
이미 Gate PASS면 Verifier부터 잇는다. 정본 artifact가 있으면 유료 호출을 다시 하지 않는다.

### 정지 조건

`stop-evaluator.mjs` 한 곳에서만 판단한다. 규칙이 CLI 여기저기 흩어지지 않는다.

```text
INTERRUPTED     운영자 Ctrl+C          (가장 우선)
FAILED          루프 가드 초과
LIMIT_REACHED   --timeout 초과 · 재시도 예산 소진
NEEDS_HUMAN     PAUSE · 비재시도 실패 · 회복 불명확 · gate-only 완료 미구현
DONE            Task 완료
BLOCKED         Task BLOCKED
STALLED         같은 실패 반복
```

실행 결과(Execution Report의 값이며 Task 상태가 아니다):

```text
DONE · BLOCKED · NEEDS_HUMAN · LIMIT_REACHED · STALLED · INTERRUPTED · FAILED
```

`NEEDS_HUMAN` · `STALLED`는 **Task YAML에 저장되지 않는다.** Task는 REVIEW/IN_PROGRESS/BLOCKED 같은
정본 상태에 그대로 남고, 결과는 실행 보고서가 말한다.

### 자동 재시도 규칙

모든 재시도는 기존 결정론적 Diagnose를 반드시 거친다. `Gate FAIL -> 바로 Worker`는 없다.
오케스트레이터가 자기만의 recovery hint를 만들지 않고, 정본 Diagnosis와 Failure Memo를 그대로 쓴다.

자동 재시도는 진단이 `RETRY` 또는 `RETRY_WITH_HINT`를 권고할 때만 한다.
`NEEDS_HUMAN` · `REPLAN_REQUIRED` · `NO_ACTION`은 멈춘다.
`RERUN_GATES`(subject가 흔들림)도 자동으로 Gate를 다시 돌리지 않는다 — 공유 작업 트리에서
그 변화의 출처를 증명할 수 없으므로 fail-closed로 멈춘다.

### 정체 감지 (보수적)

Step 6이 남긴 지문만 쓴다. 확실할 때만 발동한다.

```text
직전 Attempt와 같은 failure_fingerprint
AND 재시도가 저장소 상태를 전혀 바꾸지 못함 (Worker 직후 subject 지문이 동일)
-> STALLED
```

증명할 수 없으면 발동하지 않는다(false positive보다 false negative를 택한다).
attempt 한도가 최종 안전망이다. 의미론적 LLM 비교는 하지 않는다.

### 안전장치

- **루프 가드** — 상태 해석에 버그가 있어도 무한히 돌지 않도록 단계 전이 수를
  `max_attempts * 6 + 10`으로 제한한다. 재시도 정책이 아니라 마지막 방어선이다.
- **`--timeout <seconds>`** — 실행 전체의 상한. Worker/Gate/Verifier 각각의 timeout은
  그대로 독립적으로 유효하다.
- **Ctrl+C** — 새 단계를 예약하지 않는다. 진행 중인 단계는 기존 취소 동작을 그대로 쓰고,
  이미 만들어진 artifact는 지우지 않으며, 성공을 지어내지 않는다. 한 번 더 누르면 즉시 중단한다.
- **PAUSE** — 시작 전이면 거부하고, 도중에 켜지면 다음 유료 단계를 시작하지 않는다.
- **중복 실행 표식** — `.loop-local/executions/active/<TASK>.json`. **Lease가 아니다.**
  살아 있는 프로세스가 잡고 있으면 거부하고, 죽은 프로세스가 남긴 표식만 회수한다.

### Execution Report

```text
.loop-local/executions/EXEC-.../execution-report.json
```

Run artifact를 복사하지 않고 정본 Run을 참조만 한다.

```text
schema · execution_id · task_id · started_at/finished_at/duration_ms
result · stop_reason · final_task_status
attempts[]   attempt · run_id · worker · gate · verifier · diagnosis · action
events[]     stage · run_id · result   (실행 요약이지 Event Journal 프레임워크가 아니다)
usage_summary
loop_guard   limit · stage_transitions
```

사용량 요약은 이미 기록된 단계별 telemetry에서만 모은다:

```text
llm_invocations · worker_invocations · verifier_invocations
gate_invocations            (결정론적 실행. 토큰 0)
provider_cost_usd_known     provider가 실제로 준 값만 더한다
unknown_cost_invocations    비용을 모르는 호출 수를 명시한다
tokens_aggregate            같은 종류의 provider 필드만 더하고 그렇게 표시한다
invocations[]               stage · attempt · run_id · adapter · model · duration · tokens · cost
```

일부 단계에 비용 정보가 없으면 **완전한 달러 총액을 주장하지 않는다.**
없는 토큰 total을 합성하지도 않는다. Budget 강제는 아직 없다.

```bash
.\loopctl execution TASK-001      # 기록된 보고서 조회 (AI 호출 없음, 상태 변경 없음)
```

### Context는 자라지 않는다

자동 반복이 Context를 부풀리지 않는다. 재시도 Worker Context는 여전히
`KERNEL · ROLE · TASK · ACCEPTANCE CRITERIA · FAILURE MEMO`뿐이며,
이전 Attempt의 transcript·stdout·Gate 로그·Verifier transcript는 누적되지 않는다.
Verifier 격리도 그대로다 — **Failure Memo는 Verifier에 절대 들어가지 않는다.**

## Goal Planning (Goal -> Task 제안 -> 승인)

Task를 손으로 쓰는 대신 Goal 하나를 주고 Task 제안을 받는다.

```bat
.\loopctl plan "Add OBJ/STL/GLB conversion and a browser viewer"
.\loopctl plan-show PLAN-...
.\loopctl plan-approve PLAN-...
.\loopctl ready
.\loopctl execute TASK-...
```

**계획은 승인 전까지 Task를 만들지 않는다.**
**승인은 Task를 실행하지 않는다.**

이 두 문장이 이 층의 전부다. 암묵적 승인도, 승인 후 자동 실행도 없다.

### Planner는 State Writer가 아니다

```text
Worker   != State Writer
Verifier != State Writer
Planner  != State Writer

Runtime  = State Writer
```

Planner는 Task 파일을 쓰지 않는다. Task 상태도, Acceptance Criteria도, project.yaml도,
정책도, KERNEL도 건드리지 않는다. 제안(structured proposal)만 돌려준다.

```text
Planner -> planner-result.json
Runtime -> 검증
사람    -> 승인
Runtime -> Task 파일
```

### 읽기 전용 Planner

Planner에게는 `Read` · `Grep` · `Glob` 만 준다. `Edit` · `Write` · `NotebookEdit` ·
`Bash` · `WebFetch` · `WebSearch` 는 tool 집합 제한과 명시적 거부로 **이중으로** 막는다.

Runtime은 실행 전후로 직접 대조한다.

```text
planner subject before == planner subject after
.loop/ 지문 before     == .loop/ 지문 after
```

하나라도 다르면 `planner_policy_violation: true` 이고 그 Plan은 승인할 수 없다.
되돌리지는 않는다 — 자동 rollback은 여전히 범위 밖이다. 바뀐 경로를 정확히 보고한다.

### Planner Snapshot — Worker/Verifier Context를 재사용하지 않는다

```text
--- PLANNER CONTRACT ---     .loop/skills/planner.md
--- GOAL ---                 사람이 준 목표
--- PROJECT FACTS ---        Runtime이 확인한 프로젝트 사실
--- AVAILABLE ROLES ---      실제로 설치된 실행 Role
--- AVAILABLE GATES ---      설정된 Gate와 활성 여부
--- TASK CONTRACT ---        Task/AC 스키마
--- EXISTING TASK SUMMARY -- id | status | request 한 줄씩
--- PLANNING LIMITS ---      Plan 크기 한도
--- RUNTIME FACTS ---        plan_id · subject fingerprint
```

들어가지 않는 것: `DESIGN.md` · `KERNEL.md` · Worker narrative/stdout ·
Verifier narrative · Failure Memo · Run 이력 · Gate 로그 · 이전 Plan 대화 · 세션 기록.

반대 방향도 마찬가지다. **Planner의 서술과 telemetry는 Worker Context에도
Verifier Context에도 절대 들어가지 않는다.** 승인된 Task 계약이 실행의 경계다.

### Plan 검증은 결정론적이다

Planner의 "이 계획은 유효하다"는 선언은 근거가 아니다. Runtime이 다시 본다.

- Plan ID 일치 · 지원되는 result 값 · goal_summary 존재
- `PROPOSED` 는 Task가 있어야 하고, `NEEDS_HUMAN` / `REFUSED` 는 Task가 없어야 한다
- proposal id 형식(`P1` · `P2`)과 중복 · canonical Task ID 사칭 거부
- 실행 Role은 실제 설치된 Role만 (`verifier` · `planner` 는 실행 Role이 아니다)
- Stop Condition · Acceptance Criteria는 **기존 `validateTask()`** 를 그대로 통과해야 한다
- Gate 참조는 설정에 있고 **활성**이어야 한다 — 비활성 Gate에 의존하는 Plan은 승인하지 않는다
- 의존 그래프: 없는 참조 · 자기 참조 · 중복 · 순환 거부 (Kahn 위상 정렬)
- Plan 크기 한도 초과 시 실패 — 조용히 잘라내지 않는다
- Runtime 정책 필드(`retry_max` · `budget` · `model` · `approved` ...)는 금지 필드로 거부

잘못된 Plan을 추측으로 고치지 않는다. 두 번째 AI에게 검토시키지도 않는다.

### 의존 관계 (Task 스키마 확장은 이것 하나뿐)

```yaml
depends_on:
  - TASK-001
```

- canonical Task ID 배열이다. 없으면 `[]` 과 같다 — 기존 Task 파일을 고쳐 쓰지 않는다.
- 자기 참조 · 중복 · 없는 참조 · 순환은 전부 무효다. `validate` 와 `doctor` 가 잡는다.

READY는 여전히 **저장되지 않는 파생 상태**다.

```text
READY = status == TODO
        AND depends_on 이 전부 DONE
        AND 기존 조건 (예제 아님 · 유효 · auto_dispatch · PAUSE 아님)
```

선행 Task가 끝나지 않은 Task는 `TODO` 그대로 남는다. `BLOCKED` 로 바꾸지 않고,
`WAITING` 같은 새 저장 상태도 만들지 않는다.

`run` 과 `execute` 는 같은 판정 함수(`checkDependencies`)를 쓴다.

```text
TASK-002 is not ready.

Waiting on:
  TASK-001
```

### Plan은 저장소 상태에 묶인다

```text
current subject != plan subject  ->  승인 거부
```

```text
Plan approval refused.

Reason:
  PLAN-...: repository state changed since this plan was created.
  Create a fresh plan against the current project state.
```

`--force` 는 없다. 오래된 Plan을 승인하지 않는다. 새로 계획한다.

### 승인이 하는 일 (순서가 곧 안전장치다)

1. Plan artifact 로드
2. Planner Result 유효성 확인
3. 정책 위반 없음 확인
4. `PROPOSED` 인지 확인
5. subject 재계산
6. Plan subject와 대조
7. 결정론적 재검증 (지금의 Runtime 설정 기준)
8. canonical Task ID 발급 — `TASK-001` · `TASK-002` ... (기존 ID·파일과 충돌 회피)
9. 제안 의존 관계를 canonical ID로 치환
10. **완성된 Task 집합 전체를 먼저 검증** (기존 Task를 포함한 그래프까지)
11. 그 다음에야 파일 쓰기 (temp + rename)

새 Task는 `TODO` 로 시작한다. 승인이 만든 매핑은 `approval.json` 에 남는다.

```json
{ "proposal_to_task": { "P1": "TASK-001", "P2": "TASK-002" } }
```

같은 Plan을 두 번 승인해도 Task가 늘지 않는다(멱등). 부분 승인을 성공으로 보고하지 않는다 —
쓰다가 실패하면 되돌리고, 되돌릴 수 있음을 증명하지 못하면 `RECOVERY_AMBIGUOUS` 로
영향받은 파일 경로를 그대로 보고한다.

### Plan artifact

```text
.loop-local/plans/PLAN-.../
  context.md              Planner Snapshot
  manifest.json           snapshot 출처 · 제외 목록 · subject
  planner-result.json     Planner가 돌려준 원본 + 검증 결과 + 정규화본
  planner-envelope.json   Runtime이 관찰한 사실 (프로세스 · 지문 · 사용량)
  plan-report.json        Runtime이 쓰는 정본
  approval.json           승인 후에만 생긴다
  stdout.log · stderr.log
```

`Planner claim != Runtime observation` — 둘을 끝까지 분리해서 저장한다.

Plan은 `.loop/` 가 아니라 `.loop-local/` 에 있다. 계획하는 행위가 검증 대상 저장소 상태를
바꾸면 안 되기 때문이다(subject fingerprint는 `.loop-local/` 을 제외한다).

### 유료 호출은 `plan` 하나뿐

```text
loopctl plan            AI 호출 1회
loopctl plan-show       0
loopctl plans           0
loopctl plan-approve    0
의존 검증 · 순환 탐지 · Task ID 발급   0
```

두 번째 Planner에게 첫 Plan을 비평시키지 않는다. 합의 투표도 없다.
Plan 검증은 결정론적이다.

### 설정

```yaml
# .loop/project.yaml
runtime:
  planner_adapter: claude
  planner_timeout_seconds: 600
  planner_model: null        # null이면 CLI 기본 모델. 실제 값은 Envelope에 기록된다.
```

```yaml
# .loop/policies/limits.yaml
planning:
  max_tasks_per_plan: 12
```

한도는 `limits.yaml` 한 곳에만 둔다. `loopctl plan ... --model <model>` 로 1회 덮어쓸 수 있다.

## PAUSE

`.loop-local/PAUSE` 파일이 있으면 `ready`가 비어서 반환된다. 파일을 지우면 재개된다.

## 테스트

```bash
node --test "tools/loop-runtime/test/*.test.mjs"
```

의존성 없이 `node:test` 만 쓴다. **실제 provider를 부르지 않는다** — adapter는 언제나 mock이다.
자세한 것은 `test/README.md`.

## 아직 구현되지 않은 것 (다음 단계)

`loopctl resume` · Replan/Decompose 실행 · Queue · Lease locking ·
per-Task Worktree 격리 · immutable staging ref · main 병합 ·
Parallel Task 실행 · Parallel Worker/Gate/Verifier · Verifier 합의(voting) ·
sub-agent · Research Agent · Debug Agent ·
Goal 자동 승인 · Phase 자동 승인 · multi-Phase full-auto ·
Budget hard limit · cost/token cap · 단계 간 비용 합산 · Monitor.

(`execute-plan`은 V0.1에서 구현되었다. 승인된 Plan의 Task를 **한 번에 하나씩** 순차 실행한다.)

Verifier 층에서 의도적으로 미룬 것:

- **Gate-only 자동 DONE 없음.** 이 단계는 실제로 독립 검증을 요구하는 Task만 다룬다.
  `requires_verifier: false`이고 verifier AC도 없는 Task는 Gate PASS 후에도 REVIEW에 남으며,
  `verify-ready`가 `(no verifier required)`로 표시한다. 완료 정책을 임의로 넓히지 않았다.
- **Verifier FAIL 후 아무 자동 동작도 없다.** Task는 REVIEW에 남고 재시도하지 않는다.
  Failure Memo 기록과 재작업 루프는 다음 단계다.
- **subject 엄격도를 완화하지 않았다.** worktree 격리가 없는 동안에는 전체 트리 지문이
  정직한 선택이다.
- codex adapter의 `runVerifier`는 여전히 미구현이다. 이 환경에서 CLI가 실행되지 않아
  구조화 출력 지원 여부를 확인할 수 없고, 플래그를 추측해서 쓰지 않는다.

Full Loop에서 의도적으로 미룬 것:

- **`execute`는 Goal을 받지 않는다.** 유효한 Task 하나를 받는다. Task 생성은 `plan-approve` 몫이다.
- **다중 Task 자동 실행 없음.** 공유 작업 트리 하나뿐이라 여러 Task를 동시에 돌리면 모호해진다.
- **병렬 없음 · 데몬 없음 · 백그라운드 없음.** 터미널이 실행 수명을 소유한다.
- **Budget 강제 없음.** 보고서가 나중의 Budget 정책을 가능하게 만들 뿐이다.
- **provider 자동 전환 없음.** adapter를 못 쓰면 멈춘다. 모델 자동 상향도 없다.
- **Operation Journal 기반 crash 복구 없음.** 다만 중단되어도 하위 Run 상태는 그대로 유효하고,
  다음 `execute`가 정본 artifact를 다시 읽어 모호하지 않을 때만 이어간다.

Goal Planner 층에서 의도적으로 미룬 것:

- **자동 승인 없음.** `Goal -> Plan -> 전부 실행` 사슬을 만들지 않았다. 승인은 여전히 사람이 한다.
  `plan-approve` 없이는 Task가 만들어지지 않고, 실행은 `execute-plan`을 명시적으로 불러야 시작된다.
  (V0.1에서 `execute-plan`이 추가되어 **승인된** Plan은 한 번에 하나씩 순차 실행할 수 있다.
   V0에서 미뤄 두었던 항목이며, Phase 1 field-test 이후 구현·검증되었다.)
- **Queue · scheduler · 병렬 실행 없음.** `execute-plan`은 공유 작업 트리에서 Task를
  **한 번에 하나씩** 돌린다. `execute-all` · daemon · worktree 격리는 여전히 없다.
- **자동 Replan 없음.** Step 6/7의 `REPLAN_REQUIRED` 를 이 Planner로 넘기지 않는다.
  이 Planner는 새 Goal만 다룬다.
- **대화형 계획 없음.** `NEEDS_HUMAN` 은 질문을 돌려주고 끝난다. 답을 받아 이어서 계획하는
  경로는 만들지 않았다. 사람이 답을 포함한 Goal로 `loopctl plan` 을 다시 부른다.
- **Plan 중복 탐지는 결정론적인 것만.** request 문자열이 완전히 같은 미완료 Task가 있을 때만
  경고한다. LLM에게 "비슷한 Task인가"를 묻지 않는다. 경고는 Plan을 무효화하지 않는다.
- **Planner 자동 재시도 없음.** timeout이나 실패는 artifact를 남기고 거기서 멈춘다.
- **`--force` 없음.** 오래된 Plan은 승인하지 않는다. 새로 계획한다.
- **Planner 변경 자동 복구 없음.** Planner가 파일을 건드리면 정책 위반으로 보고하고 거부한다.
  되돌리지는 않는다.
- **Task 스키마 확장은 `depends_on` 하나뿐.** 우선순위 · 예산 · 조건부 의존 · OR 의존은 없다.
- codex adapter의 `runPlanner` 는 `runVerifier` 와 마찬가지로 미구현이다.
  이 환경에서 CLI가 실행되지 않아 구조화 출력 지원 여부를 확인할 수 없고, 플래그를 추측하지 않는다.

Recovery 층에서 의도적으로 미룬 것:

- **Replan / Decompose 없음.** 한도를 넘으면 진단이 `REPLAN_REQUIRED`나 `NEEDS_HUMAN`을
  권고하고 거기서 멈춘다. Task를 다시 쓰는 AI를 부르지 않는다.
- **Stall Engine 없음.** tool-call 수준의 정체 감지는 아직이다.
  다만 attempt · failure class · fingerprint · 실패한 Gate/AC는 이미 기록해 두었다.
- **자동 rollback 없음.** 저장소 상태가 어긋나면 되돌리지 않고 거부한다.
- **단계 간 비용 합산 없음.** 각 Attempt의 telemetry는 그대로 분리해서 남긴다.

Operator CLI에서 의도적으로 미룬 것:

- `auto` · `start` · `execute` · `loop` 같은 자동 오케스트레이션 명령은 없다.
  Worker -> Gate -> Verifier 연결은 Step 6의 몫이며, 지금은 운영자가 각각 호출한다.
- 전역 설치 · PATH 수정 · npm 패키지 · 설치 마법사는 하지 않는다.
  이 Runtime은 아직 로컬 개발 도구다.

Gate 층에서 의도적으로 미룬 것:

- Gate 실패 시 자동 전이·재시도가 없다. 사람이 다음 단계를 정한다.
- Gate 병렬 실행이 없다. 순차 실행이며 순서는 Task 설정에서 온다.
- exit code 127(command not found)을 특별 취급하지 않는다. 정상 실행된 non-zero는 FAIL이다.
  프로세스 사실만으로 판정하고 출력을 해석하지 않기 위해서다.
- Gate 결과를 Verifier 입력으로 넘기는 경로는 Verifier 구현 시점에 만든다.

codex adapter는 `codex --help`가 실제로 동작하는 환경에서 지원 플래그와 사용량 노출 여부를
확인한 뒤에 구현한다. 플래그를 추측해서 쓰지 않는다.
