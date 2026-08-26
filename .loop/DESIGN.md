# AI Worker로 프로젝트를 운영하는 범용 Loop Engineering

## General-Purpose Loop Runtime for AI-Operated Projects

**문서 상태**: 범용 아키텍처 설계 초안
**목적**: 특정 프로젝트에 종속되지 않고, AI Worker가 계획·실행·검증·개선을 반복하는 **루프**를 설계·강제·관측하는 범용 Project Operating Runtime 정의

> **Role은 지속되고 Session은 버릴 수 있어야 한다.**
> **상태는 Session이 기억하지 않는다. Runtime이 기억한다.**
> **Worker는 시도하고, Runtime은 정책을 강제하며, Verifier가 종료를 결정한다.**
> **루프의 품질은 정지 조건의 품질을 넘지 못한다.**

---

# 0. 개요

에이전트는 이미 루프를 돌고 있다. 설계하지 않으면 Session이 즉흥적으로 루프를 발명한다.

```text
Goal
 ↓
Attempt        ← Worker
 ↓
Feedback       ← Gate / Evidence
 ↓
Diagnose       ← 실패 분류 · 복구 선택
 ↓
Verify         ← 독립 Verifier
 ↓
Stop or Loop   ← 정지 조건
 ↓
Operate → Observe → Improve → 다시 Goal
```

구조는 `Persistent Runtime + Durable State + Ephemeral Workers`. 목표는 **규칙을 잘 기억하는 AI**가 아니라 **규칙을 기억하지 않아도 틀린 행동을 하기 어려운 Runtime**이다.

---

# 1. 왜 루프를 설계해야 하는가

Session 하나로 시작하고, 커지면 역할별로 나눈다. 처음엔 잘 된다. 그다음 무너진다.

- **Session이 상태와 기억을 동시에 가진다.** 선행조건·검증자·위험도·비용 한도까지 기억해야 한다. Session이 작은 운영체제가 된다.
- **자연어 정책이 매 Session 반복된다.** `Context 증가 → 규칙 충돌 → 해석 차이 → 운영 사고`
- **Message가 State처럼 쓰인다.** Session 종료 시 사라지고 실제 상태와 어긋난다.
- **여러 Session이 같은 Working Tree를 공유한다.** staging pollution · ownership 불명.

> **Message는 Notification일 수는 있어도 State가 되어서는 안 된다.**

그리고 가장 비싼 실패 모드 — **루프가 없으면 실패가 축적된다.**

```text
실패 → 같은 시도 반복 → 실패 궤적이 Context에 누적
→ 판단 품질 저하 → 더 나쁜 시도 → 예산 소진
```

정지 조건도 진단도 없어서 생긴다. 상한만 걸어두면 "실패했다"는 사실만 알고 **어디서 왜**는 모른다.

---

# 2. 설계 목표


| 목표                | 전 → 후                                   |
| ----------------- | --------------------------------------- |
| 상태를 Session 밖에    | Session Memory → Runtime State          |
| 정책을 실행 가능하게       | 자연어 → Schema / Guard / Hook             |
| Role과 Session 분리  | 지속되는 책임 / 일시적 실행 자원                     |
| Worker에게 전체를 숨김   | 전역 topology → Task + Spec + Runtime API |
| 주장을 Evidence로 안 봄 | "성공했습니다" → 실제 report·diff·hash          |
| 종료를 Worker가 못 정함  | 자기 완료 선언 → Verifier 판정                  |
| 루프 자체를 감시         | Runtime 신뢰 → Independent Monitor        |


Role은 유지되고 Worker는 사라진다. `impl → worker-001 종료 → 다음 Task → worker-002`

---

# 3. 루프 해부

## Goal과 Stop Condition은 다른 것이다

```text
Goal: refresh token rotation 구현
Stop: unit/integration gate PASS AND verifier PASS
      OR 연속 실패 2회 OR 정체 감지 OR budget 초과
```

> **체크로 쓸 수 없는 완료 조건은, 루프가 끝났는지 알 방법이 없다.**

Acceptance Criteria는 문장이 아니라 **판정 가능한 술어**로 쓴다.

## 단계별 소유자

