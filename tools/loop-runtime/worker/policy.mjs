// worker/policy — Worker에게 무엇을 허용하고 무엇을 막는지 한 곳에서 정한다.
//
// 방어는 두 겹이다. 둘을 같은 사실에서 유도해야 어긋나지 않는다.
//
//   1. 예방 — adapter permission 규칙(deny/allow). 실행 전에 막는다. 열거 기반이라
//      Run 중에 새로 생긴 경로는 덮지 못한다. best-effort다.
//   2. 탐지 — protected fingerprint. Run 전후를 비교한다. 추가·수정·삭제를 모두 잡는다.
//      이쪽이 정본이며 policy violation 판정은 여기서만 나온다.
//
// 두 겹의 경계는 같다: **이 Task의 Evidence 디렉터리만** 쓸 수 있고, `.loop/` 의 나머지는
// 전부 Runtime 소유다. 다른 Task의 Evidence도 남의 것이다.
//
// (이전 구현은 fingerprint가 `.loop/evidence` 전체를 예외로 두면서 deny는 `.loop/**` 를
//  통째로 막아, KERNEL이 지시한 Evidence 쓰기가 항상 거부됐다. 두 정책의 출처를 하나로 합친다.)

import { readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT, LOOP_DIR } from '../task-store.mjs';

/** Runtime이 소유하는 control plane. */
export const PROTECTED_ROOT = LOOP_DIR;
export const EVIDENCE_ROOT = join(LOOP_DIR, 'evidence');

const rel = (p) => relative(ROOT, p).split('\\').join('/');

/** 이 Task의 Worker가 Evidence artifact를 쓰는 자리. Runtime이 Run 시작 전에 만들어 준다. */
export const evidenceDirFor = (taskId) => join(EVIDENCE_ROOT, taskId);

/**
 * protected fingerprint에서 제외할 경로 — 곧 Worker가 써도 되는 유일한 자리다.
 * Task별로 좁힌다. 다른 Task의 Evidence는 예외가 아니므로 손대면 탐지된다.
 */
export function protectedExceptionsFor(taskId) {
  return [evidenceDirFor(taskId)];
}

const listDir = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []);

/**
 * adapter에 넘길 거부 경로. `.loop/` 아래에서 **이 Task의 Evidence 디렉터리만 빼고** 전부.
 *
 * deny 규칙에는 부정(negation)이 없으므로 열거로 만든다. 열거가 놓치는 경우
 * (Run 도중 새로 생긴 최상위 항목 등)는 fingerprint가 잡는다 — 그래서 여기서 완전성을
 * 주장하지 않는다.
 *
 * @returns {string[]} 루트 기준 상대 경로 패턴 (디렉터리는 `/**`)
 */
export function protectedPathPatterns(taskId) {
  const own = evidenceDirFor(taskId);
  const patterns = [];

  for (const entry of listDir(LOOP_DIR)) {
    const full = join(LOOP_DIR, entry.name);
    if (full === EVIDENCE_ROOT) continue;          // 아래에서 Task 단위로 따로 다룬다
    patterns.push(entry.isDirectory() ? `${rel(full)}/**` : rel(full));
  }

  // Evidence 루트: 다른 Task의 디렉터리와, Task에 속하지 않은 파일을 막는다.
  for (const entry of listDir(EVIDENCE_ROOT)) {
    const full = join(EVIDENCE_ROOT, entry.name);
    if (full === own) continue;
    patterns.push(entry.isDirectory() ? `${rel(full)}/**` : rel(full));
  }

  return patterns.sort();
}

/** 파일 쓰기 도구에 거는 거부 규칙. */
export function workerDenyRules(taskId) {
  const rules = [];
  for (const p of protectedPathPatterns(taskId)) {
    rules.push(`Edit(${p})`, `Write(${p})`);
  }
  return rules;
}

/** Worker가 Evidence를 쓸 수 있는 자리(루트 기준 상대 경로). Context에 사실로 선언한다. */
export const evidencePathFor = (taskId) => rel(evidenceDirFor(taskId));

// ------------------------------------------------------------------
// Self-check — Worker가 실행할 수 있는 유일한 명령.
//
// Bash 전체를 여는 대신 Runtime 소유 진입점 하나만 연다. 그 진입점은 project.yaml에
// 설정된 Gate 명령만 돌린다(loopctl self-check). Worker Result·Task 서술에서 온
// 문자열은 여기서도 실행되지 않는다.
//
// 이것은 정본 Gate 실행을 대체하지 않는다. Runtime은 Worker가 끝난 뒤 Gate를
// 독립적으로 다시 돌리며, 완료 판정은 그쪽만이 근거다.
// ------------------------------------------------------------------

/** loopctl 진입점의 루트 기준 경로. 테스트 fixture에서도 같은 상대 경로다. */
export const LOOPCTL_PATH = 'tools/loop-runtime/loopctl.mjs';

/** Worker Context와 permission 규칙이 함께 참조하는 정확한 명령 문자열. */
export const selfCheckCommand = () => `node ${LOOPCTL_PATH} self-check`;

/**
 * Worker에게 허용하는 규칙. **정확히 하나**다.
 * 여기에 `Bash(npm ...)` 같은 프로젝트 명령을 직접 넣지 않는다 — 그러면 Gate 설정을
 * 우회하는 두 번째 출처가 생긴다.
 */
export function workerAllowRules() {
  return [`Bash(${selfCheckCommand()}:*)`];
}

export { rel as relFromRoot };
