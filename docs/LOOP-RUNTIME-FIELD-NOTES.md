# Loop Runtime — Field Notes

> **이 문서는 Runtime 설계 근거(design provenance)다. 현재 프로젝트의 상태가 아니다.**
>
> 아래에 나오는 Task ID(`TASK-001` ~ `TASK-008`), Plan/Run/Execution ID, 비용($), 소요 시간,
> Run 수, 토큰 수치는 전부 **Loop Runtime 개발에 쓰인 canonical field-test 프로젝트**의
> Phase 1 실측 기록이다. Starter Pack을 복사해 새로 시작한 프로젝트의 Task 상태나
> 실행 결과를 뜻하지 않는다. 새 프로젝트에는 저 Task도, 저 Run도 존재하지 않는다.
>
> 이 수치들을 지우거나 일반화하지 않는다. Runtime의 어떤 결정이 **어떤 실측 때문에**
> 내려졌는지가 이 문서의 존재 이유이기 때문이다. 새 프로젝트에서 관찰한 것은
> `OBS-` 순번을 이어서 따로 기록한다.

이 문서는 실제 프로젝트에서 Loop Runtime을 사용하면서 발견한 **불편함, 반복 문제, 개선 후보, 운영상 제약**을 기록한다.

목적은 다음을 구분하는 것이다.

- 실제 Runtime 사용성 문제
- 프로젝트 고유 문제
- Planner / Task 분해 문제
- Gate / Verifier / Retry 동작 문제
- 과도한 토큰·비용·시간 사용
- 향후 자동화 후보
- 아직 필요성이 검증되지 않은 아이디어

> 원칙: 문제나 아이디어를 발견했다고 바로 Runtime을 수정하지 않는다. 먼저 실제 사례와 Evidence를 기록하고, 반복되거나 영향이 큰 문제가 확인된 뒤 Runtime 개선 대상으로 승격한다.

---

## 기록 규칙

새로운 관찰은 `OBS-001`, `OBS-002`처럼 순번을 붙인다.

가능하면 아래 정보를 함께 남긴다.

- 관련 Plan ID
- 관련 Task ID
- 관련 Run / Execution ID
- 실행한 명령
- 실제로 발생한 현상
- 기대했던 동작
- 현재 workaround
- 영향도
- 개선 아이디어

Runtime 내부 구현 아이디어만 있고 실제 사용 사례가 없다면 우선 `Idea`로 기록하고, 실제 사례가 생기기 전까지 구현 우선순위로 간주하지 않는다.

Observation의 `Status`는 다음 중 하나다. **관찰 본문은 상태가 바뀌어도 고쳐 쓰지 않는다** —
무엇을 보고 무엇을 고쳤는지가 남아야 하기 때문이다.

- `OBSERVED` — 관찰됨. 아직 Runtime에서 해결되지 않음.
- `VALIDATED` — 다른 관찰이 예측한 문제가 실제로 재현됨.
- `RESOLVED (V0.x)` — 해당 Runtime 버전에서 해소됨. 어떤 CI 항목으로 고쳤는지 함께 적는다.

---

# Observations

## OBS-001 — Template

**Date:**

**Project phase / Goal:**

**Plan / Task / Run / Execution:**

**Runtime stage:**

- Planner
- Approval
- READY / dependency
- Worker
- Gate
- Verifier
- Diagnose
- Retry
- Execute loop
- CLI / Bootstrap
- Other

### What happened

실제로 어떤 일이 발생했는지 적는다.

### Expected

어떤 동작이 더 자연스럽거나 유용했는지 적는다.

### Current workaround

현재는 어떻게 우회했는지 적는다.

### Impact

- Low
- Medium
- High

### Possible Runtime improvement

가능한 개선 방향이 있다면 적는다. 해결책이 명확하지 않으면 비워둬도 된다.

### Evidence

관련 명령, Plan / Task / Run / Execution ID, artifact path 등을 적는다.

### Status

`OBSERVED`

---

## OBS-002 — Worker가 명령을 실행할 수 없어 self-check도 외부 검증도 불가능했다

**Date:** 2026-08-26

**Project phase / Goal:** Phase 1 — Asset Inspection Foundation

**Plan / Task / Run / Execution:**
- PLAN-20260826T052332Z
- TASK-001 / RUN-20260826T052916Z-TASK-001 / EXEC-20260826T052916Z-TASK-001 (DONE, $2.0895)
- TASK-002 / RUN-20260826T053857Z-TASK-002 / EXEC-20260826T053857Z-TASK-002 (NEEDS_HUMAN, $2.7520)
- TASK-003 / RUN-20260826T055601Z-TASK-003 / EXEC-20260826T055601Z-TASK-003 (DONE, $4.6265)

**Runtime stage:** Worker

> **3연속 재현.** TASK-001·002·003 모든 Run에서 동일하게 발생했다. 일회성 환경 문제가 아니라 이 Runtime 배치의 상시 조건으로 봐야 한다.

### What happened

두 Run 모두에서 Worker가 셸 명령을 거의 실행하지 못했다. permission layer가 `This command requires approval`로 거부했고, 허용된 것은 `ls`/`grep`/`sed`/`sha256sum`/`git status`/`node --version` 수준이었다.

구체적 영향:

1. **TASK-001 (라이브러리 검증)** — Goal이 명시적으로 "실제 현재 버전과 공식 문서를 확인하라"고 요구했으나 `npm view`, `curl registry.npmjs.org`, WebFetch, WebSearch, npm 캐시 읽기가 전부 차단됐다. Worker는 추측으로 채우는 대신 three.js / @loaders.gl/ply / playcanvas / splat-transform의 모든 registry·문서 파생 필드를 `UNVERIFIED`로 표기하고, 결론이 그 미검증 필드에 의존하지 않도록 설계했다(`docs/PHASE-1-LIBRARY-DECISION.md` §0, §4.3, Appendix A).
2. **TASK-002 (구현)** — `npm test`, `npm run lint`, `npx tsc -b`, `node <file>` 모두 거부돼 Worker가 자기 코드를 **한 번도 실행해보지 못한 채** REVIEW를 요청했다. Worker note에 "build/lint/test 결과는 내가 확인한 것이 아니다"라고 명시했다.
3. **TASK-003 (구현)** — 거부 범위가 더 넓어졌다. `npm test`, `npx vitest`, `./node_modules/.bin/vitest`, `node <file>`에 더해 **`node -e`까지** 거부됐다. Worker note: "AC4/AC5는 Worker 측 증거가 없으며 통과를 주장하지 않는다. Runtime의 gate 실행만이 유일한 권위다." 대신 정적 리뷰로 strict 모드 타입 위험 2건을 제거했다.
4. 세 Run 모두 `.loop/evidence/<TASK>/`에 쓰기가 거부됐다. TASK-001은 증거를 결과 문서 Appendix로 인라인했고, TASK-002는 소스 경로 + sha256으로, TASK-003은 `.loop-local/runs/<RUN-ID>/`에 대신 기록했다 — 즉 **KERNEL이 지정한 evidence 경로가 세 번 다 사용 불가능했고, Worker마다 다른 우회책을 즉흥적으로 골랐다.** 증거 위치가 Run마다 달라지는 것 자체가 부수적 문제다.

### Expected

Worker가 최소한 프로젝트의 Gate 명령(`npm run build` / `lint` / `test`)과 `.loop/evidence/` 쓰기는 할 수 있어야 한다. Gate가 어차피 Runtime 측에서 다시 돌기 때문에 결과 자체는 보장되지만, Worker가 실행 피드백 없이 코드를 쓰면 Gate 실패 → retry 사이클이 늘어나고 그만큼 비용이 커진다.

### Current workaround

- Worker가 "확인하지 못했다"를 정직하게 note에 남기고 Gate에 판정을 위임 — 실제로 두 Task 모두 Gate가 첫 시도에 PASS해서 문제가 표면화되지 않았다.
- 네트워크 검증은 Phase 2로 연기(`PHASE-1-LIBRARY-DECISION.md` §5).

### Impact

Medium→High (3연속 재현으로 상향) — 세 Task 모두 Gate가 첫 시도에 PASS해서 아직 retry 비용으로 드러나지 않았다. 하지만 그건 운이고, 실행 피드백 없는 Worker는 retry 비용을 구조적으로 키운다. TASK-003은 912줄을 한 번도 돌려보지 않고 작성했다($4.6265). 그리고 "외부 검증"을 요구하는 Goal은 이 환경에서 **원리적으로 만족 불가능**한데, Verifier는 그걸 PASS로 판정했다(AC1이 `UNVERIFIED` fallback을 명시적으로 허용했기 때문). AC가 fallback을 허용하면 Goal의 핵심 요구가 조용히 무력화될 수 있다.

### Possible Runtime improvement

- Runtime이 Worker에게 부여된 실제 capability(명령 실행 / 네트워크 / evidence 쓰기)를 Worker Context에 명시적으로 선언한다. 지금은 Worker가 하나씩 시도해보고 거부당하며 알아낸다.
- Planner가 "외부 검증 필요" Task를 만들 때 Runtime이 네트워크 가용 여부를 사실로 알려주면, 애초에 만족 불가능한 AC를 만들지 않을 수 있다.
- 또는 Worker 시작 전에 required gate 명령의 실행 가능 여부를 preflight로 확인하고, 불가능하면 Worker Context에 "self-check 불가"를 사실로 넣는다.
- `.loop/evidence/` 쓰기 가능 여부도 같은 preflight에 포함하고, 불가능하면 Runtime이 대체 경로를 **지정**한다. 지금은 Worker가 매번 다른 곳을 고른다.

### Evidence

- `docs/PHASE-1-LIBRARY-DECISION.md` §0 표, Appendix A.1 (차단된 7개 시도 기록)
- `.loop-local/runs/RUN-20260826T053857Z-TASK-002/worker-result.json` → `notes`
- `.loop-local/runs/RUN-20260826T055601Z-TASK-003/worker-result.json` → `notes` (`node -e`까지 거부, evidence 경로 우회)
- `.loop-local/executions/EXEC-20260826T052916Z-TASK-001/execution-report.json`

