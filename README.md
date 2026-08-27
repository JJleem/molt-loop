# molt-loop — Loop Runtime Starter Pack

AI Worker에게 프로젝트를 맡기되, **완료 판정은 AI에게 맡기지 않는** 실행 런타임.

목표 하나를 주면 Task로 쪼개고, Worker를 돌리고, 결정론적 Gate와 독립 Verifier로 검증하고,
실패하면 진단해서 재시도하고, 사람이 필요한 지점에서 멈춘다. 그 전 과정이 파일로 남는다.

이 저장소는 **새 프로젝트에 복사해서 쓰는 Starter Pack**이다. 제품 코드는 들어 있지 않다.

```
Goal → Plan → 사람 승인 → Task → Worker → Gate → Verifier → DONE
                                              ↑                ↓
                                          Diagnose ← 실패    사람 정지
```

---

## 목차

- [무엇이 다른가](#무엇이-다른가)
- [설치](#설치)
- [처음 쓰는 법 — 새 프로젝트 시작](#처음-쓰는-법--새-프로젝트-시작)
- [일상적인 사용 — Phase 하나 돌리기](#일상적인-사용--phase-하나-돌리기)
- [무엇이 산출되는가](#무엇이-산출되는가)
- [명령 레퍼런스](#명령-레퍼런스)
- [비용이 드는 곳](#비용이-드는-곳)
- [막혔을 때](#막혔을-때)
- [저장소 구조](#저장소-구조)
- [설정](#설정)
- [설계 원칙](#설계-원칙)
- [아직 없는 것](#아직-없는-것)

---

## 무엇이 다른가

AI에게 "이거 만들어 줘"라고 시키는 것과의 차이는 **누가 완료를 선언하는가**다.

| | 보통의 AI 코딩 | Loop Runtime |
| --- | --- | --- |
| 완료 판정 | AI가 "다 했습니다"라고 말함 | Runtime이 Gate 실행 결과 + 독립 Verifier 판정으로 결정 |
| 상태 변경 | AI가 파일을 직접 고침 | Runtime만 씀 (Single Writer). Worker는 요청만 가능 |
| 검증자 | 구현한 AI가 자기 결과를 확인 | 구현자를 모르는 별도 세션. Worker의 요약을 아예 받지 않음 |
| 근거 | "테스트 통과했습니다" | Runtime이 직접 실행한 명령의 exit code와 로그 파일 |
| 실패 | 같은 시도 반복 | 결정론적 진단 → 증류된 lesson 1건만 다음 시도에 주입 → 한도 초과 시 사람에게 |

핵심 문장 세 개다.

> **Worker의 주장은 Evidence가 아니다.**
> **독립 검증은 Session 분리가 아니라 Input 분리다.**
> **설치된 의존성은 구현된 기능이 아니다.**

---

## 설치

필요한 것은 두 가지뿐이다.

| | 요구사항 | 확인 |
| --- | --- | --- |
| Node.js | 22 이상 (LTS). 개발·검증은 v24.19.0 | `node --version` |
| Provider CLI | [Claude Code](https://claude.com/claude-code) | `claude --version` |

Runtime 자체는 **의존성이 없다.** `npm install` 이 필요 없고 `package.json` 도 쓰지 않는다.
의존성 없는 Node ESM(`.mjs`)으로만 되어 있다.

```bash
git clone https://github.com/JJleem/molt-loop.git my-project
cd my-project
rm -rf .git && git init          # 새 프로젝트의 역사를 새로 시작한다

./loopctl doctor                 # 구조 점검
./loopctl adapters               # provider CLI가 잡히는지
```

`doctor` 가 exit 0이면 준비된 것이다. 이 시점에 Gate 3개가 전부 `disabled` 인 것은
**정상이다** — 아직 프로젝트 스택이 없기 때문이며, Bootstrap이 채운다.

```bash
$ ./loopctl gates
build   timeout= 300s  disabled (package.json 없음 - build script 미정의)
lint    timeout= 300s  disabled (package.json 없음 - lint script 미정의)
test    timeout= 300s  disabled (package.json 없음 - test script 미정의)
```

Windows는 `.\loopctl` 을 쓴다. 진입점은 인자를 그대로 넘기고 exit code를 그대로 돌려주는
얇은 wrapper이며 Runtime 로직이 들어 있지 않다.

---

## 처음 쓰는 법 — 새 프로젝트 시작

복사한 직후 **대화형 Claude 세션을 열고 `START-HERE.md` 를 첫 프롬프트로 준다.**
그 문서가 아래 3단계를 순서대로 진행시킨다.

```
Step 1  Product Spec + Phase 로드맵    prompts/PROJECT-PHASE-PLANNER.md
Step 2  (검토)
Step 3  Bootstrap                      prompts/PROJECT-BOOTSTRAP.md
```

### Step 1 — 무엇을 만들 것인가

주제를 말하면 `PROJECT-PHASE-PLANNER.md` 가 이것들을 만든다.

```
docs/PRODUCT-SPEC.md      제품 사양 — 이후 모든 것의 source of truth
phase-prompt/01-*.md      Phase 1 Goal
phase-prompt/02-*.md      Phase 2 Goal
phase-prompt/Goal.md      최종 목표
```

**계획만 한다.** Task도 코드도 만들지 않는다.

### Step 2 — 사람이 읽는다

Phase 분할이 말이 되는지 본다. 여기서 잘못되면 뒤가 전부 잘못된다.

### Step 3 — Bootstrap

`PROJECT-BOOTSTRAP.md` 가 **최소한의 실제 개발 환경**을 만든다. Phase 1 기능은 구현하지 않는다.

- 스택 선택 · scaffold · build / lint / test 스크립트
- **명령을 실제로 실행해서 exit 0을 확인한 뒤** `.loop/project.yaml` 의 Gate를 켠다
- `docs/SYSTEM-MAP.md` 를 저장소 실물 기준으로 작성 (`docs/SYSTEM-MAP.template.md` 사용)
- `loopctl doctor` 통과

추측으로 채우는 것이 전부 금지되어 있다. 존재하지 않는 명령을 Gate에 적지 않고,
없는 architecture를 SYSTEM-MAP에 적지 않는다.

여기까지 끝나면 Phase 1을 돌릴 수 있다.

---

## 일상적인 사용 — Phase 하나 돌리기

Bootstrap 이후에는 Phase마다 이 다섯 줄이 전부다.

```bash
./loopctl plan --file phase-prompt/01-foundation.md   # AI 호출 1회. Task는 아직 없다
./loopctl plan-show PLAN-20260827T...                 # 사람이 읽는다
./loopctl plan-approve PLAN-20260827T...              # 여기서 처음 Task 파일이 생긴다
./loopctl execute-plan PLAN-20260827T...              # Task를 하나씩 끝까지
./loopctl status                                      # 어디까지 됐는지
```

### 각 단계에서 실제로 일어나는 일

**`plan`** — 읽기 전용 Planner 세션이 저장소를 조사하고 Task 제안을 낸다.
`Read`·`Grep`·`Glob` 만 주고, 실행 전후 저장소 지문을 대조해서 아무것도 바꾸지 않았음을
Runtime이 직접 확인한다. **Task 파일은 만들지 않는다.**

```
Plan: PLAN-20260827T035251Z
Planner Result:  PROPOSED
Tasks proposed:  4

P1  공통 변환 인터페이스 추가
P2  OBJ 변환
    depends on: P1
P3  STL 변환
    depends on: P1
P4  브라우저 뷰어
    depends on: P2, P3

Validation: PASS
No tasks have been created.
```

Runtime이 결정론적으로 검증한다 — Role이 실제로 설치되어 있는지, Gate 이름이 설정에
있고 **활성인지**, Acceptance Criteria가 판정 가능한지, 의존 그래프에 순환이 없는지.
검증 실패면 승인 자체가 불가능하다.

Planner가 안전하게 결정할 수 없으면 `NEEDS_HUMAN` 과 함께 질문을 돌려준다.
client/server 보안 경계, 비가역 아키텍처 선택, 파괴적 마이그레이션 같은 것들이다.

**`plan-approve`** — 사람의 승인 경계. **AI를 호출하지 않는다.**
Runtime이 canonical Task ID를 발급하고(`TASK-001`, `TASK-002`...), 제안 의존 관계를
실제 ID로 치환하고, **전체 Task 집합을 먼저 검증한 뒤에** 파일을 쓴다.

계획 시점 이후 저장소가 바뀌었으면 거부한다. `--force` 는 없다.

**`execute-plan`** — Task를 **한 번에 하나씩** 순서대로 돌린다.
Task 하나마다 `Worker → Gate → Verifier → Diagnose → Retry` 루프가 돈다.
사람이 필요한 정지에서 즉시 멈추고, 다시 실행하면 남은 Task부터 이어간다(플래그 불필요).

### Phase가 끝나면

`docs/SYSTEM-MAP.md` 를 갱신한다 — 단, **Phase 최종 DONE 또는 architecture 경계가
바뀌었을 때만.** Task마다 갱신하지 않는다. 규칙은 `CLAUDE.local.md` 에 있다.

---

## 무엇이 산출되는가

크게 셋이다. **하나는 저장소에 남는 상태, 둘은 로컬 기록.**

```
.loop/tasks/*.yaml     Task — 추적되는 프로젝트 상태 (git에 커밋된다)
.loop-local/plans/     Plan 산출물 — 로컬 기록 (gitignore)
.loop-local/runs/      Run 산출물 — 로컬 기록 (gitignore)
```

### 1. Task 파일 — 유일하게 커밋되는 산출물

`plan-approve` 가 만든다. 사람이 읽고 고칠 수 있는 YAML이다.

```yaml
# 공통 변환 인터페이스 추가
# Runtime이 PLAN-20260827T035251Z 승인 시점에 생성했다 (proposal P1).

id: TASK-001
status: TODO

request: |-
  기존 변환 아키텍처를 이용해 공통 인터페이스를 정의한다.

execution:
  role: impl

stop_condition:
  gates: [build, test]
  requires_verifier: true
  max_consecutive_failures: 2

acceptance_criteria:
  - id: AC1
    description: |-
      인터페이스가 정의되고 export 된다.
    verification:
      type: verifier          # 판단이 필요한 기준
  - id: AC2
    description: |-
      build gate가 통과한다.
    verification:
      type: gate              # 결정론적으로 판정된다
      ref: build

evidence: []
failure_memo: []
```

선행 Task가 있으면 `depends_on: [TASK-001]` 이 붙는다. 선행이 DONE이 아니면 그 Task는
READY가 아니고 `run`·`execute` 가 거부한다. **상태는 `TODO` 그대로 남는다** —
`BLOCKED` 같은 새 상태를 만들지 않는다.

### 2. Plan 산출물

```
.loop-local/plans/PLAN-20260827T035251Z/
├─ context.md              Planner가 받은 입력 전문 (무엇을 보고 계획했는지)
├─ manifest.json           입력 출처 · 제외 목록 · 저장소 지문
├─ planner-result.json     Planner가 낸 원본 + 검증 결과 + 정규화본
├─ planner-envelope.json   Runtime이 관찰한 사실 — 프로세스 · 지문 · 토큰 · 비용
├─ plan-report.json        Runtime이 쓰는 정본 (승인 가능 여부는 여기서 결정된다)
├─ approval.json           승인 후에만 생김. P1 → TASK-001 매핑
├─ executions/             execute-plan 실행 기록
└─ stdout.log · stderr.log
```

`planner-result.json`(AI의 주장)과 `planner-envelope.json`(Runtime의 관찰)이 **끝까지
분리되어** 저장된다.

### 3. Run 산출물 — Task 하나의 시도 하나

```
.loop-local/runs/RUN-20260827T035251Z-TASK-001/
├─ context.md              Worker가 받은 입력 전문
├─ manifest.json           입력 해시 · attempt · lineage
├─ worker-result.json      Worker의 주장
├─ runtime-envelope.json   Runtime의 관찰 — 종료 코드 · 변경 파일 · 보호 파일 위반 · 토큰
├─ gate-report.json        Gate별 exit code · 로그 해시 · 종합 판정
├─ stdout.log · stderr.log
└─ verification/
   ├─ context.md               Verifier가 받은 입력 (Worker 요약이 들어 있지 않다)
   ├─ canonical-diff.patch     Runtime이 만든 결정론적 변경 표현
   ├─ subject.json             검증 대상 저장소 지문
   ├─ verifier-result.json     Verifier의 판정 (AC별 evidence_basis 포함)
   ├─ verifier-envelope.json   Runtime의 관찰
   └─ verification-report.json 완료 판정의 정본 — 이게 PASS여야 DONE이 된다
```

`.loop-local/executions/EXEC-.../execution-report.json` 에는 Task 하나의 전체 실행
요약(시도 횟수 · 각 단계 결과 · 정지 사유 · 누적 사용량)이 남는다.

### 산출물을 읽는 명령

전부 **AI를 호출하지 않는다.** 기록된 파일을 읽기만 한다.

```bash
./loopctl status                 # 전체 현황 한 장
./loopctl show TASK-001          # Task 상세 + 왜 READY가 아닌지
./loopctl execution TASK-001     # 실행 보고서
./loopctl verification TASK-001  # 검증 보고서 (AC별 판정과 근거)
./loopctl usage TASK-001         # 토큰 · 비용
./loopctl diagnose TASK-001      # 실패 진단
```

---

## 명령 레퍼런스

`./loopctl help` 가 실제 구현된 전부를 보여준다. AI를 호출하는 것은 **네 개뿐이다.**

| 명령 | AI 호출 | 하는 일 |
| --- | :---: | --- |
| `plan "<GOAL>"` | **1회** | Goal → Task 제안. Task를 만들지 않는다 |
| `run <TASK>` | **1회** | Worker 1회 실행 |
| `verify <RUN\|TASK>` | **1회** | 독립 Verifier 1회 실행 |
| `retry <RUN\|TASK>` | **1회** | 진단 기반 재시도 1회 |
| `execute <TASK>` | 여러 번 | 위를 정지 조건까지 자동으로 연결 |
| `execute-plan <PLAN>` | 여러 번 | `execute` 를 Plan의 Task마다 순차 호출 |
| `plan-show` · `plans` · `plan-approve` | 없음 | Plan 열람 · 승인 |
| `gate <RUN\|TASK>` | 없음 | 설정된 Gate 명령 실행 |
| `self-check [<gate>]` | 없음 | Gate 명령 참고 실행 (판정 아님) |
| `status` · `show` · `ready` · `tasks` · `gates` · `adapters` · `doctor` · `validate` · `version` | 없음 | 조회 |
| `diagnose` · `execution` · `usage` · `verification` | 없음 | 기록 열람 |
| `transition` · `context` · `snapshot` | 없음 | 저수준 수동 제어 |

```
exit 0  성공 / 검사 통과
exit 1  명령은 돌았지만 요청한 작업이 실패하거나 거부됨
exit 2  잘못된 사용법
```

---

## 비용이 드는 곳

토큰을 쓰는 지점은 넷뿐이고, 전부 **1회 호출**이 단위다.

```
plan     Planner 1회
run      Worker  1회
verify   Verifier 1회
retry    Worker  1회
```

`execute` / `execute-plan` 은 위를 조합할 뿐 **오케스트레이션 자체에 AI를 쓰지 않는다.**
다음에 무엇을 할지는 파일 상태에서 결정론적으로 계산한다.

승인·의존성 검증·순환 탐지·Task ID 발급·진단은 전부 0회다.
두 번째 AI에게 첫 결과를 검토시키지 않고, 합의 투표도 하지 않는다.

실제 사용량은 Runtime이 provider 보고값 그대로 기록한다. 없는 값은 만들지 않는다.

```bash
$ ./loopctl usage TASK-001
Usage:
  context: 6.7 KB (5,284 chars, 145 lines)
  tokens: input=12 output=10,377 cached_input=136,433 (provider)
  provider-reported cost: $0.7606
```

### 비용을 줄이는 것

Worker가 Gate를 미리 돌려볼 수 있게 하는 `self-check` 가 있다. 이게 없던 시절
타입 오류 한 줄 때문에 시도 하나가 통째로($4.04, 9분) 버려진 실측이 있다 —
`docs/LOOP-RUNTIME-FIELD-NOTES.md` OBS-007.

---

## 막혔을 때

| 증상 | 원인 | 할 일 |
| --- | --- | --- |
| `No ready tasks` | 선행 Task가 DONE이 아니거나 PAUSE | `./loopctl ready` 가 무엇을 기다리는지 보여준다 |
| `is not ready. Waiting on: TASK-001` | 의존성 미충족 | 선행 Task를 먼저 끝낸다 |
| Gate가 `ERROR` | 명령이 없거나 Gate가 disabled | `./loopctl gates` 로 설정 확인 |
| `Plan approval refused: repository state changed` | 계획 이후 저장소가 바뀜 | 새로 `plan` 한다. 우회 수단은 없다 |
| Verifier가 FAIL인데 이유가 모호 | | `./loopctl verification <TASK>` 에 AC별 근거가 있다 |
| 실행이 `NEEDS_HUMAN` 으로 멈춤 | 한도 초과 또는 회복 불명확 | `./loopctl diagnose <TASK>` |
| 사람이 손으로 복구해서 DONE으로 만듦 | | `execution` 이 `origin: manual` 로 새 기록을 남긴다 |
| 전부 멈추고 싶다 | | `.loop-local/PAUSE` 파일을 만든다. 지우면 재개 |

Runtime 자체를 의심할 때:

```bash
./loopctl doctor                                  # 구조 점검
./loopctl validate                                # Task 전체 검증
node --test "tools/loop-runtime/test/*.test.mjs"  # 139개 회귀 (AI 호출 0회)
```

Runtime 버그로 보이면 `LOOPCTL_DEBUG=1` 로 전체 stack을 볼 수 있다.

---

## 저장소 구조

```
START-HERE.md              새 프로젝트 첫 세션 프롬프트 ← 여기서 시작
CLAUDE.local.md            대화형 세션 운영 지침 (persistent instruction)
loopctl · loopctl.cmd      진입점 (얇은 wrapper)

prompts/
  PROJECT-PHASE-PLANNER.md 주제 → Product Spec + Phase 로드맵
  PROJECT-BOOTSTRAP.md     개발 환경 · Gate · SYSTEM-MAP 준비

docs/
  SYSTEM-MAP.template.md   프로젝트 최상위 지도 템플릿
  LOOP-RUNTIME-FIELD-NOTES.md  Runtime 운용 관찰 기록 (설계 근거)

.loop/                     Runtime control plane — Worker는 읽기만 한다
  KERNEL.md                모든 Run에 들어가는 고정 규칙
  DESIGN.md                설계 원본 (Worker에게 전달되지 않는다)
  project.yaml             Gate 명령 · adapter · timeout
  policies/limits.yaml     정지 · 재시도 · 계획 한도
  skills/                  impl · verifier · planner 역할 계약
  tasks/                   Task 파일
  evidence/                Task별 증거 산출물

.loop-local/               실행 기록 (gitignore)
  plans/ · runs/ · executions/ · leases/ · staging/

tools/loop-runtime/        Runtime 구현 (의존성 없는 Node ESM)
  test/                    139개 결정론적 회귀 — mock adapter, AI 호출 0회
```

Runtime 내부 구조와 각 층의 설계 근거는 [`tools/loop-runtime/README.md`](tools/loop-runtime/README.md)에 있다.

---

## 설정

### `.loop/project.yaml` — Gate와 provider

Gate 명령은 **Runtime만 소유한다.** Worker의 결과나 Task 서술에서 온 문자열은 절대
실행되지 않는다.

```yaml
runtime:
  worker_adapter: claude
  worker_timeout_seconds: 900
  verifier_adapter: claude
  planner_adapter: claude
  planner_timeout_seconds: 600

gates:
  build:
    enabled: true
    command: npm run build      # 실제로 돌려서 exit 0을 확인한 명령만 적는다
    timeout_seconds: 600
```

비활성 Gate를 Task가 요구하면 결과는 `ERROR` 다. PASS를 지어내지 않는다.

### `.loop/policies/limits.yaml` — 한도

정지·에스컬레이션 정책은 **여기 한 곳에만** 둔다.

```yaml
stop:
  max_attempts: 3
  max_consecutive_failures: 2

escalation:
  retry_max: 1          # transient 실패만
  hint_retry_max: 1     # 이전 실패의 lesson을 주입한 재시도
  then: needs-human     # 자동 replan 없음 — 사람에게 올린다

planning:
  max_tasks_per_plan: 12
```

---

## 설계 원칙

Runtime이 강제하는 것들이다. 문서가 아니라 코드가 지킨다.

**Single Writer.** Task 상태를 쓰는 경로는 하나뿐이고, 전이표를 통과해야 한다.
Worker와 Verifier와 Planner는 전부 State Writer가 아니다.

**Input 분리.** Verifier는 Worker의 요약·자기평가·진행 서술을 **받지 않는다.**
Runtime이 만든 canonical diff와 Gate 결과만 본다. 독립성은 세션을 나누는 것이 아니라
입력을 나누는 것에서 나온다.

**Evidence basis.** Verifier의 모든 AC 판정에는 근거 종류가 필수다 —
`gate` · `runtime_artifact` · `canonical_diff` · `repository_content` · `unwitnessed_claim`.
Worker의 서술에 해당하는 값은 **존재하지 않는다.** 수동 조작·브라우저·네트워크가 필요한
기준은 `unwitnessed_claim` 이며 **PASS를 줄 수 없다.**

**읽기 전용은 검증된다.** Planner와 Verifier에게는 쓰기 도구를 주지 않고, 실행 전후
저장소 지문과 `.loop/` 지문을 대조해서 실제로 아무것도 바꾸지 않았음을 확인한다.

**Subject 바인딩.** Gate가 통과했다는 것은 **그때 그 저장소 상태**에 대해서만 유효하다.
Plan도 계획 시점 상태에 묶인다. 어긋나면 거부한다. `--force` 는 없다.

**진단 없는 재시도는 자동화가 아니라 비용이다.** 실패는 결정론적으로 분류되고,
증류된 lesson 한 줄만 다음 시도에 들어간다. 이전 시도의 transcript는 누적되지 않는다.

전체 설계는 [`.loop/DESIGN.md`](.loop/DESIGN.md)에 있다.

---

## 아직 없는 것

의도적으로 미룬 것들이다. 필요성이 실측으로 확인되기 전에는 만들지 않는다.

```
loopctl resume                 per-Task worktree 격리      parallel Task 실행
sub-agent                      Research / Debug Agent      Goal 자동 승인
Phase 자동 승인                multi-Phase full-auto       budget hard limit
cost / token cap               자동 replan / decompose     Monitor
```

`execute-plan` 은 공유 작업 트리에서 **한 번에 Task 하나씩** 돌린다. 병렬 실행은 없다.

무엇을 왜 미뤘는지, 어떤 실측이 어떤 기능을 정당화했는지는
[`docs/LOOP-RUNTIME-FIELD-NOTES.md`](docs/LOOP-RUNTIME-FIELD-NOTES.md)에 있다.

---

## 라이선스 · 상태

Loop Runtime **V0.1**. Phase 1 실사용을 거쳐 검증된 상태다.

```
Runtime 회귀   139 pass / 0 fail   (mock adapter, AI 호출 0회)
loopctl doctor exit 0
```

버전 태그: `loop-runtime-v0` · `loop-runtime-v0.1`
