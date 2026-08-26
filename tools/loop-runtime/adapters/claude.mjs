// adapter: claude — 로컬에 설치된 Claude Code CLI를 Worker로 실행한다.
//
// 실제 설치된 CLI(2.1.x)에서 확인한 것만 사용한다:
//   -p / --print                 비대화 실행
//   --output-format json         구조화된 최종 결과(사용량 포함)
//   --append-system-prompt       Runtime이 Result 규약을 덧붙이는 자리
//   --permission-mode            acceptEdits
//   --settings <json>            추가 설정(권한 deny/allow 규칙)
//   --model                      선택
//   --tools <list>               사용 가능한 built-in tool 집합 자체를 제한 (Verifier 읽기 전용)
//   --disallowedTools <list>     tool 거부 (Verifier 이중 방어)
//   --json-schema <schema>       구조화 출력. 응답 payload의 structured_output에 파싱된 객체가 온다.
//   --no-session-persistence     세션을 저장하지 않는다 (Verifier는 항상 새 세션이다)
//   --strict-mcp-config          --mcp-config로 준 것 외의 MCP 서버를 무시한다 (Planner 격리)
//   --disable-slash-commands     Skill 자동 로드를 끈다 (Planner 격리)
// 여기에 없는 플래그는 추가하지 않는다.

import { spawn } from 'node:child_process';

export const name = 'claude';

export async function detect() {
  const r = await capture('claude', ['--version'], 15_000);
  if (r.error) return { available: false, reason: r.error };
  if (r.exitCode !== 0) return { available: false, reason: `\`claude --version\` exited ${r.exitCode}` };
  return { available: true, version: r.stdout.trim().split('\n')[0] };
}

function capture(cmd, args, timeoutMs, { stdin, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ error: `cannot spawn ${cmd}: ${e.message}`, exitCode: null, stdout: '', stderr: '' });
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      const reason = e.code === 'ENOENT' ? `executable not found: ${cmd}` : e.message;
      resolve({ error: reason, exitCode: null, stdout, stderr, timedOut });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code, signal, stdout, stderr, timedOut });
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

/**
 * Worker 실행.
 *
 * `--permission-mode acceptEdits` 는 파일 편집만 자동 승인하고 Bash는 승인하지 않는다.
 * 그래서 Worker가 self-check를 돌릴 수 있으려면 allow 규칙이 필요하다. Runtime은
 * self-check 진입점 하나만 allow에 넣는다(worker/policy.mjs) — 임의 명령은 여전히 거부된다.
 *
 * @param {{context: string, systemPrompt: string, cwd: string, timeoutMs: number,
 *          model: string|null, deny: string[], allow: string[]}} opts
 */
export async function runWorker({ context, systemPrompt, cwd, timeoutMs, model, deny = [], allow = [] }) {
  const args = [
    '--print',
    '--output-format', 'json',
    '--permission-mode', 'acceptEdits',
    '--append-system-prompt', systemPrompt,
  ];
  const permissions = {};
  if (deny.length > 0) permissions.deny = deny;
  if (allow.length > 0) permissions.allow = allow;
  if (Object.keys(permissions).length > 0) args.push('--settings', JSON.stringify({ permissions }));
  if (model) args.push('--model', model);

  const started = Date.now();
  const r = await capture('claude', args, timeoutMs, { stdin: context, cwd });
  const duration = Date.now() - started;

  const out = {
    adapter: name,
    launch_error: r.error ?? null,
    exit_code: r.exitCode,
    signal: r.signal ?? null,
    timed_out: Boolean(r.timedOut),
    duration_ms: duration,
    stdout: r.stdout,
    stderr: r.stderr,
    provider_usage: null,
    model: null,
    adapter_meta: null,
  };
  if (r.error) return out;

  // --output-format json 은 stdout 전체가 하나의 JSON 객체다.
  let payload = null;
  try {
    payload = JSON.parse(r.stdout);
  } catch {
    out.adapter_meta = { parse_error: 'stdout was not a single JSON object' };
    return out;
  }

  out.provider_usage = readUsage(payload);
  out.model = readModel(payload);
  out.adapter_meta = readMeta(payload);
  return out;
}

/** CLI가 실제로 보고한 사용량만 옮긴다. 없는 값은 만들지 않는다. */
function readUsage(payload) {
  const u = payload.usage ?? {};
  const usage = {};
  if (Number.isFinite(u.input_tokens)) usage.input = u.input_tokens;
  if (Number.isFinite(u.output_tokens)) usage.output = u.output_tokens;
  if (Number.isFinite(u.cache_read_input_tokens)) usage.cached_input = u.cache_read_input_tokens;
  if (Number.isFinite(u.cache_creation_input_tokens)) usage.cache_creation_input = u.cache_creation_input_tokens;
  return Object.keys(usage).length > 0 ? usage : null;
}

/** 모델 이름은 추측하지 않는다. CLI가 보고한 것만 쓴다. */
function readModel(payload) {
  const models = Object.keys(payload.modelUsage ?? {});
  return models.length === 1 ? models[0] : (models.length > 1 ? models.join(',') : null);
}

