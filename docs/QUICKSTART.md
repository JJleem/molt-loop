# QUICKSTART — 한 장으로 끝내는 Loop Runtime

이 문서만 읽으면 시작할 수 있다. 자세한 설명은 [README](../README.md), 현재 명령·설정은
[RUNTIME-USAGE](RUNTIME-USAGE.md), 설계 근거는 [Field Notes](LOOP-RUNTIME-FIELD-NOTES.md)에 있다.

## 0. 준비 (한 번만)

| 필요한 것 | 확인 |
| --- | --- |
| Node.js 22+ | `node --version` |
| Claude Code CLI | `claude --version` |

```bash
git clone https://github.com/JJleem/molt-loop.git my-project && cd my-project
rm -rf .git && git init
./loopctl doctor          # exit 0이면 준비 끝. Gate 3개가 disabled인 것은 정상이다.
```

Windows는 `.\loopctl`. `npm install`은 필요 없다.

## 1. 새 프로젝트 첫 세션

대화형 Claude 세션을 열고 `START-HERE.md`를 첫 프롬프트로 준 뒤 주제를 말한다.
그 세션이 `docs/PRODUCT-SPEC.md`, `phase-prompt/01-*.md`, 개발 환경(Bootstrap), Gate 설정을 만든다.
**여기까지는 Runtime이 아니라 대화형 세션의 일이다.**

## 2. Phase 하나 돌리기 — 명령 한 줄

```bash
./loopctl start --file phase-prompt/01-foundation.md
```

이 한 줄이 계획 → 승인 → 실행을 끝까지 잇는다. 명령 자체가 그 파일에 대한 승인이다.
멈추면(사람이 필요한 지점) 같은 명령을 다시 치면 남은 곳부터 이어간다.

```bash
./loopctl status          # 어디까지 됐는지 + 맨 아래 NEXT에 다음에 칠 명령
```

## 3. 빠르게 가야 할 때

```bash
./loopctl quick "README에 설치 절차를 추가한다"
./loopctl quick --file phase-prompt/03-small-fix.md
```

`quick`은 `start`와 같은 흐름이지만 `.loop/project.yaml`의 `quick` 프로필을 적용한다.
Starter 기본값은 낮은 effort(Worker·Verifier low, Planner medium), Plan당 최대 4 Task,
Phase 끝 Goal 검증 생략, Worker timeout 600초다.

**바뀌지 않는 것:** Gate는 그대로 돈다. Verifier가 필요한 Task는 그대로 검증한다.
Runtime이 판정하고 Worker는 완료를 선언할 수 없다. 빨라지는 것은 AI 호출의 크기다.

프로필 값은 `.loop/project.yaml`의 `runtime.profiles.quick`에서 바꾼다.
`--profile <name>`으로 다른 프로필을, `--effort <level>`로 Worker effort만 따로 지정할 수 있다.

## 4. 단계별로 하고 싶을 때

```bash
./loopctl plan --file phase-prompt/01-foundation.md   # AI 1회. Task는 아직 없다
./loopctl plan-show latest                            # 사람이 읽는다
./loopctl plan-approve latest                         # 여기서 Task 파일이 생긴다
./loopctl execute-plan latest                         # Task를 하나씩 끝까지
```

`latest`는 가장 최근 Plan이다. ID를 복사할 필요가 없다.

## 5. 멈추는 횟수

정지 지점에는 사람 대신 **Triage**가 먼저 본다(기본 켜짐). 저장소 기록만 보고 Runtime이 준 메뉴에서 다음 행동을 고르고,
완료는 선언하지 못한다. 그래도 안 되면 `NEEDS_HUMAN`으로 사람에게 온다. `.loop/policies/limits.yaml`의 `triage` 절에서
횟수를 조정하고, `--profile manual`로 명령 하나에만 끌 수 있다.

## 6. 막혔을 때

```bash
./loopctl status                 # NEXT 줄이 대개 답이다
./loopctl diagnose TASK-001      # 왜 멈췄는지 (AI 호출 없음)
./loopctl resume TASK-001        # 중단 단계부터 재개 (Worker를 다시 부르지 않는다)
./loopctl usage --all            # 비용·시간, Task별 추세 (vs prev 열이 오르면 OBS-005 패턴)
```

| 증상 | 할 일 |
| --- | --- |
| `NEEDS_HUMAN` | `diagnose` → 고친 뒤 `start`/`execute-plan` 재실행 |
| `Plan approval refused: repository state changed` | 새로 `plan`. 우회 수단은 없다 |
| Gate가 `ERROR` | `./loopctl gates` — 명령이 없거나 disabled |
| 전부 멈추고 싶다 | `.loop-local/PAUSE` 파일 생성. 지우면 재개 |

## 7. 비용을 제어하는 손잡이

| 설정 (`.loop/project.yaml`) | 하는 일 |
| --- | --- |
| `worker_effort` / `verifier_effort` / `planner_effort` | provider `--effort` (low·medium·high·xhigh·max) |
| `max_call_budget_usd` | AI 호출 1회 상한. provider가 호출 **뒤에** 검사한다 |
| `worker_simple_model` | Gate만으로 판정되는 작은 Task의 첫 시도용 모델 |
| `.loop/policies/limits.yaml` → `budget.task_usd` / `plan_usd` | 누적 예산. 다음 유료 호출 전 검사 |

실제 절약률은 프로젝트마다 다르다. `usage --all`로 재고 나서 조정한다.
