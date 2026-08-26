// planner/task-yaml — 승인된 제안을 Task YAML로 직렬화한다.
//
// 이 Runtime의 YAML 리더는 yaml-lite 하나뿐이다. 그래서 "썼다"로 끝내지 않고,
// 쓴 문자열을 **다시 파싱해서 의도한 값과 같은지 확인**한 뒤에만 파일로 내보낸다.
// 왕복이 깨지면 조용히 고치지 않는다 — 승인을 거부한다.

import { parseYaml } from '../yaml-lite.mjs';

const PLAIN_SCALAR_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-/]*$/;

/** 제어문자와 tab은 yaml-lite가 읽을 수 없다. 있는 그대로 쓰는 대신 정규화한다. */
export function normalizeText(s) {
  return String(s)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trimEnd();
}

/** 여러 줄이든 한 줄이든 block scalar로 낸다. 따옴표 이스케이프 문제를 아예 만들지 않는다. */
function blockScalar(value, indent) {
  const pad = ' '.repeat(indent);
  const body = normalizeText(value)
    .split('\n')
    .map((l) => (l.trim() === '' ? '' : `${pad}${l}`))
    .join('\n');
  return `|-\n${body}`;
}

const plain = (v) => (PLAIN_SCALAR_RE.test(String(v)) ? String(v) : null);

function flowList(values) {
  if (values.length === 0) return '[]';
  const parts = values.map((v) => {
    const p = plain(v);
    if (p === null) throw new Error(`cannot serialize "${v}" in a flow list (unsupported characters)`);
    return p;
  });
  return `[${parts.join(', ')}]`;
}

/**
 * Task 본문 하나를 YAML 문자열로 만든다.
 * 필드 순서는 TASK-EXAMPLE.yaml과 같게 고정한다 — 사람이 읽는 파일이다.
 */
export function emitTaskYaml(data, { header = [] } = {}) {
  const out = [];
  for (const line of header) out.push(line);
  if (header.length > 0) out.push('');

  out.push(`id: ${data.id}`);
  out.push(`status: ${data.status}`);
  out.push('');
  out.push(`request: ${blockScalar(data.request, 2)}`);
  out.push('');
  out.push('execution:');
  out.push(`  role: ${data.execution.role}`);
  out.push('');

  if (Array.isArray(data.depends_on) && data.depends_on.length > 0) {
    out.push('# 선행 Task. 전부 DONE이 되기 전까지 이 Task는 READY가 되지 않는다.');
    out.push('depends_on:');
    for (const dep of data.depends_on) out.push(`  - ${dep}`);
    out.push('');
  }

  out.push('stop_condition:');
  out.push(`  gates: ${flowList(data.stop_condition.gates)}`);
  out.push(`  requires_verifier: ${data.stop_condition.requires_verifier}`);
  out.push(`  max_consecutive_failures: ${data.stop_condition.max_consecutive_failures}`);
  out.push('');

  out.push('acceptance_criteria:');
  for (const ac of data.acceptance_criteria) {
    out.push(`  - id: ${ac.id}`);
    out.push(`    description: ${blockScalar(ac.description, 6)}`);
    out.push('    verification:');
    out.push(`      type: ${ac.verification.type}`);
    if (ac.verification.ref !== undefined) out.push(`      ref: ${ac.verification.ref}`);
    if (ac.verification.instruction !== undefined) {
      out.push(`      instruction: ${blockScalar(ac.verification.instruction, 8)}`);
    }
  }
  out.push('');
  out.push('evidence: []');
  out.push('');
  out.push('failure_memo: []');
  out.push('');
  return out.join('\n');
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length || !ka.every((k, i) => k === kb[i])) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * 직렬화 → 재파싱 → 의도한 값과 비교. 이 검사를 통과한 문자열만 파일로 쓴다.
 * @returns {{ ok: true, text: string } | { ok: false, errors: string[] }}
 */
export function renderTaskYaml(data, opts) {
  let text;
  try {
    text = emitTaskYaml(data, opts);
  } catch (e) {
    return { ok: false, errors: [`${data.id}: cannot serialize task - ${e.message}`] };
  }

  let parsed;
  try {
    parsed = parseYaml(text);
  } catch (e) {
    return { ok: false, errors: [`${data.id}: serialized task does not parse back - ${e.message}`] };
  }
  if (!deepEqual(parsed, data)) {
    return {
      ok: false,
      errors: [
        `${data.id}: serialized task does not round-trip to the intended value`,
        `  intended: ${JSON.stringify(data)}`,
        `  reparsed: ${JSON.stringify(parsed)}`,
      ],
    };
  }
  return { ok: true, text };
}