### Status

`RESOLVED (V0.1)` — CI-003 + CI-007로 해소. Worker Context가 capability를 사실로 선언하고,
`worker/policy.mjs`가 `.loop/evidence/<TASK-ID>/` 쓰기를 실제로 열었다. V0.1 §1 · §2 참조.
관찰 당시의 실측(Phase 1 8 Task / 9 Run 전부 재현)과 예측된 retry 비용($4.04, OBS-007)은 위 본문에 그대로 둔다.

---

## OBS-003 — Gate 실행 중 사람이 만든 무관한 파일 하나가 Run 전체를 NEEDS_HUMAN으로 세웠다

**Date:** 2026-08-26

**Project phase / Goal:** Phase 1 — Asset Inspection Foundation

**Plan / Task / Run / Execution:**
- PLAN-20260826T052332Z
- TASK-002 / RUN-20260826T053857Z-TASK-002 / EXEC-20260826T053857Z-TASK-002

**Runtime stage:** Execute loop (Gate → Verifier 사이), Subject fingerprint

### What happened

`loopctl execute TASK-002`가 다음과 같이 진행됐다.

```
Worker   success -> REVIEW
Gate     PASS  (build PASS · lint PASS · test PASS)
Verifier (실행되지 않음)
Stop     NEEDS_HUMAN / RECOVERY_AMBIGUOUS
         "the repository changed after gates ran;
          the runtime cannot prove that rerunning gates is safe."
```

원인은 subject fingerprint 불일치였다.

| | sha256 | dirty entries |
|---|---|---|
| Gate 시점 | `7b4119a0…308707` | 99 |
| 정지 시점 | `281916c7…2b56df9f` | 100 |

정확히 파일 하나가 늘었다. 그 파일은 **`CLAUDE.local.md`** 이고, mtime은 `14:46:42.211`(= `05:46:42Z`)다. Gate 실행 구간은 `05:46:34.090Z ~ 05:46:49.466Z`였으므로 **Gate가 도는 도중에 생성됐다.**

이 파일은 Worker의 `changed_files`에 없고 (Worker는 `05:46:33.5`에 이미 REVIEW로 전이 완료), 내용도 대화형 세션 운영 지침이다. 즉 Run 바깥에서 사람이 만든, **제품 코드와 아무 관련 없는 파일**이다.

`subject.mjs`는 `.loop-local/`만 제외하고 `git status --untracked-files=all`이 보고하는 전부를 지문에 넣는다. 이 저장소는 초기 커밋 하나뿐이라 사실상 모든 파일이 untracked라서, 작업 트리 아무 곳의 어떤 변경이든 지문을 바꾼다.

결과: Worker와 Gate가 모두 성공했는데도 Verifier가 돌지 않았고, $2.7520을 쓴 Run이 사람 개입 대기 상태로 남았다.

### Expected

Runtime이 멈춘 판단 자체는 옳다 — Gate와 Verifier가 서로 다른 대상을 봤다면 검증은 무의미하다. 문제는 **정지가 유일한 선택지였다는 점**이다.

기대했던 동작: 무엇이 바뀌었는지를 Runtime이 스스로 보고하는 것. 지금은 "저장소가 바뀌었다"만 말하고, 어떤 경로가 추가/변경/삭제됐는지는 알려주지 않는다. `loopctl diagnose TASK-002`도 `No failure recorded / NO_ACTION`만 답한다(Worker도 Gate도 실패하지 않았으므로 진단할 실패가 없다). 그래서 사람이 gate-report의 `verification_subject`를 직접 꺼내 현재 subject를 재계산하고 mtime을 비교해야 원인을 알 수 있었다.

### Current workaround

원인 파일 확정 후 gate 재실행 → verify 순으로 수동 복구.

```
loopctl gate TASK-002 --rerun     # 현재 subject 기준으로 Gate 재실행 (AI 호출 0)
loopctl verify TASK-002           # Gate와 같은 subject에서 Verifier 실행
```

원인을 찾는 데 쓴 명령:

```
node -e "import('./tools/loop-runtime/subject.mjs').then(m=>console.log(m.computeSubject().sha256))"
node -e "console.log(require('./.loop-local/runs/<RUN>/gate-report.json').verification_subject)"
find . -newermt "<gate 시작 시각>" -not -path "./node_modules/*" -not -path "./.git/*" -not -path "./.loop-local/*"
```

### Impact

High — 발생 빈도가 높다. Runtime을 쓰는 동안 사람이 같은 작업 트리에서 메모를 쓰거나 파일을 열어보는 것은 정상적인 행동인데, 그것만으로 성공한 Run이 무효화되고 그때까지의 비용이 검증 없이 남는다. Field Notes 문서를 쓰는 행위(`docs/LOOP-RUNTIME-FIELD-NOTES.md` 편집)조차 실행 중이면 같은 문제를 일으킨다 — 이 Runtime의 운영 규칙 자체가 Runtime을 깨는 구조다.

### Possible Runtime improvement

증거 기준 우선순위:

1. **정지 메시지에 diff를 넣는다.** gate-report에 `verification_subject.entries`(경로 + 해시)를 저장하고, 정지 시 `ADDED / REMOVED / CHANGED` 경로 목록을 출력한다. 지금은 `dirty_entry_count`와 최종 sha256만 남아서 사람이 재구성해야 한다. — 가장 싸고 확실한 개선.
2. **명시적 복구 경로를 CLI로 제공한다.** `loopctl resume <RUN>` 같은 한 명령으로 "gate 재실행 → verify"를 잇는다. 지금은 사람이 두 명령의 순서와 `--rerun` 필요성을 알아야 한다.
3. **subject 범위를 좁힐 수 있게 한다.** `.loop/policies/`에 subject 제외 glob(예: `CLAUDE.local.md`, `docs/LOOP-RUNTIME-FIELD-NOTES.md`, `*.md` 중 Gate 대상이 아닌 것)을 선언 가능하게 한다. 단 이건 검증 엄밀성을 깎는 방향이므로 1·2번을 먼저 하고 반복 사례가 더 쌓인 뒤 판단한다.
4. (장기) per-Task worktree isolation — 이미 `Ideas` 섹션에 있는 항목인데, 이 관찰이 그 아이디어의 **첫 실제 근거**다. 작업 트리를 사람과 Runtime이 공유하는 한 이 문제는 구조적으로 남는다.

### Evidence

- `.loop-local/executions/EXEC-20260826T053857Z-TASK-002/execution-report.json` → `events[2]` (`stop / RECOVERY_AMBIGUOUS`)
- `.loop-local/runs/RUN-20260826T053857Z-TASK-002/gate-report.json` → `verification_subject` (sha `7b4119a0…`, 99 entries)
- `.loop-local/runs/RUN-20260826T053857Z-TASK-002/recovery/diagnosis.json` → `NO_ACTION`
- `tools/loop-runtime/subject.mjs` — `EXCLUDE_PREFIXES = ['.loop-local/']`
- 원인 파일: `CLAUDE.local.md`, mtime `2026-08-26 14:46:42.211 +0900`

### Status

`OBSERVED` — **미해소.** 근본 해결은 per-Task worktree 격리이며 CI-001 · CI-002와 함께 CANDIDATE로 남아 있다.
V0.1에서 고치지 않았다. shared working tree를 쓰는 동안에는 그대로 재현될 수 있다.

---

## OBS-004 — 수동 복구로 Task가 DONE이 돼도 Execution Report는 NEEDS_HUMAN으로 남는다

**Date:** 2026-08-26

**Project phase / Goal:** Phase 1 — Asset Inspection Foundation

**Plan / Task / Run / Execution:**
- TASK-002 / RUN-20260826T053857Z-TASK-002 / EXEC-20260826T053857Z-TASK-002

**Runtime stage:** Execute loop, CLI (status 표시)

### What happened

OBS-003의 `RECOVERY_AMBIGUOUS` 정지를 아래 두 명령으로 수동 복구했고, 복구는 정확히 의도대로 동작했다.

```
loopctl gate TASK-002 --rerun     # PASS  build 4.9s / lint 0.4s / test 9.1s
                                  # 이전 gate 증거는 gate-history/1/ 로 보존됨
loopctl verify TASK-002           # PASS  AC1·AC2·AC3,  51.8s,  $0.4646
                                  # TASK-002: REVIEW -> DONE
```

Gate와 Verifier가 **동일한 subject를 봤음이 기록으로 증명된다** — 양쪽 리포트 모두 `4d6361fa84bee57e…f430bf` (100 entries). 즉 subject 안정성 요구가 실제로 충족됐다.

그런데 `loopctl status` 출력은 이렇게 나온다.

```
DONE
  TASK-002             Create the Phase 1 type foundation and the input-...
      latest execution: NEEDS_HUMAN  (RECOVERY_AMBIGUOUS)
```

Task 상태(DONE)와 latest execution 요약(NEEDS_HUMAN)이 서로 모순돼 보인다. `EXEC-20260826T053857Z-TASK-002/execution-report.json`은 정지 시점에 봉인됐고, 그 뒤 `gate --rerun` / `verify`는 execute 루프 **밖에서** 실행됐으므로 Execution Report에 반영되지 않았다.

### Expected

두 가지 중 하나가 자연스럽다.

- 저수준 명령으로 Run이 최종 상태에 도달하면 Runtime이 해당 Execution Report에 후속 이벤트를 append하거나 `superseded_by` 같은 포인터를 남긴다.
- 또는 `status`가 Task 상태와 execution 요약이 불일치할 때 "수동 복구됨"으로 표시한다.

지금은 나중에 이 프로젝트를 다시 볼 때 "DONE인데 왜 NEEDS_HUMAN이지?"를 다시 조사해야 한다. Run 디렉터리를 열어 gate-report와 verification-report를 확인해야만 실제로 무슨 일이 있었는지 알 수 있다.

### Current workaround

없음. 실제 결과는 `.loop-local/runs/RUN-20260826T053857Z-TASK-002/verification/verification-report.json`이 정본이고, Execution Report는 "execute 루프가 어디서 멈췄는가"의 기록으로만 읽으면 된다. 이 노트가 그 해석을 남기는 역할을 한다.

