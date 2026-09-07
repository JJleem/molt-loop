// Internal entrypoint, executed from the copied runtime inside a private workspace.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadAllTasks } from '../task-store.mjs';
import { runWorkerOnce } from './runner.mjs';

const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const task = loadAllTasks().find((t) => t.id === job.taskId);
if (!task || task.errors.length) throw new Error('isolated task is missing or invalid');
const runDir = join(ROOT, '.loop-local', 'runs', job.runId);
const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'));
const out = await runWorkerOnce({ task, snapshot: { runId: job.runId, runDir, manifest }, config: job.config, attempt: job.attempt });
if (out.failures.length) process.exitCode = 1;
