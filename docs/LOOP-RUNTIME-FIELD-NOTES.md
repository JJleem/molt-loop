# Loop Runtime — Field Notes

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

`OBSERVED`

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

`OBSERVED`

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

`OBSERVED`

---

# Candidate Improvements

실제 사용 사례가 충분히 쌓인 항목만 이 표로 승격한다.

| ID | Improvement | Evidence | Priority | Status |
|---|---|---|---|---|
| CI-001 | 정지 사유에 subject diff(ADDED/REMOVED/CHANGED 경로) 포함 | OBS-003 | High | CANDIDATE |
| CI-002 | `loopctl resume <RUN>` — gate 재실행 → verify 복구 경로 | OBS-003, OBS-004 | Medium | CANDIDATE |
| CI-003 | Worker Context에 실제 capability(명령 실행/네트워크/evidence 쓰기) 선언 | OBS-002 (TASK-001·002·003 3연속) | High | CANDIDATE |

권장 Status:

- `CANDIDATE`
- `VALIDATED`
- `PLANNED`
- `IMPLEMENTED`
- `REJECTED`

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
