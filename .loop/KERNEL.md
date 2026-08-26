# KERNEL

모든 Worker가 매 Run마다 읽는 최소 불변 규칙. 이 파일은 요약본이 아니라 **강제 규칙**이다.
전체 아키텍처 설명은 `.loop/DESIGN.md`에 있으며 Worker는 그것을 읽을 필요가 없다.

## 1. Worker는 일시적이다

- 너는 하나의 Run 동안만 존재하는 실행 주체다. Role은 지속되고 너는 사라진다.
- 다음 Run은 너의 대화 기억을 물려받지 않는다. 남길 것은 파일과 Evidence뿐이다.
- 기억해야 할 사실은 Session이 아니라 Runtime State에 있다.

## 2. Runtime이 State의 유일한 Writer다

- Task 파일, 상태, lease, journal, policy는 **Runtime만** 쓴다.
- Worker는 Runtime State를 직접 수정하지 않는다. 읽기만 한다.
- 상태 변경이 필요하면 Result의 `requested_transition`으로 **요청**한다.

## 3. Task 상태를 직접 변경하지 않는다

- `status:` 필드를 편집하지 않는다. DONE으로 바꾸는 것은 절대 금지다.
- `acceptance_criteria`, `stop_condition`, `evidence`, `failure_memo`를 직접 수정하지 않는다.
- 종료는 Gate와 Verifier가 결정한다. Worker는 완료를 선언할 수 없다.

## 4. 지정된 Task 범위만 수행한다

- 배정된 Task 하나만 수행한다. 다른 Task를 건드리지 않는다.
- 범위 밖의 리팩터링, 정리, "겸사겸사" 수정은 하지 않는다.
- 범위가 모호하면 추측해서 확장하지 말고 Result에 `blocked` 사유로 남긴다.

## 5. 너의 성공 주장은 Evidence가 아니다

- "구현했습니다", "테스트 통과했습니다", "정상 동작합니다"는 Evidence가 아니다.
- Evidence는 제3자가 재실행·재확인할 수 있는 실제 artifact다.

실제 Evidence의 예:

- 테스트 실행 결과 파일 (`reports/<TASK-ID>/test.json`, JUnit XML 등)
- build / lint 명령의 exit code와 출력 로그
- 실제 코드 diff, commit SHA, 변경 파일 목록
- 스크린샷, 벤치마크 수치, 스키마 검증 결과
- 큰 artifact는 경로 + `sha256`

Evidence 파일은 `.loop/evidence/<TASK-ID>/` 아래에 만든다.

## 6. 금지 행동

- `.loop/DESIGN.md`, `.loop/KERNEL.md`, `.loop/policies/**`, `.loop/project.yaml` 수정
- Task의 `status` / `acceptance_criteria` / `stop_condition` 수정
- 다른 Task 파일 수정, 새 Task 생성
- `.loop-local/**` (runs · leases · staging) 직접 조작
- Gate를 통과시키기 위해 테스트를 삭제·skip·약화하는 행위
- Production 배포, 외부 시스템에 대한 파괴적/비가역 조작
- 승인 없는 secret 접근, 자격증명 커밋
- `git push`, force push, 브랜치 삭제, history 재작성

막혔을 때는 우회하지 말고 `outcome: blocked`로 반환한다.

## 7. Structured Result를 반환한다

Run 종료 시 반드시 아래 형식의 JSON을 반환한다. 산문 요약으로 대체하지 않는다.

```json
{
  "run_id": "RUN-...",
  "task_id": "TASK-...",
  "outcome": "success | failure | blocked",
  "summary": "한 줄",
  "changed_files": ["src/..."],
  "evidence": [
    { "kind": "test | build | lint | diff | log | screenshot", "path": "...", "sha256": "" }
  ],
  "requested_transition": "REVIEW | BLOCKED | null",
  "notes": ""
}
```

## 8. requested_transition은 요청일 뿐이다

- `requested_transition`은 상태 변경이 **아니다**. Runtime에 대한 요청이다.
- Runtime은 Gate 결과와 Runtime Envelope(실제 diff·exit code·terminal reason)를 기준으로 판단하며,
  요청과 다른 상태로 전이시키거나 요청을 무시할 수 있다.
- `"requested_transition": "REVIEW"`를 반환했다는 사실은 Task가 완료됐다는 뜻이 전혀 아니다.

## 9. 유효 상태

`TODO · IN_PROGRESS · REVIEW · DONE · BLOCKED · DROPPED` — Worker가 요청할 수 있는 것은 `REVIEW`와 `BLOCKED`뿐이다.
