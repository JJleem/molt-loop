// File-isolated workers. Each workspace has its own Git index and dependencies.
// Integration is serialized by the owning runtime; a mismatched base is never overwritten.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, lstatSync, readdirSync, renameSync, unlinkSync, readlinkSync, symlinkSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ROOT, LOCAL_DIR } from '../task-store.mjs';
import { assertBudget } from '../usage-ledger.mjs';
import { validateWorkerResult } from './result.mjs';
import { computeSubject, subjectRef } from '../subject.mjs';

const hash = (buf) => createHash('sha256').update(buf).digest('hex');
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
function safePath(root, path) {
  const abs = resolve(root, path);
  if (abs === resolve(root) || !abs.startsWith(resolve(root) + sep)) throw new Error(`path escapes workspace: ${path}`);
  let current = root;
  for (const part of relative(root, abs).split(sep)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`workspace isolation does not follow links: ${path}`);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return abs;
}
function fileHash(root, path) {
  const p = safePath(root, path);
  if (!existsSync(p)) return null;
  if (!lstatSync(p).isFile()) throw new Error(`expected a regular file: ${path}`);
  return hash(readFileSync(p));
}
function trackedFiles(root) {
  return [...new Set(git(root, ['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(Boolean))].filter((p) => !p.startsWith('.loop-local/') && !p.startsWith('.git/'));
}
function copyDirectory(source, target, sourceRoot = source, targetRoot = target) {
  for (const e of readdirSync(source, { withFileTypes: true })) {
    const src = join(source, e.name), dest = join(target, e.name);
    if (e.isSymbolicLink()) {
      const linkTarget = resolve(dirname(src), readlinkSync(src));
      if (!linkTarget.startsWith(resolve(sourceRoot) + sep)) throw new Error(`dependency link leaves node_modules: ${src}`);
      const privateTarget = join(targetRoot, relative(sourceRoot, linkTarget));
      mkdirSync(dirname(dest), { recursive: true });
      symlinkSync(relative(dirname(dest), privateTarget), dest);
    }
    else if (e.isDirectory()) { mkdirSync(dest, { recursive: true }); copyDirectory(src, dest, sourceRoot, targetRoot); }
    else { mkdirSync(dirname(dest), { recursive: true }); cpSync(src, dest); }
  }
}
function runEntry(workspace, jobPath) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [join(workspace, 'tools/loop-runtime/worker/isolated-entry.mjs'), jobPath], { cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-8192); });
    child.on('error', (e) => resolveRun({ code: null, error: e.message }));
    child.on('close', (code) => resolveRun({ code, error: stderr }));
  });
}

/** A journal permits retrying integration without another paid worker invocation. */
export function integrateWorkspace(runDir) {
  const path = join(runDir, 'integration.json');
  const job = JSON.parse(readFileSync(path, 'utf8'));
  const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'));
  const workspaceRoot = resolve(LOCAL_DIR, 'workspaces') + sep;
  if (job.task_id !== manifest.task_id || job.run_id !== manifest.run_id || typeof job.workspace !== 'string' || !resolve(job.workspace).startsWith(workspaceRoot) || !Array.isArray(job.files)) throw new Error('invalid integration journal identity or workspace');
  for (const f of job.files) {
    if (typeof f.path !== 'string' || f.path.includes('\\') || f.path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('integration paths must be canonical relative paths');
    if (typeof f.path !== 'string' || (f.path.startsWith('.loop/') && !f.path.startsWith(`.loop/evidence/${job.task_id}/`)) || f.path.startsWith('tools/loop-runtime/') || f.path === '.git' || f.path.startsWith('.git/') || f.path === '.gitignore') throw new Error('integration journal contains a protected path');
    if ([f.before, f.after].some((v) => v !== null && (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)))) throw new Error('invalid integration hash');
    safePath(ROOT, f.path);
  }
  if (job.status === 'integrated') return { ok: true };
  const conflicts = [];
  for (const f of job.files) {
    const current = fileHash(ROOT, f.path);
    if (current !== f.before && current !== f.after) conflicts.push(f.path);
    if (fileHash(job.workspace, f.path) !== f.after) conflicts.push(`${f.path} (workspace changed after worker)`);
  }
  if (conflicts.length) return { ok: false, reason: `integration conflict: ${conflicts.join(', ')}; workspace preserved at ${job.workspace}` };
  for (const f of job.files) {
    const dest = safePath(ROOT, f.path);
    const current = fileHash(ROOT, f.path);
    if (current === f.after) continue;
    if (current !== f.before) return { ok: false, reason: `integration conflict: ${f.path} changed during integration; workspace: ${job.workspace}` };
    if (f.after === null) {
      // Retained workspace Git baseline and this journal preserve the deleted content.
      unlinkSync(dest);
    } else {
      mkdirSync(dirname(dest), { recursive: true });
      const tmp = `${dest}.loop-${randomUUID()}.tmp`;
      cpSync(safePath(job.workspace, f.path), tmp, { force: false, errorOnExist: true });
      renameSync(tmp, dest);
    }
  }
  job.status = 'integrated';
  job.integrated_at = new Date().toISOString();
  job.main_subject_after = subjectRef(computeSubject(ROOT));
  job.worker_envelope_sha256 = hash(readFileSync(join(runDir, 'runtime-envelope.json')));
  writeFileSync(path, JSON.stringify(job, null, 2));
  return { ok: true };
}