### Impact

Low — 실제 상태(DONE)와 증거(gate/verify report)는 정확하다. 표시상의 혼동일 뿐이고 잘못된 PASS도 아니다. 다만 OBS-003이 자주 재발하면 이 혼동도 같은 빈도로 따라온다.

### Possible Runtime improvement

- Execution Report에 terminal 여부를 명시하고, 이후 저수준 명령으로 상태가 바뀌면 `superseded_by: <run/verification>`를 append한다.
- 또는 `status`에서 Task가 DONE인데 latest execution이 non-terminal이면 `latest execution: NEEDS_HUMAN (manually recovered)`로 표기한다.
- CI-002(`loopctl resume <RUN>`)가 구현되면 복구가 execute 루프 안에서 일어나므로 이 문제는 자연히 사라진다. → OBS-004는 CI-002의 추가 근거다.

### Evidence

- `.loop-local/runs/RUN-20260826T053857Z-TASK-002/gate-report.json` → `verification_subject.sha256 = 4d6361fa…f430bf`, 100 entries
- `.loop-local/runs/RUN-20260826T053857Z-TASK-002/verification/verification-report.json` → 동일 subject, PASS
- `.loop-local/runs/RUN-20260826T053857Z-TASK-002/gate-history/1/` (OBS-003 시점의 gate 증거)
- `.loop-local/executions/EXEC-20260826T053857Z-TASK-002/execution-report.json` → 여전히 `result: NEEDS_HUMAN`
- `loopctl status` 출력

### Status

`RESOLVED (V0.1)` — `loop/reconcile.mjs`가 사람이 끝낸 복구를 `origin: manual` + `supersedes`로
새 Execution Report에 남긴다. 앞선 Report는 고쳐 쓰지 않는다. V0.1 §5 참조.
(`loopctl resume`(CI-002)은 여전히 별개 CANDIDATE다.)

---

## OBS-005 — Task당 비용이 Run마다 단조 증가한다 (Runtime context는 일정한데 Worker 세션이 커진다)

**Date:** 2026-08-26

**Project phase / Goal:** Phase 1 — Asset Inspection Foundation

**Plan / Task / Run / Execution:** PLAN-20260826T052332Z, TASK-001 ~ TASK-004 전체

**Runtime stage:** Worker, Execute loop (비용/telemetry)

### What happened

Phase 1의 앞 네 Task는 모두 **첫 시도에 Gate·Verifier PASS**했다. retry도 실패도 없었다. 그런데 Task당 비용이 단조 증가했고, 증가폭 자체도 커졌다.

| Task | 결과 | 시간 | 총비용 | Worker | Verifier | Worker output tok | Worker cached_input tok |
|---|---|---|---|---|---|---|---|
| TASK-001 | DONE | 6.1m | $2.0895 | $1.4938 | $0.5957 | 18,679 | 1,275,383 |
| TASK-002 | NEEDS_HUMAN* | 7.9m | $2.7520 | $2.7520 | — | 35,693 | 2,467,434 |
| TASK-003 | DONE | 14.0m | $4.6265 | $3.9183 | $0.7082 | 58,488 | 2,939,290 |
| TASK-004 | DONE | 15.2m | $6.8281 | $6.0060 | $0.8222 | 66,097 | 6,214,735 |

\* TASK-002는 OBS-003으로 Verifier 미실행. 이후 수동 `verify`에 $0.4646 추가 → 실제 $3.2166. Phase 1 누계 **$16.76**.

핵심은 **어느 쪽이 커지는가**다.

- **Verifier는 안정적이다.** $0.5957 → $0.7082 → $0.8222, cached_input은 174,871 / 83,260 / 246,745로 등락만 있다. Verifier context는 고정 스냅샷이라(TASK-002 기준 26.9 KB / 622줄) 경계가 있다.
- **Worker가 전부 끌고 간다.** $1.49 → $2.75 → $3.92 → $6.01, **4배**. cached_input은 1.28M → 2.47M → 2.94M → **6.21M**으로 거의 5배.

그리고 **Runtime이 Worker에게 주는 context는 거의 일정하다.**

```
RUN-...TASK-001  context.md = 9,276 B
RUN-...TASK-002  context.md = 9,086 B
RUN-...TASK-003  context.md = 9,231 B
RUN-...TASK-004  context.md = 9,273 B
```

즉 비용 증가의 원인은 Runtime의 context 조립이 아니다. Worker가 **자기 agentic 세션 안에서 스스로 읽어들이는 양**이다. 작업 트리가 Task마다 커지므로(Phase 1 종료 시점 src/ 누적 1,700줄+) Worker가 기존 코드를 읽고 재확인하는 턴이 늘고, 턴마다 누적 컨텍스트가 다시 실려 cached_input이 제곱에 가깝게 불어난다.

### OBS-002와의 인과 관계 (추정, 미검증)

OBS-002(Worker가 명령을 전혀 실행할 수 없음)가 이 증가를 **증폭**시키고 있을 가능성이 높다. Worker는 테스트를 돌려보는 대신 정적 검증으로 보상하는데, 그 보상 행위가 정확히 컨텍스트를 키우는 행위다. TASK-004 Worker note가 그 증거다.

> "각 fixture의 헤더 크기를 reader의 1024바이트 초기 윈도에 맞춰 **손으로 계산**했다."
> "strict 모드 유무와 무관하게 타입 체크되도록 작성했다 — non-null assertion 없음, ..."

`npm test` 한 번이면 끝날 확인을 파일을 반복해 읽으며 손으로 대신하고 있다. 다만 이건 상관관계 관찰이며, Worker에게 실행 권한을 준 대조군이 없으므로 **인과로 확정하지 않는다.**

### Expected

- 첫 시도에 전부 통과하는 Task들의 비용이 Task 크기가 아니라 **Task 순번**에 따라 오르는 것은 직관에 반한다. 같은 난이도의 Task가 프로젝트 후반이라는 이유만으로 3배 비싸다면 장기 프로젝트에서 Runtime 사용이 성립하지 않는다.
- Runtime이 Worker telemetry를 이미 기록하고 있으므로(`loopctl usage`), **추세를 사람이 계산하지 않아도 보이게** 하는 편이 자연스럽다.

### Current workaround

없음. 사람이 execution-report의 `usage_summary.invocations`를 직접 집계해야 추세가 보인다. 이번에도 아래로 손으로 뽑았다.

```
for e in .loop-local/executions/EXEC-*/execution-report.json; do
  node -e "const r=require('$PWD/$e'); ..."   # task_id, result, duration, cost, tokens
done
```

### Impact

Medium (관찰 시점) → 남은 Task에서 재확인 필요. 추세가 유지되면 High.

TASK-005(얇은 진입점)는 추세가 꺾이는지 보는 대조군이 된다. TASK-007·008은 통합 Task라 가장 비쌀 것으로 예상되며, 이 추세대로면 Phase 1 총액은 $35~45 범위가 된다. **예측이 맞는지는 Phase 종료 후 이 노트에 실측으로 덧붙인다.**

### Possible Runtime improvement

증거가 더 필요한 순서대로:

1. **`loopctl usage`에 Task 간 추세를 보여준다.** 이미 데이터는 다 있다. Run별 worker/verifier 비용과 token을 표로 누적 출력하면 사람이 집계할 필요가 없다. — 가장 싸다.
2. **Task별 예산 상한과 경고.** `.loop/policies/limits.yaml`에 Worker 비용/토큰 상한을 두고 초과 시 경고하거나 정지한다. 지금 `limits.yaml`은 실패 횟수만 다룬다.
3. **Worker context에 "읽어야 할 파일" 힌트를 넣는다.** Planner가 이미 Task별 관련 경로를 알고 있다(P3 → plyHeader, P4 → plyHeader+plyAnalyzer). 그걸 Worker Context에 넘기면 Worker의 탐색 턴이 줄어든다. 단 Worker의 자율 탐색을 제한하는 방향이라 품질 영향을 같이 봐야 한다.
4. **OBS-002 해소(CI-003)가 이 문제도 완화하는지 측정한다.** Worker에게 gate 명령 실행 권한을 준 Run과 그렇지 않은 Run의 비용을 비교하면 위 인과 추정을 검증할 수 있다. → CI-003의 가치가 "편의"가 아니라 "비용"일 수 있다.

### Evidence

- `.loop-local/executions/EXEC-*/execution-report.json` → `usage_summary.invocations[].provider_cost_usd`, `.tokens`
- `.loop-local/runs/RUN-*/context.md` 크기 (9,086 ~ 9,276 B, 변동 2% 미만)
- `.loop-local/runs/RUN-20260826T061218Z-TASK-004/worker-result.json` → `notes` (손 계산 보상 행위)
- 비교 대상 Verifier context: TASK-002 verify 출력 `context: 26.9 KB (24,122 chars, 622 lines)`

### Status

`OBSERVED` — **미해소.** TASK-005 실측 반영, TASK-006 ~ 008로 계속 확인.
비용 추세 표시(CI-004)와 비용 상한(CI-005)은 V0.1에서 구현하지 않았다. 둘 다 CANDIDATE로 남아 있다.

---

## OBS-006 — 실행 중인 Run이 `loopctl status`에 보이지 않아, 세션이 끊기면 살아 있는지 사람이 `ps`로 판단해야 한다

**Date:** 2026-08-26

**Project phase / Goal:** Phase 1 — Asset Inspection Foundation

**Plan / Task / Run / Execution:** PLAN-20260826T052332Z, TASK-005, RUN-20260826T064142Z-TASK-005, EXEC-20260826T064141Z-TASK-005

**Runtime stage:** status / execution 조회 (관측성)

### What happened

`loopctl execute TASK-005 --adapter claude --timeout 1800`을 띄운 인터랙티브 세션이 조작 실수로 종료됐다. loopctl 프로세스 자체는 tty에서 분리돼 **살아남았다** — 이건 올바른 동작이고 실제로 실행은 정상 완료됐다.

문제는 새 세션에서 그 사실을 확인할 방법이 Runtime 안에 없었다는 점이다.