function readMeta(payload) {
  return {
    session_id: payload.session_id ?? null,
    num_turns: payload.num_turns ?? null,
    terminal_reason: payload.terminal_reason ?? null,
    stop_reason: payload.stop_reason ?? null,
    is_error: payload.is_error ?? null,
    duration_api_ms: payload.duration_api_ms ?? null,
    permission_denials: Array.isArray(payload.permission_denials) ? payload.permission_denials.length : null,
    provider_cost_usd: Number.isFinite(payload.total_cost_usd) ? payload.total_cost_usd : null,
  };
}

/**
 * Verifier 실행 — Worker와 완전히 분리된 새 invocation이다.
 * 세션을 재개하지 않고, Worker의 session_id를 넘기지 않으며, 쓰기 도구를 아예 주지 않는다.
 *
 * 결과는 파일이 아니라 CLI의 구조화 출력(--json-schema -> payload.structured_output)으로 받는다.
 * Verifier에게 쓰기 권한을 주지 않기 위해서다. 대화 텍스트는 판정 근거가 아니다.
 *
 * @param {{context: string, systemPrompt: string, cwd: string, timeoutMs: number,
 *          model: string|null, schema: object, tools: string[], deny: string[]}} opts
 */
export async function runVerifier({ context, systemPrompt, cwd, timeoutMs, model, schema, tools, deny = [] }) {
  const args = [
    '--print',
    '--output-format', 'json',
    '--no-session-persistence',
    '--tools', tools.join(','),
    '--json-schema', JSON.stringify(schema),
    '--append-system-prompt', systemPrompt,
  ];
  // built-in tool 집합 제한 + 명시적 거부. 둘 다 건다.
  if (deny.length > 0) {
    args.push('--disallowedTools', ...deny);
    args.push('--settings', JSON.stringify({ permissions: { deny } }));
  }
  if (model) args.push('--model', model);

  const started = Date.now();
  const r = await capture('claude', args, timeoutMs, { stdin: context, cwd });
  const duration = Date.now() - started;

  const out = {
    adapter: name,
    launch_error: r.error ?? null,
    exit_code: r.exitCode,
    signal: r.signal ?? null,
    timed_out: Boolean(r.timedOut),
    duration_ms: duration,
    stdout: r.stdout,
    stderr: r.stderr,
    provider_usage: null,
    model: null,
    structured_output: null,
    adapter_meta: null,
  };
  if (r.error) return out;

  let payload = null;
  try {
    payload = JSON.parse(r.stdout);
  } catch {
    out.adapter_meta = { parse_error: 'stdout was not a single JSON object' };
    return out;
  }

  // 구조화 출력이 없으면 없는 것이다. 대화 텍스트에서 판정을 긁어내지 않는다.
  out.structured_output = (payload.structured_output && typeof payload.structured_output === 'object')
    ? payload.structured_output
    : null;

  out.provider_usage = readUsage(payload);
  out.model = readModel(payload);
  out.adapter_meta = readMeta(payload);
  return out;
}

/**
 * Goal Planner 실행 — Worker와도 Verifier와도 완전히 분리된 새 invocation이다.
 * 세션을 재개하지 않고, 이전 대화를 넘기지 않으며, 쓰기 도구를 아예 주지 않는다.
 *
 * Verifier보다 격리를 한 단계 더 건다. Planner는 저장소 전체를 자유롭게 훑기 때문에
 * 무관한 MCP 서버와 Skill이 계획에 섞여 들어갈 여지를 미리 없앤다.
 * (Worker/Verifier의 기존 격리는 건드리지 않는다.)
 *
 * 결과는 파일이 아니라 CLI의 구조화 출력(--json-schema -> payload.structured_output)으로 받는다.
 *
 * @param {{context: string, systemPrompt: string, cwd: string, timeoutMs: number,
 *          model: string|null, schema: object, tools: string[], deny: string[]}} opts
 */
export async function runPlanner({ context, systemPrompt, cwd, timeoutMs, model, schema, tools, deny = [] }) {
  const args = [
    '--print',
    '--output-format', 'json',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--tools', tools.join(','),
    '--json-schema', JSON.stringify(schema),
    '--append-system-prompt', systemPrompt,
  ];
  if (deny.length > 0) {
    args.push('--disallowedTools', ...deny);
    args.push('--settings', JSON.stringify({ permissions: { deny } }));
  }
  if (model) args.push('--model', model);

  const started = Date.now();
  const r = await capture('claude', args, timeoutMs, { stdin: context, cwd });
  const duration = Date.now() - started;

  const out = {
    adapter: name,
    launch_error: r.error ?? null,
    exit_code: r.exitCode,
    signal: r.signal ?? null,
    timed_out: Boolean(r.timedOut),
    duration_ms: duration,
    stdout: r.stdout,
    stderr: r.stderr,
    provider_usage: null,
    model: null,
    structured_output: null,
    adapter_meta: null,
  };
  if (r.error) return out;

  let payload = null;
  try {
    payload = JSON.parse(r.stdout);
  } catch {
    out.adapter_meta = { parse_error: 'stdout was not a single JSON object' };
    return out;
  }

  // 구조화 출력이 없으면 없는 것이다. 대화 텍스트에서 계획을 긁어내지 않는다.
  out.structured_output = (payload.structured_output && typeof payload.structured_output === 'object')
    ? payload.structured_output
    : null;

  out.provider_usage = readUsage(payload);
  out.model = readModel(payload);
  out.adapter_meta = readMeta(payload);
  return out;
}
