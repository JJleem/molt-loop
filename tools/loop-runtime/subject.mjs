// subject — Verification Subject Fingerprint.
//
// "지금 검증 대상이 되는 저장소 상태가 정확히 무엇인가"를 결정론적으로 한 값으로 요약한다.
// Gate와 Verifier가 같은 대상을 봤다는 것을 증명하는 데 쓴다. LLM은 관여하지 않는다.
//
// 성질:  같은 대상 -> 같은 fingerprint,  의미 있게 바뀐 대상 -> 다른 fingerprint
//
// 범위: HEAD commit + git이 보고하는 변경/미추적 파일의 내용 해시.
//       gitignore된 것(빌드 캐시·의존성)은 git이 이미 제외하므로 포함되지 않는다.
//       .loop-local/ 은 Runtime 자신의 Run 산출물이므로 명시적으로 제외한다.
//       (Gate Report를 쓰는 행위가 검증 대상을 바꾸면 안 된다.)

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ROOT } from './task-store.mjs';

export const SUBJECT_TYPE = 'git-worktree';
// Runtime 자신의 실행 산출물. 검증 대상이 아니다.
const EXCLUDE_PREFIXES = ['.loop-local/'];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

/**
 * `git status --porcelain=v1 -z` 를 파싱한다. -z는 경로를 인용하지 않으므로
 * 공백·따옴표·유니코드가 든 경로도 그대로 나온다.
 * rename/copy 항목은 새 경로 다음에 원본 경로가 한 번 더 온다.
 */
function parseStatusZ(out) {
  const parts = out.split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i += 1) {
    const rec = parts[i];
    if (rec === '') continue;
    const code = rec.slice(0, 2);
    const path = rec.slice(3);
    if (code[0] === 'R' || code[0] === 'C') {
      const from = parts[i + 1] ?? '';
      i += 1;
      entries.push({ path, code, renamed_from: from });
    } else {
      entries.push({ path, code });
    }
  }
  return entries;
}

/**
 * 검증 대상의 현재 지문.
 * @returns {{ type, available, reason?, head, dirty_entry_count, entries, sha256 }}
 */
export function computeSubject(cwd = ROOT) {
  if (!existsSync(join(cwd, '.git'))) {
    return {
      type: SUBJECT_TYPE, available: false, reason: 'not a git repository',
      head: null, dirty_entry_count: 0, entries: [], sha256: null,
    };
  }

  let head = null;
  try {
    head = git(['rev-parse', 'HEAD'], cwd).trim();
  } catch {
    head = null; // commit이 하나도 없는 저장소. entries가 전체 상태를 담는다.
  }

  let statusOut;
  try {
    statusOut = git(['status', '--porcelain=v1', '--untracked-files=all', '-z'], cwd);
  } catch (e) {
    return {
      type: SUBJECT_TYPE, available: false,
      reason: `git status failed: ${e.message.split('\n')[0]}`,
      head, dirty_entry_count: 0, entries: [], sha256: null,
    };
  }

  const entries = [];
  for (const e of parseStatusZ(statusOut)) {
    if (EXCLUDE_PREFIXES.some((p) => e.path.startsWith(p))) continue;
    const abs = join(cwd, e.path);
    let content = null;
    let size = null;
    try {
      if (statSync(abs).isFile()) {
        const buf = readFileSync(abs);
        content = sha256(buf);
        size = buf.length;
      }
    } catch {
      content = null; // 삭제되었거나 읽을 수 없음 — 그 사실 자체가 지문의 일부다.
    }
    entries.push({ path: e.path, code: e.code, sha256: content, size });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // 정규화된 표현 위에서 한 번 더 해시한다. 필드 순서가 고정되어야 재현 가능하다.
  const canonical = JSON.stringify({
    type: SUBJECT_TYPE,
    head,
    entries: entries.map((e) => [e.path, e.code, e.sha256, e.size]),
  });

  return {
    type: SUBJECT_TYPE,
    available: true,
    head,
    dirty_entry_count: entries.length,
    entries,
    sha256: sha256(canonical),
  };
}

/** Report에 넣는 최소 형태. entries 전체를 매번 복사하지 않는다. */
export function subjectRef(subject) {
  return {
    type: subject.type,
    sha256: subject.sha256,
    head: subject.head,
    dirty_entry_count: subject.dirty_entry_count,
  };
}

/** 두 지문이 같은 대상을 가리키는가. sha256이 없으면(계산 불가) 같다고 하지 않는다. */
export function sameSubject(a, b) {
  return Boolean(a?.sha256) && Boolean(b?.sha256) && a.sha256 === b.sha256;
}