```text
Goal      root / 사람     Diagnose  Runtime(분류) + Worker(수정)
Attempt   Worker          Verify    Verifier (독립)
Feedback  Gate            Stop      Runtime (정책)
```

Worker는 어느 단계도 단독으로 종료시키지 못한다.

## Retry ≠ Loop

```text
Retry = 같은 시도를 반복
Loop  = 실패를 진단하고 접근을 바꿈
```

진단 없는 재시도는 자동화가 아니라 비용이다.

---

# 4. Layer 1 — Task 상태 모델

계층은 넷이다: `Task/Run Model → Loop Runtime → Governance → Roles/Adapter`

```text
TODO / IN_PROGRESS(+valid lease) / BLOCKED(승인·법무·사용자 결정 대기)
REVIEW(산출물 존재, 검증 대상) / DONE(독립 검증 통과) / DROPPED(의도적 미수행)
```

상태 종류를 늘리지 않고 파생은 Runtime이 계산한다.

```text
READY         TODO AND 선행조건·시간조건 충족 AND 사용자 결정 없음
              AND risk 허용 AND lease 없음
VERIFY_READY  REVIEW AND 검증 선행조건 충족 AND recheck 도달
ORPHANED      IN_PROGRESS AND lease invalid
STALLED       IN_PROGRESS AND 진행 없음 AND threshold 초과
```

Task Schema는 부록 B. 핵심은 모든 Task가 `stop_condition`과 `failure_memo`를 갖는다는 점이다.

---

# 5. 진행 없음 감지

반복 횟수 카운터는 너무 거칠다. 루프는 **정체**를 봐야 한다.

```text
동일 tool + 동일 argument 반복 · 에러 메시지 문자열 불변
diff 크기 0 · evidence 갱신 없음 · token만 증가
```

하나라도 threshold 초과 → `STALLED` → 루프 중단 → **Diagnose 승격 (재시도 아님)**

> **상한은 안전망이고, 정체 감지가 실제 트리거다.**

---

# 6. Layer 2 — Loop Runtime

Runtime은 루프를 실제로 돌리는 deterministic software다.

```text
Dispatcher · State Machine · Policy Engine · Queue / Lease · Event Journal
Context Builder · Worker Launcher · Stop Evaluator · Recovery Engine
```

AI가 긴 query를 기억하지 않도록 모든 반복 판독을 command로 만든다.

```bash
loopctl ready | verify-ready | doctor | digest
loopctl queue stalled | orphaned | needs-human
loopctl claim | transition | dispatch --daemon | pause
```

---

# 7. Attempt — Result와 Envelope 분리

Worker는 상태를 직접 바꾸지 않고 structured result를 반환한다.

```json
{ "run_id": "RUN-001", "task_id": "TASK-X", "outcome": "success",
  "evidence": [{ "kind": "test", "path": "reports/TASK-X/unit.json" }],
  "requested_transition": "REVIEW" }
```

`requested_transition`은 **요청**일 뿐 mutation이 아니다.

Worker의 주관과 Runtime의 관찰을 분리한다.

```text
Runtime Envelope   ← session · model · token · cost · terminal reason
 └── Worker Result   permission denial · actual commit · changed files
```

**Stop 판정은 Envelope 기준으로 한다.** Worker Result는 참고자료다.

---

# 8. Single Writer와 Lease

`Worker · Verifier · Research · Audit → 직접 State Write 금지`. Durable mutation은 Runtime을 통해서만 발생한다.

Lease는 Task 문서가 아니라 별도 파일에 둔다. Worker에게 heartbeat를 기억시키지 않는다.

```text
child process handle → process identity → lease TTL
```

TTL은 주 health detector가 아니라 crash recovery용 fallback이다.

**Unknown ≠ Absent**: `lease가 없음`과 `lease를 확인하지 못함`은 다르다. `observed: false`이면 mutation은 **fail-closed**.

---

# 9. Feedback — Evidence

Evidence는 Worker 주장보다 강해야 한다: `test · gate · screenshot · benchmark · log · database check · deployment proof`. 작은 artifact는 git에, 대용량은 external store에 두고 `sha256`을 기록한다.

---

# 10. Verify — 2층 정지 조건

```text
Gate     = deterministic          test · build · lint · schema · threshold
Verifier = independent reasoning  AC 해석 · 누락 탐지 · 설계 적합성
```