```
$ ./loopctl status
IN PROGRESS
  TASK-005
    latest run: (none)

$ ./loopctl execution TASK-005
no execution found for TASK-005
```

이 시점에 `.loop-local/runs/RUN-20260826T064142Z-TASK-005/`는 이미 존재했고 `context.md`(8,447 B)와 `manifest.json`이 쓰여 있었다. 그런데 `status`는 `latest run: (none)`, `execution`은 `no execution found`를 반환했다. Run/Execution 레코드가 **종료 시점에만** 기록되기 때문이다.

살아 있는지는 결국 Runtime 밖에서 확인했다.

```
$ ps aux | grep loopctl
99347  /bin/bash -c ... eval './loopctl execute TASK-005 ...'
99349  node tools/loop-runtime/loopctl.mjs execute TASK-005 --adapter claude --timeout 1800
99364  claude --print --output-format json --permission-mode acceptEdits ...
```

`.loop-local/leases/`는 비어 있었다(`.gitkeep`만). lease 디렉터리가 존재하는데 실행 중 Run이 lease를 남기지 않는다.

**부수 관측 — 좀비 프로세스가 생존 폴링을 오판시킨다.** 부모 세션이 죽은 뒤 execute가 끝나자 wrapper bash(99347)가 `Zs [bash] <defunct>`로 남았다. 이를 reap할 부모가 없어 `kill -0 99347`이 계속 성공한다. 실제로 이 세션에서 PID 생존을 폴링하는 감시를 걸었다가 실행이 끝난 뒤에도 8분간 "실행 중"으로 오판했고, run 디렉터리 mtime과 자식 PID(99349/99364) 소멸을 보고서야 정정했다. PID 폴링은 이 Runtime에서 신뢰할 수 없는 신호다.

### Expected

- Run 시작 시점에 execution 레코드가 생기고 `status` / `execution`이 `RUNNING`(run_id, 시작 시각, 경과, 타임아웃)을 보여줘야 한다. 종료 시에만 기록하면 크래시·세션 단절 후 상태 복원이 원리적으로 불가능하다.
- 생존 판정 근거를 Runtime이 제공해야 한다. `.loop-local/leases/`가 이미 있으니 PID + heartbeat + timeout을 여기에 남기면 `status`만으로 "돌고 있음 / 죽었음(stale lease)"을 구분할 수 있다.

### Current workaround

`ps aux | grep loopctl` + run 디렉터리 mtime + `worker-result.json` 존재 여부로 사람이 추론. 생존 확인은 **wrapper PID가 아니라 node loopctl PID와 worker PID**로 해야 한다(위 좀비 문제).

### Impact

Medium. 진행 자체는 막히지 않았고 실행은 16m 22s만에 정상 DONE으로 끝났다. 하지만 "죽었나 살았나"를 판단하는 데 프로세스 수준 지식과 사람 개입이 필요했다. 죽은 걸로 오판하고 재실행했다면 동일 Task를 이중 실행해 shared working tree에서 충돌했을 것이다 — OBS-003이 기록한 subject staleness와 정확히 같은 실패 모드로 이어진다.

### Possible Runtime improvement

- Run 시작 시 execution 레코드 선기록 (`result: RUNNING`), 종료 시 갱신.
- `.loop-local/leases/<TASK-ID>.json`에 `{pid, run_id, started_at, timeout_s, heartbeat_at}` 기록. `status`가 heartbeat로 RUNNING / STALE 판정.
- `loopctl watch <TASK>` — 진행 중 Run의 stage 전이를 따라가는 조회 명령.

### Evidence

- `.loop-local/runs/RUN-20260826T064142Z-TASK-005/` (실행 중 `context.md` + `manifest.json`만 존재)
- `.loop-local/leases/` (비어 있음)
- `.loop-local/executions/EXEC-20260826T064141Z-TASK-005/execution-report.json` (종료 후에야 생성)

### Status

`RESOLVED (V0.1)` — CI-008. 활성 표식이 `heartbeat_at` · `stage` · `run_id`를 유지하고
`loopctl status`가 RUNNING/STALE을 표시한다. 생존 판정은 heartbeat가 정본이고 PID는 보조다
— 좀비 PID를 active로 오판하던 문제가 여기서 사라졌다. V0.1 §4 참조.

---

## OBS-007 — Worker가 Gate를 못 돌려 타입 한 줄 때문에 Attempt 1 전체($4.04, 9분)가 폐기됐다 — OBS-002의 첫 실측 비용

**Date:** 2026-08-26

**Project phase / Goal:** Phase 1 — Asset Inspection Foundation

**Plan / Task / Run / Execution:**
- PLAN-20260826T052332Z, TASK-005, EXEC-20260826T064141Z-TASK-005
- attempt 1: RUN-20260826T064142Z-TASK-005 (gate FAIL)
- attempt 2: RUN-20260826T065104Z-TASK-005 (gate PASS, verifier PASS)

**Runtime stage:** Worker capability → Gate → Diagnose → Retry

> OBS-002(Worker가 명령을 실행할 수 없음)의 **비용 근거**다. TASK-001~004는 전부 첫 시도에 통과해서 이 제약이 retry 비용으로 표면화되지 않았다. TASK-005가 첫 실측이다.

### What happened

attempt 1의 Gate 결과는 lint PASS, test PASS(98/98, 5 files), **build만 FAIL(exit 2)**. 오류는 정확히 하나, 테스트 헬퍼의 파라미터 타입이 너무 넓었다.

```
src/analyzers/assetAnalyzer.test.ts(79,29): error TS2322:
Type 'Uint8Array<ArrayBufferLike>' is not assignable to type 'BlobPart'.
```

attempt 2가 한 일은 헬퍼 파라미터를 `Uint8Array` → `Uint8Array<ArrayBuffer>`로 좁힌 **타입 주석 한 줄 수정**이다. 프로덕션 소스 변경 없음, 테스트 추가·삭제·약화 없음.

그 한 줄의 값:

| | Worker attempt 1 | Worker attempt 2 | Verifier | 합계 |
|---|---|---|---|---|
| 비용 | $4.0375 | $2.9554 | $0.7380 | **$7.7309** |
| 시간 | 539.5s | 308.5s | 86.3s | 16m 22s |
| output tok | 44,309 | 21,962 | — | 72,029 |
| cached_input tok | 3,810,510 | 3,212,858 | — | 7,240,150 |

attempt 1의 **$4.04 / 9분이 전량 폐기**됐다. 낭비 비율 52%. 이 오류를 잡는 데 필요한 것은 `tsc -b` 한 번이었고, Runtime이 gate로 돌렸을 때 실제 소요는 **3.9초**였다(`gate-report` build gate `duration_ms: 3961`).

원인은 추정이 아니다. Worker가 직접 원인과 코드 위치를 적었다.

> "GATE EXECUTION LIMITATION: this Worker could not run the build/lint/test gates locally. The Runtime launches the Worker with `--permission-mode acceptEdits` (tools/loop-runtime/adapters/claude.mjs:67), which auto-approves file edits but not Bash, and the Run is non-interactive, so 'npm run build', 'npm test', 'npm run lint', 'npx tsc' and 'node_modules/.bin/tsc' all returned 'This command requires approval'."

읽기 전용 명령은 허용되므로, Worker는 대신 `node_modules/typescript/lib/lib.es5.d.ts`와 `lib.dom.d.ts`를 직접 읽어 **TypeScript 5.7부터 typed array 인터페이스가 제네릭이 되어 bare `Uint8Array`가 `Uint8Array<ArrayBufferLike>`로 기본 해석되고, 이는 `SharedArrayBuffer`를 허용하므로 `BufferSource`를 만족하지 못한다**는 근본 원인까지 정확히 규명했다. 진단은 완벽했다. 다만 그 진단을 **3.9초짜리 명령 대신 파일을 반복해 읽어서** 했다 — OBS-005가 가설로 제시한 "정적 검증으로 보상하는 행위가 컨텍스트를 키운다"의 직접 사례다(attempt 1 cached_input 3.81M).

### 잘 동작한 부분 (기록해둘 가치가 있음)

복구 경로 자체는 설계대로 작동했다. Diagnose가 `GATE_FAILURE → RETRY_WITH_HINT`로 정확히 분류했고(`llm_calls: 0`, 결정적 판정), `subject_check.matches: true`로 subject 무결성을 확인했으며, failure memo가 build stderr 발췌와 "테스트를 지우거나 약화시켜 gate를 통과시키지 말라"는 hint를 attempt 2에 넘겼다. attempt 2는 그 한 줄만 고쳤다. **Runtime의 retry는 문제가 아니다. 문제는 retry가 필요했다는 것이다.**

### Expected

`build` / `lint` / `test`는 Runtime이 이미 `stop_condition.gates`로 알고 있고, `gate_sources`에 AC 연결까지 기록한다. **그 명령만 allow-list로 Worker에게 열어주면** 이 유형의 retry는 Worker 세션 안에서 흡수된다. Worker가 임의 명령을 실행할 필요는 없다 — Runtime이 어차피 돌릴 명령만 미리 돌려보게 하면 된다.

### Current workaround

없음. Runtime retry가 흡수하며, 비용은 그대로 지불한다.

### Impact

**High.** CI-003(Worker capability 선언)을 넘어 **Worker에게 gate 명령 실행 권한을 주는 것**이 실제 금액으로 정당화된 첫 사례다. TASK-006~008은 UI·통합 Task라 타입/빌드 실패 가능성이 더 높고, 같은 낭비가 반복될 것으로 예상한다.

### Possible Runtime improvement

- adapter 설정에 gate 명령 allow-list를 넣어 Worker에게 `stop_condition.gates`에 선언된 명령만 실행 허용.
- 또는 `loopctl gate --self-check` — subject를 건드리지 않고 gate만 돌리는 Worker 전용 진입점.
- 최소한: Worker Context에 "이 Run에서 gate 명령을 실행할 수 없다"를 **사실로 선언**해 Worker가 하나씩 시도하며 알아내는 턴(과 그 컨텍스트)을 없앤다. (= CI-003)

### Evidence

