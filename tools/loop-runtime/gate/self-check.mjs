// gate/self-check — Worker가 스스로 돌려볼 수 있는 결정론적 검사.
//
// 존재 이유: Worker가 build/lint/test를 한 번도 돌려보지 못하면, 타입 오류 하나 때문에
// Attempt 전체가 Gate에서 버려진다. 그 재시도는 전부 유료 LLM 호출이다.
//
// 그렇다고 Bash 전체를 열지는 않는다. 여기서 실행 가능한 것은 **project.yaml에 이미
// 설정된 Gate 명령**뿐이다. 이름은 설정된 Gate 집합에 대해 검증하며, Worker Result·
// Task 서술·CLI 인자에서 온 임의 문자열은 명령이 되지 못한다.
//
// 이것은 정본 Gate 실행이 아니다:
//   - Gate Report를 만들지 않는다
//   - Run 디렉터리에 쓰지 않는다
//   - Task 상태를 바꾸지 않는다
//   - Acceptance Criteria를 판정하지 않는다
// Runtime은 Worker가 끝난 뒤 Gate를 독립적으로 다시 돌리고, 완료 판정은 그쪽만이 근거다.

import { rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_DIR } from '../task-store.mjs';
import { loadGateConfig, gateTimeoutSeconds } from './resolver.mjs';
import { gateDir } from './report.mjs';
import { executeGate } from './runner.mjs';

/** self-check artifact 자리. `.loop-local/` 아래라 verification subject에 들어가지 않는다. */
export const SELF_CHECK_DIR = join(LOCAL_DIR, 'self-check');

/**
 * 요청한 이름을 설정된 Gate로 해석한다. 해석되지 않으면 **아무것도 실행하지 않는다.**
 * @returns {{ ok: true, defs: object[] } | { ok: false, errors: string[] }}
 */
export function resolveSelfCheckGates(config, requested) {
  const gateConfig = loadGateConfig(config);
  if (gateConfig.errors.length > 0) return { ok: false, errors: gateConfig.errors };

  const known = gateConfig.names;
  if (known.length === 0) {
    return { ok: false, errors: ['no gates are configured in project.yaml — there is nothing to self-check'] };
  }

  // 인자가 없으면 "설정되고 활성화된 Gate 전부"다. 이것도 설정에서만 온다.
  const names = requested.length > 0 ? requested : known.filter((n) => gateConfig.gates[n].enabled);
  if (names.length === 0) {
    return { ok: false, errors: ['every configured gate is disabled — there is nothing to self-check'] };
  }

  const errors = [];
  const defs = [];
  const seen = new Set();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const def = gateConfig.gates[name];
    if (!def) {
      errors.push(`unknown gate "${name}" (configured: ${known.join(', ')})`);
      continue;
    }
    if (!def.enabled) {
      errors.push(`gate "${name}" is disabled in project.yaml${def.reason ? ` (${def.reason})` : ''}`);
      continue;
    }
    defs.push(def);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, defs };
}

const tail = (path, lines) => {
  if (!existsSync(path)) return '';
  const body = readFileSync(path, 'utf8').split('\n');
  const start = Math.max(0, body.length - lines - 1);
  return body.slice(start).join('\n').trim();
};

/**
 * 해석된 Gate들을 순서대로 실행한다. LLM을 호출하지 않는다.
 * @returns {{ results: object[], passed: boolean }}
 */
export async function runSelfCheck({ config, defs, emit = () => {} }) {
  // 매번 새로 시작한다. 지난 실행 산출물이 결과처럼 보이지 않도록.
  rmSync(SELF_CHECK_DIR, { recursive: true, force: true });
  mkdirSync(SELF_CHECK_DIR, { recursive: true });

  const results = [];
  for (const def of defs) {
    emit({ event: 'start', name: def.name, command: def.command });
    const record = await executeGate({
      def,
      runDir: SELF_CHECK_DIR,
      timeoutSeconds: gateTimeoutSeconds(config, def),
    });
    const dir = gateDir(SELF_CHECK_DIR, def.name);
    results.push({
      ...record,
      stdout_tail: tail(join(dir, 'stdout.log'), 40),
      stderr_tail: tail(join(dir, 'stderr.log'), 40),
    });
    emit({ event: 'finish', record: results[results.length - 1] });
  }
  return { results, passed: results.every((r) => r.status === 'PASS') };
}
