// telemetry — Runtime이 직접 관찰한 사실만 기록한다.
//
// 규칙: 추가 LLM 호출을 하지 않는다. 모델에게 사용량을 계산하거나 요약하게 하지 않는다.
//       여기서 만든 값은 Runtime metadata이며 Worker Context에 넣지 않는다.

import { execFileSync } from 'node:child_process';
import { statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** context.md의 크기 지표. 파일 내용에서 직접 센다. */
export function contextMetrics(contextText) {
  return {
    bytes: Buffer.byteLength(contextText, 'utf8'),
    characters: [...contextText].length,
    lines: contextText.split('\n').length,
  };
}

export function outputMetrics(stdout, stderr) {
  return {
    stdout_bytes: Buffer.byteLength(stdout ?? '', 'utf8'),
    stderr_bytes: Buffer.byteLength(stderr ?? '', 'utf8'),
  };
}

/**
 * Adapter가 provider 사용량을 돌려주면 그대로 옮긴다. 없는 값은 만들지 않는다.
 * source: 'provider' | 'unavailable'  (추정치를 쓰게 되면 'estimated'로 표시한다)
 */
export function normalizeTokens(providerUsage) {
  if (!providerUsage || typeof providerUsage !== 'object') return { source: 'unavailable' };
  const out = { source: 'provider' };
  const copy = (key, value) => {
    if (Number.isFinite(value)) out[key] = value;
  };
  copy('input', providerUsage.input);
  copy('output', providerUsage.output);
  copy('cached_input', providerUsage.cached_input);
  copy('cache_creation_input', providerUsage.cache_creation_input);
  copy('total', providerUsage.total);
  // 어떤 필드도 실제로 오지 않았다면 provider 사용량이 있다고 말하지 않는다.
  return Object.keys(out).length === 1 ? { source: 'unavailable' } : out;
}

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * Runtime이 직접 관찰한 변경 파일. Worker가 신고한 changed_files와 별도로 기록한다.
 * git은 read-only로만 쓴다(status/ls-files). 없으면 available: false.
 */
export function observeChanges(cwd, { ignore = [] } = {}) {
  if (!existsSync(join(cwd, '.git'))) {
    return { source: 'unavailable', reason: 'not a git repository', files: [], count: 0 };
  }
  let out;
  try {
    out = git(['status', '--porcelain=v1', '--untracked-files=all'], cwd);
  } catch (e) {
    return { source: 'unavailable', reason: `git failed: ${e.message.split('\n')[0]}`, files: [], count: 0 };
  }
  const files = out
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const path = l.slice(3);
      // rename은 "old -> new" 형태다. 새 경로만 남긴다.
      return path.includes(' -> ') ? path.split(' -> ')[1] : path;
    })
    .map((p) => p.replace(/^"|"$/g, ''))
    .filter((p) => !ignore.some((prefix) => p.startsWith(prefix)))
    .sort();
  return { source: 'git', files, count: files.length };
}

/** Run 시작 전/후 스냅샷의 차집합. Worker가 만든 변경만 남긴다. */
export function diffObserved(before, after) {
  if (after.source !== 'git') return after;
  const wasThere = new Set(before.source === 'git' ? before.files : []);
  const files = after.files.filter((f) => !wasThere.has(f));
  return { source: 'git', files, count: files.length };
}

export function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