- `.loop-local/runs/RUN-20260826T064142Z-TASK-005/gate-report.json` → `result: FAIL`, build exit 2, `duration_ms: 3961`
- `.loop-local/runs/RUN-20260826T064142Z-TASK-005/recovery/failure-memo.json` → `failure_class: GATE_FAILURE`, stderr 발췌
- `.loop-local/runs/RUN-20260826T064142Z-TASK-005/recovery/diagnosis.json` → `RETRY_WITH_HINT`, `llm_calls: 0`, `subject_check.matches: true`
- `.loop-local/runs/RUN-20260826T065104Z-TASK-005/worker-result.json` → `notes` (원인 규명 + GATE EXECUTION LIMITATION 원문)
- `.loop-local/executions/EXEC-20260826T064141Z-TASK-005/execution-report.json` → `usage_summary.invocations[]`

### Status

`RESOLVED (V0.1)` — CI-006. `loopctl self-check`로 Worker가 설정된 Gate 명령을 미리 돌려볼 수 있다.
$4.04 / 9분 폐기라는 실측은 위 본문에 그대로 둔다 — 이 기능의 근거이기 때문이다. V0.1 §2 참조.

---

## OBS-008 — Worker가 self-check 불가를 "AC를 글로 논증하기"로 보상한다 (8/9 Run에서 정착된 패턴)

**Date:** 2026-08-26

**Project phase / Goal:** Phase 1 — Asset Inspection Foundation (종료)

**Plan / Task / Run / Execution:** PLAN-20260826T052332Z, TASK-006 / RUN-20260826T070648Z, TASK-007 / RUN-20260826T071431Z, TASK-008 / RUN-20260826T072745Z

**Runtime stage:** Worker (OBS-002 / OBS-007의 행동적 귀결)

### What happened

Phase 1 마지막 세 Task는 전부 첫 시도에 Gate·Verifier PASS했다. 그런데 Worker note를 보면 **매 Run이 같은 서두로 시작한다.**

- TASK-006: `"GATES NOT RUN BY THIS WORKER."`
- TASK-007: `"GATES NOT RUN BY THIS WORKER (same environment constraint recorded by TASK-006)."`
- TASK-008: `"gate commands could not be run locally because this Run's sandbox denies command execution."`

Worker는 거부당한 명령을 **일일이 나열한다**. TASK-007만 해도 `npm test`, `npm test 2>&1`, `npm run lint`, `npx vitest run src/utils/fileSize.test.ts`, `node node_modules/vitest/vitest.mjs run ...`, `./node_modules/.bin/vitest run`, `node -e "console.log(1+1)"` — 일곱 가지를 시도하고 전부 거부당한 뒤에야 포기했다. 이 탐색은 **Run마다 처음부터 반복된다.** Runtime이 "이 Run에서는 명령을 실행할 수 없다"를 사실로 알려주지 않기 때문이다.

그 다음이 더 비싸다. 실행으로 확인할 수 없으니 Worker는 **AC를 문장으로 논증한다.** TASK-006/007 note는 `AC mapping. AC1: ... Covered by the tests '...'` 형태로 각 AC를 코드 인용과 함께 수천 자에 걸쳐 정당화한다. TASK-007 Worker는 자기가 무엇을 하고 있는지 정확히 적었다.

> "Because I could not execute the suite, every new test was written against behaviour I could verify by **reading** (Testing Library's getNodeText only sees direct text-node children, ...)."

즉 **테스트를 돌리는 대신 테스트 라이브러리의 동작을 읽어서 추론**하고 있다. 결과적으로 옳았지만(131개 테스트 전부 통과), 그 정확성은 `vitest run` 12.9초로 얻을 수 있는 것을 토큰으로 산 것이다.

### Expected

OBS-002가 제안한 preflight로 충분하다. Runtime이 Worker Context에 **"이 Run에서 실행 가능한 명령 = 없음 / gate 명령만 / 전부"**를 사실로 선언하면:

1. 매 Run 반복되는 7회짜리 거부 탐색이 사라진다.
2. Worker가 "실행으로 확인 못 함"을 처음부터 알고 논증 분량을 조절할 수 있다.
3. (CI-006이 구현되면) 애초에 이 보상 행위 자체가 불필요해진다.

### Current workaround

없음. Worker의 정직성 덕분에 **잘못된 PASS 주장은 한 번도 없었다** — 이건 기록해둘 가치가 있는 긍정 신호다. 모든 Worker가 "AC4/AC5는 Runtime gate만이 권위"라고 명시하고 판정을 위임했다. 위험한 실패 모드(Worker가 돌려보지도 않고 통과를 주장)는 발생하지 않았다.

### Impact

Medium. Phase 1에서 이 보상 행위가 **잘못된 결과로 이어진 적은 없다**(8 Task 중 gate 실패 1회, 그것도 타입 한 줄). 비용 측면의 낭비이지 정확성 문제는 아니다. 다만 OBS-005 실측상 Worker 비용이 Phase 비용의 88%($31.7 / $36.0)를 차지하므로, 이 보상 행위를 없애는 것이 비용 개선의 주 레버다.

### Possible Runtime improvement

CI-003(capability 선언) + CI-006(gate 명령 allow-list). 새로운 항목은 없다 — 이 관찰은 **두 후보의 우선순위를 올리는 추가 증거**다.

### Evidence

- `.loop-local/runs/RUN-20260826T070648Z-TASK-006/worker-result.json` → `notes` (거부 명령 목록, evidence 디렉터리 전수 확인)
- `.loop-local/runs/RUN-20260826T071431Z-TASK-007/worker-result.json` → `notes` ("written against behaviour I could verify by reading")
- `.loop-local/runs/RUN-20260826T072745Z-TASK-008/worker-result.json` → `summary`
- Phase 1 독립 재확인 (Runtime 정지 후 조작자 실행): `npm run build` exit 0, `npm test` 131 passed / 9 files, `npm run lint` exit 0 (warning 1건)

### Status

`RESOLVED (V0.1)` — CI-003 + CI-006. 단독 개선 항목은 아니었고 두 후보의 우선순위를 올린 증거였다.
self-check가 생기면서 "AC를 글로 논증하기"로 보상할 이유 자체가 없어졌다. V0.1 §1 · §2 참조.

---

## OBS-009 — Verifier가 "사람이 dev server로 수동 확인했다"는 근거 없는 주장을 PASS시켰다

**Date:** 2026-08-26

**Project phase / Goal:** Phase 1 — Asset Inspection Foundation (종료)

**Plan / Task / Run / Execution:** PLAN-20260826T052332Z, TASK-008, RUN-20260826T072745Z-TASK-008, EXEC-20260826T072744Z-TASK-008 (DONE, verifier PASS)

**Runtime stage:** Verifier

### What happened

TASK-008이 생성한 `docs/PHASE-1.md` §3에 다음 문장이 있다 (227~229행).

> "**Browser-only checks.** The app has been exercised through jsdom-based tests **and manual use in a dev server**; there is no cross-browser or large-file (GB-scale) measurement recorded anywhere in this repository."

**"manual use in a dev server"는 일어나지 않은 일이다.**

- Worker는 `npm run dev`는커녕 `node -e`도 실행할 수 없었다 (OBS-002 / OBS-007 / OBS-008, Phase 1 9개 Run 전부).
- 조작자(사람)도 Phase 1 동안 dev server를 띄운 적이 없다. 저장소 어디에도 그 흔적이 없다.
- TASK-008 Worker의 `worker-result.json`에는 `npm run dev`나 dev server 언급 자체가 없다.

문장의 **의도**는 제약을 밝히는 것이었고 뒷절("cross-browser·대용량 측정 기록 없음")은 정확하다. 하지만 앞절은 검증 범위를 실제보다 넓게 주장한다. 아이러니하게도 이 문장은 **"현재 제약" 섹션**에 있다 — 제약을 적으면서 하지 않은 검증을 했다고 적었다.

Verifier는 이 Task를 PASS시켰다. 문서 형식(PRODUCT-SPEC §50)과 코드-문서 일치는 검사했지만, **문서가 저장소 밖 세계에 대해 하는 주장은 검사 대상이 아니었다.**

### Expected

Verifier가 "저장소 안에 증거가 없는 사실 주장"을 잡아내야 한다. 특히 이번 배치처럼 **Worker가 명령을 실행할 수 없는 환경**이라면, 실행·수동 조작·측정을 주장하는 문장은 원리적으로 전부 근거가 없다. Runtime은 그 사실(Worker capability)을 알고 있으므로 Verifier에게 넘겨줄 수 있다.

이건 OBS-002가 기록한 것과 같은 실패 형태다. TASK-001에서도 Goal이 요구한 외부 검증이 환경적으로 불가능했는데 Verifier가 PASS했다 — 그때는 AC가 `UNVERIFIED` fallback을 명시적으로 허용해서 정당했지만, 이번엔 **아무도 허용하지 않은 주장이 그냥 통과했다.**

### Current workaround

조작자가 Phase 종료 시 산출 문서를 직접 읽는다. 이번에도 그렇게 발견했다. 자동 검출 경로는 없다.

### Impact

Medium. 제품 동작에는 영향이 없다 (코드·테스트는 정확하고 131개 테스트 전부 통과). 하지만 **Phase 산출 문서는 다음 Phase의 입력이자 사람의 판단 근거**다. "수동 확인됨"이 문서에 남으면 Phase 2에서 브라우저 실측을 건너뛸 근거로 오독될 수 있다. 문서가 검증 상태를 과장하는 것은 OBS-002가 경계한 "VERIFIED / UNVERIFIED 구분 붕괴"와 같은 종류의 문제다.

### Possible Runtime improvement

- Verifier Context에 **이 Run의 Worker capability**(명령 실행 불가 / 네트워크 불가)를 사실로 포함한다. 그러면 Verifier가 "실행했다 / 측정했다 / 수동 확인했다" 류 주장을 자동으로 의심할 수 있다. — CI-003의 Verifier 측 대응.
- 문서 산출 Task의 AC에 "저장소 안에 증거가 없는 사실 주장을 포함하지 않는다"를 Planner가 넣도록 하는 것도 방법이지만, 이건 Task마다 사람이 챙겨야 하므로 위쪽이 낫다.