export async function runIsolatedWorker({ task, snapshot, config, attempt }) {
  assertBudget(config, task.id);
  const parent = join(LOCAL_DIR, 'workspaces');
  mkdirSync(parent, { recursive: true });
  const workspace = mkdtempSync(join(parent, `${task.id}-`));
  const baseline = new Map();
  for (const path of trackedFiles(ROOT)) {
    const src = safePath(ROOT, path);
    if (!existsSync(src)) continue;
    baseline.set(path, fileHash(ROOT, path));
    const dest = safePath(workspace, path);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
  }
  // Never share writable dependencies between workers. Copy cost is visible in stage wall time.
  if (existsSync(join(ROOT, 'node_modules'))) copyDirectory(join(ROOT, 'node_modules'), join(workspace, 'node_modules'));
  const localRun = join(workspace, '.loop-local/runs', snapshot.runId);
  mkdirSync(dirname(localRun), { recursive: true });
  cpSync(snapshot.runDir, localRun, { recursive: true });
  git(workspace, ['init', '-q']);
  writeFileSync(join(workspace, '.git/info/exclude'), '/.loop-local/\n/node_modules/\n');
  git(workspace, ['add', '-A']);
  git(workspace, ['-c', 'user.name=Loop Runtime', '-c', 'user.email=loop@localhost', 'commit', '-qm', 'isolated worker baseline']);
  const jobPath = join(workspace, '.loop-local/job.json');
  const childConfig = structuredClone(config);
  // Parent checks cumulative budgets; this private tree has no historical billing ledger.
  childConfig.efficiency.budget = { task_usd: null, plan_usd: null, task_output_tokens: null };
  writeFileSync(jobPath, JSON.stringify({ taskId: task.id, runId: snapshot.runId, attempt, config: childConfig }));
  writeFileSync(join(snapshot.runDir, 'worker-started.json'), JSON.stringify({ task_id: task.id, run_id: snapshot.runId, workspace, started_at: new Date().toISOString() }));
  const processResult = await runEntry(workspace, jobPath);
  for (const name of ['worker-result.json', 'runtime-envelope.json', 'stdout.log', 'stderr.log']) {
    if (existsSync(join(localRun, name))) cpSync(join(localRun, name), join(snapshot.runDir, name));
  }
  const envPath = join(snapshot.runDir, 'runtime-envelope.json');
  if (!existsSync(envPath)) throw new Error(`isolated worker did not finish: ${processResult.error}; workspace: ${workspace}`);
  const envelope = JSON.parse(readFileSync(envPath, 'utf8'));
  const resultPath = join(snapshot.runDir, 'worker-result.json');
  let workerResult = null;
  if (existsSync(resultPath)) {
    try {
      const parsed = validateWorkerResult(JSON.parse(readFileSync(resultPath, 'utf8')), { runId: snapshot.runId, taskId: task.id });
      workerResult = parsed.result;
    } catch { /* Preserve the envelope's schema failure and finish the integration receipt. */ }
  }
  const failures = [...envelope.failures];
  if (envelope.policy_violation) return { envelope, workerResult, failures };
  const paths = new Set([...baseline.keys(), ...trackedFiles(workspace)]);
  const files = [];
  for (const path of paths) {
    const before = baseline.get(path) ?? null;
    const after = fileHash(workspace, path);
    if (before === after) continue;
    if ((path.startsWith('.loop/') && !path.startsWith(`.loop/evidence/${task.id}/`)) || path.startsWith('tools/loop-runtime/') || path === '.git' || path.startsWith('.git/') || path === '.gitignore') {
      failures.push(`isolated worker changed protected path: ${path}`);
      continue;
    }
    files.push({ path, before, after });
  }
  if (failures.some((f) => f.includes('protected path'))) {
    writeFileSync(join(snapshot.runDir, 'integration.json'), JSON.stringify({ status: 'rejected', workspace, reason: failures.join('; ') }));
    return { envelope, workerResult, failures };
  }
  writeFileSync(join(snapshot.runDir, 'integration.json'), JSON.stringify({ status: 'pending', workspace, task_id: task.id, run_id: snapshot.runId, files }, null, 2));
  const integrated = integrateWorkspace(snapshot.runDir);
  if (!integrated.ok) failures.push(integrated.reason);
  return { envelope, workerResult, failures };
}