**Verifier는 최종 게이트가 아니다.** 확률적 1차 비평이고, 하드 홀트는 결정론적 Gate가 담당한다.

```text
Gate FAIL     → 즉시 루프 복귀 (LLM 판단 불필요)
Gate PASS     → Verifier 호출
Verifier FAIL → Diagnose
Verifier PASS → DONE
```

## Independent Verification

Verifier에게 구현자의 narrative를 주지 않는다. **Session 분리가 아니라 Input 분리**다.

```text
포함:  Contract · Acceptance Criteria · Canonical Diff · Evidence
       Gate Result · Runtime Facts
제외:  Worker summary · Worker self-evaluation · Progress narrative
```

같은 모델이 만든 것을 같은 맥락에서 채점하면 후하게 준다. 입력을 끊어야 판정이 독립적이 된다.

## Verified-before-Main

```text
Worker → Pre-Gate → Immutable Staging Ref → Canonical Gate → Verifier → PASS → Main
```

검증 전 remote backup은 가능하되, main에는 검증된 tree만 올라간다.

> **Verifier가 검증한 Tree SHA와 main에 올릴 Tree SHA가 같아야 한다.**

---

# 11. Diagnose — 실패 분류

에러를 하나로 뭉치면 복구를 선택할 수 없다.

```text
MODEL_ERROR · PROCESS_CRASH · TIMEOUT          → 자동 재시도 가능
SCHEMA_FAILURE · GATE_FAILURE · VERIFY_FAILED  → 진단 후 수정
PERMISSION_DENIED · RISK_DENIED
BUDGET_EXCEEDED · RECOVERY_AMBIGUOUS           → 자동 재시도 금지
```

분류별로 **타겟 복구 힌트**를 다음 Attempt의 Context에 주입한다. 일반 재시도 프롬프트는 같은 실패를 부른다.

---

# 12. 에스컬레이션 사다리

한 번에 사람으로 올리지 않고, 개입 강도를 한 단계씩 높인다.

```text
1  Retry             transient 실패만
2  Retry + Hint      분류된 에러 + 복구 힌트 주입
3  Replan            접근 자체를 다시 세움 (같은 Task, 다른 경로)
4  Decompose         Task를 쪼개서 실패 지점을 좁힘
5  needs-human       판단을 사람에게
6  DROPPED + Report  부분 결과와 실패 사유를 남기고 종료
```

> **같은 예산이면 무한 재시도나 전면 재계획보다 타겟 복구가 낫다.**

---

# 13. Failure Memo

재시작은 백지 재시작이 아니다. 백지로 리셋하면 같은 벽에 다시 부딪힌다.

```yaml
failure_memo:
  - attempt: 2
    stage: verifier
    error: VERIFY_FAILED
    lesson: "AC 3번(만료 처리) 미구현. 테스트는 통과하지만 케이스가 없음."
```

```text
실패한 궤적 전체를 이월하지 않는다   ← Context Rot
증류된 lesson만 이월한다
```

Memo는 다음 Attempt의 Context에 들어가고, 반복되는 패턴은 Role Skill로 승격한다.

---

# 14. Context 관리

루프가 길어지면 Context가 채워지면서 판단 품질이 떨어진다. 비용 문제 이전에 **품질 문제**다.

**KERNEL** — 모든 Worker가 매 Run 읽는 최소 공통 규칙. 포함: Worker의 위치 · State Writer 아님 · Structured Result · 절대 금지 · Evidence 정의 · Runtime read API. 제외: Incident history · 긴 shell query · 프로젝트별 상세 규칙 · Session topology.

KERNEL 증가는 문서 증가가 아니라 **모든 Run의 고정비 증가**로 본다.

**Snapshot** — `KERNEL · ROLE_SKILL · TASK · SPEC · FAILURE_MEMO`를 run 디렉토리에 복사하고 sha256을 manifest에 기록한다. Worker가 무엇을 보고 일했는지 재현된다.

**Isolation** — 셋은 다른 개념이다. Context Isolation(prompt에 필요한 것만, 기본) · Read Isolation(다른 파일 읽기 제한, 선택) · **Write Isolation**(State·타 Worktree·Prod 차단, 필수). Write는 Tool restriction · PreToolUse Hook · OS permission · container로 구조적으로 막는다.