### Evidence

- `docs/PHASE-1.md:227-229`
- `.loop-local/runs/RUN-20260826T072745Z-TASK-008/worker-result.json` (dev server 언급 없음)
- `.loop-local/runs/RUN-20260826T072745Z-TASK-008/verification/` (PASS 판정)
- 대조: OBS-002 (TASK-001 외부 검증 불가 + Verifier PASS, 단 AC가 fallback 허용)

### Status

`RESOLVED (V0.1)` — CI-009. Verifier Context에 WITNESSED EXECUTION / NOT WITNESSED가 들어가고
`evidence_basis`가 필수가 되었다. `unwitnessed_claim`에 PASS를 주면 Runtime이 결정론적으로 거부한다.
V0.1 §3 참조.

---

# V0.1 Maintenance Pass — 무엇이 고쳐졌는가

**Date:** 2026-08-26 (Phase 1 종료 직후, Phase 2 시작 전)

이 절은 위 관찰들에 대해 **실제로 무엇을 바꿨는지**를 증거와 함께 적는다.
근거 없이 Runtime을 고치지 않는다는 원칙에 따라, 여기 있는 항목은 전부 위쪽
Observation에서 실측된 것들이다. 추측으로 추가한 기능은 없다.

Runtime 회귀 스위트: **121 tests / 121 pass / 0 fail** (변경 전 74 → 새 회귀 47건 추가).
제품 회귀: `npm test` 131 passed / 9 files, `npm run build` exit 0, `npm run lint` exit 0.
`loopctl doctor` exit 0.

## 1. Worker Evidence 쓰기 정책 일치 (OBS-002 후속 · CI-007)

**증상.** fingerprint는 `.loop/evidence` 를 Worker 쓰기 영역으로 예외 처리하는데
deny 규칙은 `.loop/**` 를 통째로 막았다. KERNEL이 지시한 Evidence 쓰기가 Phase 1
**8 Task / 9 Run 전부**에서 거부됐고, `.loop/evidence/TASK-001~008` 은 전량 비어 있었다.

**고친 방법.** 두 정책의 출처를 `worker/policy.mjs` 하나로 합쳤다.

- deny 규칙은 이제 `.loop/` 를 열거해서 만든다 — **이 Task의 Evidence 디렉터리만 빼고** 전부.
- fingerprint 예외도 같은 함수에서 나온다. `.loop/evidence` 전체가 아니라
  `.loop/evidence/<이 Task>` 하나다. 다른 Task의 Evidence는 이제 fingerprint 대상이라
  손대면 policy violation으로 잡힌다.
- 예방(deny 열거)과 탐지(fingerprint)의 경계가 같은 사실에서 유도된다. 열거가 놓치는
  경우(Run 도중 새로 생긴 경로)는 fingerprint가 잡으므로 열거의 완전성을 주장하지 않는다.

**회귀 테스트** — `test/policy.test.mjs` 6건:
자기 Evidence 쓰기가 violation이 아님 · 남의 Evidence 쓰기는 violation ·
`.loop/**` 통째 deny 규칙이 사라졌음 · KERNEL 수정은 여전히 violation ·
Runtime이 Evidence 디렉터리를 미리 만들어 둠.

## 2. Worker Self-check (OBS-007 · OBS-008 · CI-006)

**증상.** Worker가 `npm run build` 를 못 돌려 타입 한 줄 때문에 TASK-005 Attempt 1
전체($4.04 / 9분, 낭비율 52%)가 폐기됐다. Gate가 그 오류를 잡는 데 걸린 시간은 3.9초였다.

**고친 방법.** Bash 전체를 열지 않는다. Runtime 소유 진입점 하나만 연다.

- `loopctl self-check [<gate> ...]` — **project.yaml에 설정된 Gate 명령만** 실행한다.
  인자는 Gate 이름일 뿐 명령 문자열이 아니다. 해석되지 않는 이름은 아무것도 실행하지 않는다.
- 실행에는 기존 `gate/runner.mjs` 의 `executeGate` 를 그대로 쓴다 — 같은 명령을 두 가지
  방식으로 실행하는 경로를 만들지 않기 위해서다. 산출물은 `.loop-local/self-check/` 로 가고
  **Gate Report를 만들지 않으며 Run 디렉터리에도 Task 상태에도 쓰지 않는다.**
- Worker permission의 allow 목록은 **정확히 한 줄**이다:
  `Bash(node tools/loop-runtime/loopctl.mjs self-check:*)`.
  `Bash(npm ...)` 같은 규칙은 넣지 않는다 — 그러면 Gate 설정을 우회하는 두 번째 출처가 생긴다.
- **정본 Gate 실행은 그대로다.** Runtime은 Worker 종료 후 Gate를 독립적으로 다시 돌리고,
  완료 판정은 그쪽만이 근거다. self-check 출력에도 `advisory` 라고 명시한다.

**회귀 테스트** — `test/policy.test.mjs` 7건:
allow 목록이 정확히 한 줄인지 · 설정되지 않은 Gate 이름 거부 ·
`build; touch pwned` / `$(touch pwned)` 같은 인자가 **명령이 되지 못하고** 거부되는지 ·
비활성 Gate에 PASS를 지어내지 않는지 · self-check가 Gate Report/Run/Task 상태를
만들지 않는지 · Worker 이후 Gate가 여전히 독립적으로 도는지.

## 3. Verifier 증거 요구 (OBS-009 · CI-009)

**증상.** `docs/PHASE-1.md` 가 "manual use in a dev server" 를 서술했고 Verifier가 PASS했다.
그 실행은 일어난 적이 없다 — Worker는 `node -e` 도 못 돌렸고 사람도 dev server를 띄우지 않았다.

**고친 방법.** 두 겹이다. Runtime이 사실을 주고, 계약이 그것을 강제한다.

*(a) Runtime이 목격한 실행을 사실로 선언한다.* Verifier context의 `RUNTIME FACTS` 에
`WITNESSED EXECUTION`(이 Run에서 Runtime이 실제로 돌린 명령 목록)과
`NOT WITNESSED BY THE RUNTIME`(수동 조작 · 브라우저 · dev server · 네트워크 · 외부 서비스 ·
실물 렌더링)을 명시한다. 이것은 Runtime 소유 사실이며 Worker의 주장이 아니다.
Verifier 격리(Input 분리)는 그대로다 — Worker 요약·narrative·stdout은 여전히 들어가지 않는다.

*(b) 판정 계약에 근거를 필수로 넣었다.* `criteria[]` 의 각 항목은 `evidence_basis` 를 갖는다:

| 값 | 의미 |
|---|---|
| `gate` | Runtime이 직접 실행한 Gate 결과 |
| `runtime_artifact` | Runtime이 만든 Run 산출물 (`evidence_refs` 필수) |
| `canonical_diff` | Runtime이 만든 변경 매니페스트/패치 |
| `repository_content` | 저장소에 실제로 존재하는 파일 (`evidence_refs` 필수) |
| `unwitnessed_claim` | 이 AC는 Runtime이 목격하지 못한 실행을 요구한다 |

**"Worker가 그렇게 말했다"에 해당하는 값은 존재하지 않는다.** 서술은 근거가 아니다.

결정론적 강제(Runtime이 직접 확인, LLM 판단 아님):

- `unwitnessed_claim` + `PASS` → **거부**. 이것이 OBS-009를 막는 규칙이다.
- `runtime_artifact` / `repository_content` + `PASS` → `evidence_refs` 가 비었거나
  존재하지 않는 경로를 가리키면 거부.
- `gate` + `PASS` → 이 Run이 Gate를 하나도 실행하지 않았으면 거부.
- `canonical_diff` + `PASS` → canonical diff가 비었으면 거부.
- FAIL 판정에는 근거 존재를 요구하지 않는다 — 없다는 것이 곧 실패 사유다.

`.loop/skills/verifier.md` 계약에 규칙 5b·5c를 추가했다: 산출물이 그런 실행을 했다고
**서술**하더라도 Runtime Facts가 뒷받침하지 않으면 사실로 받아들이지 않는다.

**회귀 테스트** — `test/verifier-evidence.test.mjs` 12건.
5개 `unwitnessed_kind` 전부에 대해 PASS 거부 · 존재하지 않는 artifact 인용 거부 ·
근거 없는 gate/canonical_diff 주장 거부 · 지어낸 basis 값(`worker_narrative` 등) 거부 ·
FAIL로 표시된 unwitnessed는 정상 경로 · Verifier 격리 불변 확인.

## 4. 진행 중인 실행의 가시성 (OBS-006 · CI-008)

**증상.** 세션이 끊긴 뒤 `status` 는 `latest run: (none)`, `execution` 은
`no execution found` 를 반환했다. 실제로는 16분짜리 실행이 돌고 있었다.
게다가 wrapper bash가 좀비(`Z`)로 남아 PID 폴링이 8분간 "실행 중"으로 오판했다.

**고친 방법.** 이미 있던 `.loop-local/executions/active/<TASK>.json` 표식을 실제 상태로 만들었다.

- 표식에 `heartbeat_at` · `stage` · `run_id` · `attempt` 를 넣고 **매 단계마다 갱신**한다.
- 생존 판정의 정본은 **heartbeat**다. PID는 보조 신호로만 본다.
  `classifyActiveMarker()` 는 heartbeat가 `HEARTBEAT_STALE_MS`(5분)를 넘으면
  **PID가 살아 있어도** `STALE` 로 판정한다 — 좀비 오판을 구조적으로 막는다.
- `status` 에 `ACTIVE EXECUTION` 섹션이 생겼다. RUNNING/STALE, 실행 ID, 현재 단계,
  Run ID, 판정 근거("heartbeat 2s ago")를 보여준다. STALE이면 회수 방법도 알려준다.
- `claimExecution()` 도 같은 판정을 쓴다. heartbeat가 살아 있고 PID도 살아 있을 때만
  중복 실행을 거부하고, 그 외에는 표식을 회수한다.

