// Bounded, deterministic file index. No provider call, transcript, or generated summary.
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, loadAllTasks, dependsOn } from './task-store.mjs';

export function buildTaskResources(task, root = ROOT) {
  let files;
  try { files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).split('\0'); }
  catch { return '(file index unavailable; use targeted search)'; }
  const text = `${task.data.request}\n${task.data.acceptance_criteria.map((a) => a.description).join('\n')}`;
  const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [])];
  const defaults = ['package.json', 'pyproject.toml', 'docs/SYSTEM-MAP.md'];
  const ranked = [...new Set(files)].filter((p) => p && !p.startsWith('.loop') && !p.startsWith('.git') && !p.startsWith('tools/loop-runtime') && !p.startsWith('loop-prompts/') && !/(^|\/)\.env|credentials|secret|lock\./i.test(p))
    .map((path) => ({ path, score: (text.includes(path) ? 100 : 0) + (defaults.includes(path) ? 10 : 0) + words.filter((w) => path.toLowerCase().includes(w)).length }))
    .filter((p) => p.score > 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 10);
  const lines = ['Current files (hashes recomputed for this attempt; read these first, expand only as needed):'];
  for (const { path } of ranked) {
    try {
      const stat = lstatSync(join(root, path));
      if (!stat.isFile() || stat.size > 256 * 1024) continue;
      const buf = readFileSync(join(root, path));
      const hash = createHash('sha256').update(buf).digest('hex');
      lines.push(`${path} sha256=${hash}`);
      const symbols = buf.toString('utf8').split('\n').map((line, i) => ({ line, i })).filter(({ line }) => /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|def)\s/.test(line)).slice(0, 6);
      for (const s of symbols) lines.push(`  L${s.i + 1}: ${s.line.slice(0, 140)}`);
    } catch { /* File disappeared; do not invent content. */ }
  }
  const dependencies = new Set(dependsOn(task));
  for (const t of loadAllTasks().filter((t) => dependencies.has(t.id))) {
    lines.push(`Dependency ${t.id} (${t.data.status}): ${t.data.request.replace(/\s+/g, ' ').slice(0, 180)}`);
    for (const e of (t.data.evidence ?? []).slice(0, 3)) lines.push(`  evidence path: ${e.path}`);
  }
  lines.push('Checks: node tools/loop-runtime/loopctl.mjs self-check ' + task.data.stop_condition.gates.join(' '));
  return lines.join('\n').slice(0, 6000);
}