**압축 임계** — 꽉 차기 전에 압축한다. 가역 압축(환경에서 다시 읽을 수 있는 것은 경로만) → 비가역 요약(최근 tool call은 원문 유지) → 체크포인트(단계 종료 시 인수인계 문서 생성 후 새 Run). 체크포인트가 현재 실행 지점을 보존하지 못하면 `압축 → 앞 단계 재실행 → 다시 압축` 루프에 빠진다.

---

# 15. Layer 3 — Governance

**Risk** — 작성자의 Boolean에만 의존하지 않는다. 누락하면 위험이 없는 것처럼 보인다. Runtime이 계산한다.

```text
touches_prod · destructive · external_side_effect · changes_policy
sensitive_data · paid_api · security_critical · irreversible
```

3단 방어: `Pre-dispatch Risk → Role Capability → Runtime Hook`

**Budget** — AI Worker Budget과 Application Budget(LLM·외부 API·GPU)은 별도 ledger. 병렬 실행에서 hard cap을 지키려면 `AVAILABLE = CAP - SPENT - RESERVED`.

**Fail-closed** — Write · Production · Budget · Risk는 기본 fail-closed. Read-only query만 degraded mode 허용.

---

# 16. Human Escalation과 Recovery

사람을 제거하는 게 목표가 아니다. Product decision · Architecture tradeoff · Risk override · Policy change · Legal · Security · Production approval은 사람이 판단한다.

**needs-human Queue**로 모든 escalation(`needs_user_decision · risk denied · budget issue · repeated failure · stall · recovery ambiguity`)을 하나로 모은다. root는 이 Queue만 본다.

**PAUSE** — `loopctl pause` 또는 `.loop-local/PAUSE` 파일 하나로 새 자동 실행을 멈춘다. 기존 Worker는 기본 continue.

**Recovery** — mutation은 side effect가 여럿이므로 Operation Journal(`PREPARED → STATE_WRITTEN → COMMITTED → EVENT_APPENDED → DONE`)을 쓴다. restart 시 unfinished operation / lease / run을 스캔해 `complete · rollback · orphan · needs-human`으로 정리한다. 반복 실패 event는 조용히 skip하지 않고 dead letter로 보낸다.

---

# 17. Monitor — 루프를 감시하는 루프

Runtime이 스스로를 검증하면 같은 문제가 반복된다. 가장 위험한 실패는 **모든 자동 검사가 정상인데 시스템 전체가 잘못 판단하는 것**이다.

Independent Monitor는 LLM이 아니다. 작고 deterministic하다.

```text
읽는 것:  Task 파일 · Event Journal · Lease · Cursor · Policy · Run metadata
안 쓰는 것: Runtime 내부 queue · Runtime parser 재사용 · LLM 판단
찾는 것:  count mismatch · stale IN_PROGRESS · cursor stop
          lease inconsistency · KERNEL growth · runtime drift
```

**Meta Loop** — 반복 gate failure · stall 급증 · permission denial spike가 trigger다.

```text
Monitor → loop_meta → Improvement Proposal → root → Task → impl → verifier
```

**감사자와 수정자를 분리한다.** loop_meta는 Runtime을 직접 고치지 않고, `risk: changes_policy`면 root approval을 받는다.

---

# 18. Observability

```text
Telemetry  tokens · tool_calls · cost · duration · gate/verifier failure
           permission denial · retry · stall · queue wait

KPI        Cost / Verified      검증된 산출물 단가
           Verifier Fail Rate   Gate가 못 잡는 영역의 크기
           Attempts / DONE      루프 효율
           Escalation Depth     평균 몇 단계까지 올라갔는가
```

Digest(`RUNS · DONE · GATE FAIL · VERIFY FAIL · STALLED · COST` + needs-human 목록)는 SSOT가 아니라 Navigation Layer다.

---

# 19. Layer 4 — Roles와 Project Adapter

```text
root      사람 대면 오케스트레이터, needs-human Queue 담당
impl      Task 수행           research   조사 (worktree 없음)
verifier  독립 검증, 동시 1   loop_meta  루프 자체 감시·개선 제안
```