**회귀 테스트** — `test/operability.test.mjs` 5건:
살아 있는 PID + 끊긴 heartbeat = STALE(좀비 시나리오) · status의 RUNNING 표시와 단계 ·
STALE 표시와 회수 안내 · 살아 있는 표식은 거부하고 좀비 표식은 회수 · 종료 시 표식 제거.

## 5. 수동 복구 조정 (OBS-004 · CI-002 관련)

**증상.** `execute` 가 멈춘 뒤 사람이 `gate` + `verify` 로 Task를 DONE으로 만들면,
Task는 DONE인데 "latest execution"은 영원히 NEEDS_HUMAN으로 남았다.

**진단.** 표시 문제가 아니라 **기록의 공백**이었다. 그 복구를 수행한 실행이 어디에도
기록되지 않았다. 그래서 표시를 손대는 대신 기록을 채웠다.

**고친 방법 (`loop/reconcile.mjs`).**

- 사람이 CLI로 REVIEW → DONE을 만들면, 그것도 Execution Report로 남긴다.
  `origin: 'manual'` · `stop_reason: 'MANUAL_RECOVERY'` · `manual_stages: ['gate','verify']`.
- **앞선 Report는 절대 고쳐 쓰지 않는다.** 그것은 그때 실제로 일어난 일의 기록이다.
  새 Report가 `supersedes: <이전 EXEC-ID>` 로 관계를 명시한다.
- 사용량은 그 Run의 정본 telemetry에서만 모은다. 없는 값을 지어내지 않는다.
- 오케스트레이터가 몰고 있는 중이면(활성 표식 존재) 기록하지 않는다 — 그쪽이 자기 Report를 쓴다.
- 부수적으로 `status` 는 Report의 `final_task_status` 와 현재 Task 상태가 다르면
  `[superseded — task is now X]` 를 덧붙인다. 이건 Runtime 사실이지 표시 보정이 아니다.

**resume을 만들지 않은 이유.** 사람이 이미 끝낸 일을 사실대로 적는 것으로 이 관찰은
해소된다. Worker/Gate/Verifier를 다시 돌리지 않고 LLM도 부르지 않는다.
CI-002(`loopctl resume <RUN>`)는 별개 문제로 남겨 둔다 — 근거가 더 필요하다.

**회귀 테스트** — `test/operability.test.mjs` 5건:
수동 복구가 자기 Execution으로 기록됨 · 멈춘 Report를 status가 더 이상 최신으로
보고하지 않음 · 앞선 Report 파일이 **바이트 단위로 그대로**인지 · 아직 유효한 Report는
superseded로 표시하지 않음 · 오케스트레이션 실행은 수동 기록을 만들지 않음.

## 6. Plan 단위 순차 실행 (`loopctl execute-plan`)

Phase 1에서 조작자가 손으로 반복한 절차(`ready` → `execute` → 결과 확인 → 다음 `ready`)를
Runtime이 결정론적으로 수행한다. **새 오케스트레이션 로직은 없다** — Task 하나의
Worker · Gate · Verifier · Diagnose · Retry는 전부 기존 `executeTask` 가 그대로 소유한다.
`loop/plan-executor.mjs` 가 하는 일은 "다음에 무엇을 실행할지" 고르는 것 하나뿐이다.

- **승인된 Plan에만** 동작한다. `approval.json` 의 `created_task_ids` 를 쓴다.
  승인하지 않고, Goal 단위·다중 Phase 자동 승인도 하지 않는다.
- READY는 Runtime 의존성 규칙(`readyTasks`)을 그대로 쓴다. 순서는 Plan의 Task 생성 순서.
- **한 번에 Task 하나.** shared working tree이므로 동시에 실행하지 않는다.
- DONE이면 READY를 다시 계산하고 이어간다. 전부 DONE이면 `PLAN_COMPLETE`.
- 사람이 필요한 정지에서 **즉시** 멈춘다:
  NEEDS_HUMAN · STALLED · LIMIT_REACHED · BLOCKED · FAILED · INTERRUPTED · PAUSE ·
  `PLAN_TASK_MISSING` · `PLAN_TASK_INVALID` · `PLAN_TASK_BLOCKED` · `PLAN_NO_READY_TASK`.
  READY가 없으면 왜 못 가는지(무엇을 기다리는지) 사실대로 적고 멈춘다.
- Plan 실행 보고서를 `.loop-local/plans/<PLAN>/executions/PLANEXEC-<stamp>.json` 에 남긴다.
- **재시작은 상태가 필요 없다.** 매 순회마다 Task 상태를 디스크에서 다시 읽으므로
  같은 명령을 다시 실행하면 남은 Task부터 이어간다.
- **오케스트레이션 판단에 LLM을 쓰지 않는다.** 보고서의 `orchestration_llm_calls: 0` 이
  그 사실을 기록하고, 회귀 테스트가 그 값을 검사한다.

**회귀 테스트** — `test/plan-execution.test.mjs` 12건:
미승인 Plan 거부 · execute-plan이 승인하지 않음 · 의존 순서대로 전부 DONE ·
추가 LLM 호출 0 · 실행이 겹치지 않음(앞 실행 종료 후 다음 시작) · 실패 시 즉시 정지와
뒤 Task 무손상 · PAUSE 정지 · 재실행 시 남은 Task만 · 완료된 Plan은 no-op ·
BLOCKED Task 정지 · 존재하지 않는 Task 참조 거부.

## 부수 발견 — 이번 작업 중 드러난 것

**yaml-lite가 double-quoted scalar의 `\"` 이스케이프를 처리하지 않는다.**
테스트 fixture의 Gate 명령 `"node -e \"process.exit(0)\""` 이 파서를 통과하면 백슬래시가
그대로 남아 `/bin/sh` 에서 문법 오류가 났다. Phase 1에서 드러나지 않은 이유는 그 Gate가
**한 번도 실행된 적이 없었기** 때문이다(Task들의 `stop_condition.gates` 가 비어 있었다).

- 영향: `project.yaml` 의 Gate 명령에 큰따옴표를 쓰면 실행 불가능한 명령이 된다.
- 위험도: 낮음. 결과는 Gate ERROR/FAIL이므로 **fail-closed**다. 거짓 PASS는 만들지 않는다.
- 당시 처리(2026-08-26, V0.1 유지보수 중): 파서를 고치지 않았다. 요청된 6개 항목 밖이고
  파서 변경은 `project.yaml` 전체에 영향을 준다. fixture의 Gate 명령을 `node --version` 으로
  바꿔 회귀를 살렸다. CI-010으로 기록만 남겼다.
- **후속(2026-08-26, CI-010 최소 수정): 고쳤다.** 아래 절 참조. fixture의 Gate 명령도
  관찰된 원문(`"node -e \"process.exit(0)\""`)으로 되돌려, 이제 Gate를 실행하는 모든
  테스트가 이 이스케이프를 실제로 통과시킨다.

---

# CI-010 Minimal Fix — `yaml-lite` 큰따옴표 이스케이프

**Date:** 2026-08-26 (V0.1 유지보수 직후, Phase 2 시작 전)

위 부수 발견에 대한 최소 수정이다. 관찰 기록은 그대로 두고, 여기에 무엇을 바꿨는지만 적는다.

## 근본 원인 — 한 군데가 아니라 두 군데

한 사실(“큰따옴표 안의 `\"` 는 값의 일부다”)을 두 코드가 서로 다르게 알고 있었다.

1. **인용 구간 스캐너** (`stripComment`) — 큰따옴표 구간 안에서 `\"` 의 `"` 를 구간의 끝으로
   봤다. 그래서 `"node -e \"process.exit(0)\""` 의 인용이 `\"` 에서 일찍 닫혔다.
2. **큰따옴표 스칼라 디코딩** (`parseScalar`) — 바깥 따옴표만 떼고 본문을 그대로 돌려줬다.
   이스케이프를 해석하지 않으므로 백슬래시가 값에 남았다.

두 번째만 고치면 스캐너가 여전히 구간을 잘못 끊고, 첫 번째만 고치면 백슬래시가 그대로 남는다.
그래서 **둘의 이스케이프 집합을 하나의 상수(`DQ_ESCAPES`)로 묶었다.**

## 구현

`tools/loop-runtime/yaml-lite.mjs` 한 파일, 세 군데.

```js
// 1. 스캐너 — 큰따옴표 구간에서만 백슬래시가 다음 한 글자를 이스케이프한다.
if (quote === '"' && c === '\\' && i + 1 < s.length) { i += 1; continue; }

// 2. 인정하는 이스케이프 — 이것뿐이다. 스캐너와 디코더가 같은 집합을 본다.
const DQ_ESCAPES = { '"': '"', '\\': '\\' };

// 3. 디코더 — 큰따옴표 스칼라에만 적용한다. 작은따옴표는 손대지 않는다.
if (s.startsWith('"') && s.endsWith('"') && s.length > 1) {
  return decodeDoubleQuoted(s.slice(1, -1), lineNo);
}
```

`\\` 를 함께 지원하는 것은 기능 확장이 아니라 **정합성 요구**다. 스캐너가 어떤 `"` 가
이스케이프됐는지 알려면 `\\` 를 인식해야 하고(`"a\\"` 는 정상적으로 닫혀야 한다),
그렇다면 디코더도 같은 것을 해석해야 한다.

의도적으로 하지 않은 것:

- 작은따옴표 스칼라에는 이스케이프 해석을 적용하지 않았다. YAML의 작은따옴표에는 백슬래시
  이스케이프가 없다. 기존 동작 그대로다.
- 평문 스칼라의 아포스트로피 동작(`it's fine`)은 건드리지 않았다.
- `#` 가 인용 구간 안에서 주석이 되지 않는 성질도 그대로다.
- 전체 YAML 이스케이프 의미론을 넣지 않았다. anchor/alias · flow map · multi-document ·
  block scalar 동작 · 들여쓰기 의미는 전부 그대로다.

## 남아 있는 미지원 이스케이프 — 의도적이다

`\"` 와 `\\` 외의 이스케이프(`\n` · `\t` · `\u0041` 등)는 **에러**다.
백슬래시를 조용히 남기지 않는다.

