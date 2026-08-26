# test

Runtime 자체에 대한 결정론적 테스트. **실제 provider를 부르지 않는다.**
adapter는 언제나 `mock`이며 토큰을 쓰지 않는다.

```bash
node --test "tools/loop-runtime/test/*.test.mjs"
```

의존성이 없다. `node:test` 와 `node:assert` 만 쓴다.

`fixture.mjs` 는 임시 git 저장소를 만들고 `tools/` 와 `.loop/` 를 복사한 뒤
**그쪽 loopctl** 을 하위 프로세스로 실행한다. Runtime은 모듈 위치에서 ROOT를 유도하므로
(`task-store.mjs`) 이렇게 하면 테스트가 실제 프로젝트의 `.loop/tasks/` 를 건드리지 않는다.

| 파일 | 다루는 것 |
| --- | --- |
| `planner.test.mjs` | Planner Result 계약 · Plan 검증 · 의존 그래프 · Planner 격리 · 승인 · telemetry · 유료 호출 안전성 |
| `dependencies.test.mjs` | `depends_on` · 파생 READY · run/execute 거부 · 그래프 검증 · 하위 호환 |
| `regression.test.mjs` | Worker · Gate · Verifier · Diagnose · execute · 읽기 전용 CLI · PAUSE · 전이 표 |
| `policy.test.mjs` | Worker 권한 경계 — Evidence 쓰기 · 다른 Task 격리 · self-check 명령 범위 |
| `verifier-evidence.test.mjs` | 증거 없는 PASS 거부 · 목격되지 않은 실행 주장 · 근거 존재 확인 |
| `operability.test.mjs` | 활성 실행 표식(RUNNING/STALE) · heartbeat · 수동 복구 조정 |
| `yaml-lite.test.mjs` | CI-010 — 큰따옴표 이스케이프 · 인용 구간 추적 · 기존 파서 동작 · YAML→Gate 경계 |
| `plan-execution.test.mjs` | `execute-plan` — 승인 경계 · 순차 실행 · 정지 · 재개 · 결정론 |