Role Skill은 `skills/<role>.md`에 두고 Snapshot에 포함한다. Launch Manifest(model · budget · tools · hooks · context)로 실행 환경을 재현하고 manifest도 hash한다.

Core Runtime이 프로젝트를 직접 알면 안 된다. Domain·Gate·Risk는 plugin으로 주입한다. Anti-pattern: 프로젝트 이름으로 분기 · Role 이름 hard-code · 모든 Task가 code change라는 가정.

---

# 20. 운영 원칙

1. State는 Runtime이 소유하고, Message는 Notification이다.
2. Worker는 State Writer가 아니다.
3. Policy는 Runtime이 강제하고, Risk는 실행 직전 다시 확인한다.
4. Evidence는 실제 artifact다.
5. Verification은 Session이 아니라 Input이 분리되어야 한다.
6. **종료는 Verifier가 결정하고, Worker는 선언하지 못한다.**
7. **상한은 안전망이고, 정체 감지가 트리거다.**
8. **재시작은 백지가 아니라 Failure Memo를 들고 한다.**
9. Monitor는 Runtime을 믿지 않는다.
10. 반복 실패는 사람에게 올린다.

---

# 21. 최소 구현과 성공 지표

```text
P0    Task Schema · Validator · Ready Queue · Transition Engine · Single Writer
      Lease · Worker Result · Runtime Envelope · Gate · Verifier
      Stop Evaluator · Failure Memo · PAUSE
이후  Event Consumers · Monitor · loop_meta · Budget · Context 압축
```

성공은 Worker가 많아지는 게 아니라, **반복되는 운영 판단 · Policy negotiation · Context 재설명 · 검증 누락 · Retry loop · Stall이 줄고** Verified output · Recovery speed · Auditability가 느는 것이다.

---

# 22. 한 문장 요약

```text
사람은 목표와 정지 조건을 말하고,
Runtime은 상태를 기억하고 규칙을 강제하고,
Worker는 시도하고,
Gate는 사실을 만들고,
Verifier는 결과를 의심하고,
Monitor는 Runtime을 의심한다.
```

> **AI의 자율성을 루프 안에 가두고, 상태·정책·Evidence·검증·Monitor로 통제 가능한 자동화로 만드는 것.**

---

# 부록 A. 디렉토리 구조

```text
.loop/         KERNEL.md · project.yaml · tasks/ · skills/ · adapters/ · evidence/
  policies/    roles · transitions · risk · gates · budgets · limits · escalation
.loop-local/   runs/ · leases/ · cursors/ · operations/ · staging/ · PAUSE
source/
```

---

# 부록 B. Task 예시

```yaml
id: TASK-20260822-auth-refresh
domain: backend
status: TODO
request: "refresh token rotation을 구현한다."

stop_condition:
  gates: [unit, integration, lint]
  requires_verifier: true
  max_consecutive_failures: 2
  max_cost_usd: 3
  stall_threshold: { identical_tool_calls: 3, no_diff_attempts: 2 }

execution: { role: backend_impl, scope: medium, needs_worktree: true }
evidence: []
failure_memo: []
```

```markdown
## Acceptance Criteria
- [ ] 기존 token 재사용 시 401           (판정: 통합테스트 reuse_rejected)
- [ ] 정상 refresh 시 새 token 쌍 발급   (판정: 통합테스트 rotation_ok)
- [ ] 만료 token은 갱신 불가            (판정: 통합테스트 expired_denied)
```

각 AC 뒤에 **판정 방법**을 붙인다. 판정 방법이 없는 AC는 정지 조건이 될 수 없다.

---

# 부록 C. 정지·에스컬레이션 정책

```yaml
# limits.yaml
stall:
  identical_tool_calls: 3
  unchanged_error_string: 2
  zero_diff_attempts: 2
escalation:
  retry_max: 1
  hint_retry_max: 1
  replan_max: 1
  then: needs-human
```

---

# 부록 D. 최종 핵심 문장

> **Persistent Runtime + Durable State + Ephemeral Workers**

> **Worker의 주장은 Evidence가 아니다.**

> **Independent Verification은 Session 분리가 아니라 Input 분리다.**

> **Goal은 무엇이 완성인가, Stop은 언제 그만두는가. 둘 다 있어야 한다.**

> **진단 없는 재시도는 자동화가 아니라 비용이다.**