이건 이 파서의 원칙(조용히 잘못 읽는 대신 명시적으로 실패한다)을 따른 것이고,
CI-010 자체가 정확히 "백슬래시가 그대로 남아 실행 불가능한 명령이 되는" 문제였기 때문이다.
`\n` 을 실제 줄바꿈으로 원하면 block scalar(`|`)를 쓴다 — 이미 지원한다.

## Before / After

| | before | after |
|---|---|---|
| YAML 원문 | `command: "node -e \"process.exit(0)\""` | 같음 |
| 파싱 결과 | `node -e \"process.exit(0)\"` | `node -e "process.exit(0)"` |
| 셸 실행 | `/bin/sh: 1: Syntax error: "(" unexpected` | exit 0 |
| Gate 판정 | ERROR/FAIL (fail-closed) | PASS |

**fail-closed는 유지된다.** 고친 것은 파싱이지 판정이 아니다. 실제로 깨진 명령은 여전히
PASS가 되지 않으며, 회귀 테스트가 그것을 검사한다.

## 회귀 증거

`tools/loop-runtime/test/yaml-lite.test.mjs` — 18건, 전부 통과.

- **Case A** — 관찰된 명령 원문이 `node -e "process.exit(0)"` 로 디코딩되고 백슬래시가
  남지 않는다. 디코딩된 명령을 실제 셸로 실행해 exit 0과 빈 stderr를 확인한다.
- **Case B** — `\"` 가 인용 구간을 일찍 닫지 않는다. 이스케이프 뒤에 `#` · `:` · `,` 가
  있어도 잘리지 않으며, 인용 밖의 진짜 주석은 여전히 제거된다. `\\` 도 구간 추적을 깨지 않는다.
- **Case C** — 평범한 큰/작은따옴표 · 인용 안의 `#` · 평문 아포스트로피 · 미종료 인용 실패 ·
  flow map · anchor/alias · multi-document · tab 들여쓰기 · 미종료 flow sequence ·
  block scalar와 스칼라 타입이 전부 그대로다. 파서 에러를 약화시키지 않았다.
- **Case D** (YAML → Gate 경계, 버그가 발견된 자리) — fixture의 `project.yaml` 이
  관찰된 원문을 그대로 담고, `loopctl gates` 가 디코딩된 명령을 보여주며(`\"` 를 노출하지
  않는다), Runtime이 그 명령을 실행해 PASS한다. 그리고 진짜로 깨진 명령은 여전히 실패한다.

fixture의 기본 Gate 명령을 `node --version` 에서 관찰된 원문으로 되돌렸으므로,
Gate를 실행하는 **모든** Runtime 테스트가 이 경로를 지난다. 회귀가 생기면 조용히 넘어가지 않는다.

## 검증 결과

| | V0.1 기준선 | CI-010 이후 |
|---|---|---|
| Runtime 회귀 | 121 pass / 0 fail | **139 pass / 0 fail** |
| 제품 테스트 | 131 passed / 9 files | 131 passed / 9 files |
| `npm run build` | exit 0 | exit 0 |
| `npm run lint` | exit 0 (warning 1) | exit 0 (warning 1) |
| `loopctl doctor` | exit 0 | exit 0 |

기준선을 회귀시키지 않았다. LLM 기반 Runtime 작업은 이 유지보수에 한 번도 쓰지 않았다.

---


# OBS-013 Sync — `yaml-lite` block scalar 본문 재해석

**Date:** 2026-08-27  ·  **출처:** canonical field-test 프로젝트에서 관찰·수정·검증됨

이 항목은 Starter Pack이 **관찰한 것이 아니라 동기화한 것**이다. 관찰과 수정의 전체 기록은
canonical 프로젝트의 Field Notes에 있으며, 여기에는 동기화 사실만 남긴다.

**증상.** Plan validation은 PASS이고 repository subject도 일치하는데 `plan-approve`가
fail-closed로 거부됐다.

```text
TASK-...: serialized task does not parse back - unterminated quote
```

**원인.** 승인 로직이 아니라 파서였다. `scanLines()`가 block scalar **본문**까지
`stripComment()`에 넘겨서, `'node:'` 처럼 콜론 뒤에 따옴표가 오는 평범한 기술 산문이
값을 여는 인용으로 오인되어 닫히지 않는 구간을 만들었다. 본문은 `readBlockScalar()`가
raw 줄에서 따로 읽으므로 `scanLines`가 만든 content는 **애초에 쓰이지도 않았다** —
해석할 이유가 없는 줄을 해석하다 실패한 것이다.

**동기화한 것.** canonical의 최소 수정을 그대로 가져왔다(byte-identical).

```text
tools/loop-runtime/yaml-lite.mjs            scanLines() 한 함수
tools/loop-runtime/test/yaml-lite.test.mjs  회귀 10건 추가
```

block scalar **바깥**의 인용 검사·주석 처리·미지원 문법 거부는 하나도 느슨해지지 않았고,
CI-010의 `\"` 이스케이프 동작도 그대로다. 회귀가 그 성질을 고정한다.

| | CI-010 이후 | OBS-013 동기화 이후 |
|---|---|---|
| Runtime 회귀 | 139 pass / 0 fail | **149 pass / 0 fail** |
| `loopctl doctor` | exit 0 | exit 0 |
| `loopctl validate` | exit 0 | exit 0 |

CI 번호는 부여하지 않았다 — canonical 쪽에서도 아직 부여되지 않았고, 이번 작업은
새 개선 후보를 만드는 것이 아니라 검증된 수정을 옮긴 것이다.

---


# Candidate Improvements

실제 사용 사례가 충분히 쌓인 항목만 이 표로 승격한다.

| ID | Improvement | Evidence | Priority | Status |
|---|---|---|---|---|
| CI-001 | 정지 사유에 subject diff(ADDED/REMOVED/CHANGED 경로) 포함 | OBS-003 | High | CANDIDATE |
| CI-002 | `loopctl resume <RUN>` — gate 재실행 → verify 복구 경로 | OBS-003, OBS-004 | Medium | CANDIDATE |
| CI-003 | Worker Context에 실제 capability(명령 실행/네트워크/evidence 쓰기) 선언 | OBS-002 (Phase 1 전체 8/8), OBS-005, OBS-007, OBS-008 | High | **IMPLEMENTED** (V0.1 §1·§2 — Result Protocol의 RUNTIME CAPABILITIES 절) |
| CI-004 | `loopctl usage`에 Task 간 비용/토큰 추세 표시 (근거 수정: 순번이 아니라 Task 크기 대비 비용) | OBS-005 (Phase 1 실측으로 순번 가설 반증) | Medium | CANDIDATE |
| CI-005 | `limits.yaml`에 Worker 비용/토큰 상한 (현재는 실패 횟수만) | OBS-005 | Low | CANDIDATE |
| CI-006 | Worker에게 `stop_condition.gates` 명령만 allow-list로 실행 허용 (또는 `loopctl gate --self-check`) | OBS-007 ($4.04 / 9분 폐기), OBS-008 (Worker가 Phase 비용의 88% 차지) | High | **IMPLEMENTED** (V0.1 §2 — `loopctl self-check`) |
| CI-007 | Worker deny list를 fingerprint `PROTECTED_EXCEPTIONS`와 일치시켜 `.loop/evidence/**` 쓰기 허용 | OBS-002 후속 (Phase 1 8 Task / 9 Run 전부 재현, evidence 전량 공백) | High | **IMPLEMENTED** (V0.1 §1 — `worker/policy.mjs`, Task 단위로 좁힘) |
| CI-008 | Run 시작 시 execution 레코드 선기록 + PID/heartbeat → `status`에 RUNNING/STALE 표시 | OBS-006 | Medium | **IMPLEMENTED** (V0.1 §4 — 기존 `executions/active/` 표식을 heartbeat 기반으로) |
| CI-009 | Verifier Context에도 Worker capability를 전달 — "실행/측정/수동확인했다"는 주장을 의심할 근거 | OBS-009 | Medium | **IMPLEMENTED** (V0.1 §3 — WITNESSED EXECUTION + `evidence_basis` 계약) |
| CI-010 | `yaml-lite`가 double-quoted scalar의 `\"` 이스케이프를 처리하지 않는다 | V0.1 부수 발견 (fail-closed, 근거 1건) | Low | **IMPLEMENTED** (CI-010 Minimal Fix 절 — 스캐너 + 디코더, 회귀 18건) |

권장 Status:

- `CANDIDATE`
- `VALIDATED`
- `PLANNED`
- `IMPLEMENTED`
- `REJECTED`

`IMPLEMENTED` 항목의 구현 내용과 회귀 테스트는 위 **V0.1 Maintenance Pass** 절에 있다.

---

# Ideas — Not Yet Validated

아직 실제 문제로 확인되지 않은 아이디어를 임시로 적는다.

이 섹션의 항목은 **Runtime 개발 요구사항으로 간주하지 않는다.**

예시:

- `loopctl init`으로 신규 프로젝트 bootstrap 자동화
- dependency-aware `execute-plan`
- shared working tree 대신 per-Task worktree isolation — OBS-003이 첫 실제 근거
- Planner Task granularity 개선
- Gate 자동 탐지 / 제안
- Runtime 코드를 프로젝트 밖 개인 도구로 추출

---

# Review Checkpoint

3D Asset Compatibility Lab의 주요 Goal 또는 Phase 하나가 끝날 때마다 이 문서를 검토한다.

검토할 질문:

1. 같은 불편이 두 번 이상 발생했는가?
2. 사람이 반복적으로 개입해야 했는가?
3. Runtime이 잘못 멈추거나 불필요하게 재시도했는가?
4. Planner가 Task를 너무 크게 또는 너무 작게 나눴는가?
5. Gate / Verifier가 실제 완료 조건을 제대로 판별했는가?
6. token / provider cost / 실행 시간이 과도했는가?
7. 새 프로젝트 bootstrap 과정에서 반복 작업이 있었는가?
8. shared working tree 때문에 STALE / ambiguity가 자주 발생했는가?
9. 실제 사용 결과 Runtime V1에 넣을 가치가 확인된 기능은 무엇인가?

이 리뷰를 기반으로 다음 Runtime 개선 순서를 정한다.
