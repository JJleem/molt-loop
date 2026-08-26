// verifier/canonical-diff — 검증 대상 변경의 결정론적 표현.
//
// 범위는 **Runtime이 관찰한 변경 파일**이다(Runtime Envelope의 observed_changes).
// Worker가 신고한 changed_files는 진실의 근거가 아니라 대조 대상이다 — 관찰되지 않았지만
// Worker가 주장한 경로는 provenance를 표시해서 함께 싣는다.
//
// 크기는 반드시 유계여야 한다. 큰 파일·바이너리는 내용 대신 경로/크기/sha256으로 표현한다.
// LLM은 여기에 관여하지 않는다.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ROOT } from '../task-store.mjs';

// 한 파일에서 patch로 실을 최대 바이트, 그리고 patch 전체 상한.
export const PER_FILE_LIMIT_BYTES = 64 * 1024;
export const TOTAL_PATCH_LIMIT_BYTES = 512 * 1024;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function git(args, { tolerateExit = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    // `git diff` 계열은 차이가 있으면 exit 1을 낸다. 그건 실패가 아니다.
    if (tolerateExit && typeof e.stdout === 'string') return e.stdout;
    throw e;
  }
}

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

/** 미추적 신규 파일용 unified patch. 임시 파일이나 /dev/null에 의존하지 않는다. */
function newFilePatch(path, text) {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const body = lines.map((l) => `+${l}`);
  if (!text.endsWith('\n') && text !== '') body.push('\\ No newline at end of file');
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...body,
    '',
  ].join('\n');
}

/** git이 이 경로를 추적하고 있는가. 추적 중이면 HEAD 대비 diff를 뽑을 수 있다. */
function isTracked(path) {
  try {
    return git(['ls-files', '--error-unmatch', '--', path]).trim() !== '';
  } catch {
    return false;
  }
}

/**
 * @param {{ envelope: object, workerResult: object|null }} input
 * @returns {{ patch: string, files: object[], truncated: boolean, notes: string[] }}
 */
export function buildCanonicalDiff({ envelope, workerResult }) {
  const notes = [];
  const observed = envelope.observed_changes ?? { source: 'unavailable', files: [] };
  const claimed = Array.isArray(workerResult?.changed_files) ? workerResult.changed_files : [];

  const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');
  const observedSet = new Set((observed.files ?? []).map(norm));
  const claimedSet = new Set(claimed.map(norm));

  const paths = [...new Set([...observedSet, ...claimedSet])]
    .filter((p) => !p.startsWith('.loop-local/'))
    .sort();

  if (observed.source !== 'git') {
    notes.push(`runtime could not observe changes with git (${observed.reason ?? observed.source}); scope falls back to worker-claimed paths only`);
  }
  const claimedOnly = [...claimedSet].filter((p) => !observedSet.has(p));
  if (claimedOnly.length > 0) {
    notes.push(`${claimedOnly.length} path(s) were claimed by the worker but not observed as new by the runtime`);
  }
  const observedOnly = [...observedSet].filter((p) => !claimedSet.has(p));
  if (observedOnly.length > 0) {
    notes.push(`${observedOnly.length} path(s) were observed by the runtime but not claimed by the worker`);
  }

  const files = [];
  const chunks = [];
  let total = 0;
  let truncated = false;

  for (const path of paths) {
    const abs = join(ROOT, path);
    const provenance = observedSet.has(path)
      ? (claimedSet.has(path) ? 'runtime-observed+worker-claimed' : 'runtime-observed')
      : 'worker-claimed-only';

    if (!existsSync(abs)) {
      files.push({ path, change: 'deleted-or-missing', size: null, sha256: null, provenance, patch_included: false });
      continue;
    }
    let st;
    try {
      st = statSync(abs);
    } catch (e) {
      files.push({ path, change: 'unreadable', size: null, sha256: null, provenance, patch_included: false, note: e.code ?? e.message });
      continue;
    }
    if (!st.isFile()) {
      files.push({ path, change: 'not-a-file', size: null, sha256: null, provenance, patch_included: false });
      continue;
    }

    const buf = readFileSync(abs);
    const tracked = isTracked(path);
    const entry = {
      path,
      change: tracked ? 'modified' : 'added',
      size: buf.length,
      sha256: sha256(buf),
      binary: isBinary(buf),
      provenance,
      patch_included: false,
    };

    if (entry.binary) {
      notes.push(`${path}: binary content represented by hash only`);
    } else if (buf.length > PER_FILE_LIMIT_BYTES) {
      entry.note = `content omitted: ${buf.length} bytes exceeds the ${PER_FILE_LIMIT_BYTES}-byte per-file limit`;
      truncated = true;
    } else if (total >= TOTAL_PATCH_LIMIT_BYTES) {
      entry.note = 'content omitted: total patch size limit reached';
      truncated = true;
    } else {
      let chunk;
      if (tracked) {
        chunk = git(['diff', '--no-color', 'HEAD', '--', path], { tolerateExit: true });
        if (chunk.trim() === '') chunk = '';
      } else {
        chunk = newFilePatch(path, buf.toString('utf8'));
      }
      if (chunk !== '') {
        chunks.push(chunk.endsWith('\n') ? chunk : `${chunk}\n`);
        total += Buffer.byteLength(chunk, 'utf8');
        entry.patch_included = true;
      }
    }
    files.push(entry);
  }

  return { patch: chunks.join(''), files, truncated, notes };
}
