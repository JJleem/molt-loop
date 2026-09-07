import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// Private Git HEADs are not comparable with the receiving repository.
// Only a runtime integration receipt may bind an isolated attempt to that tree.
export function workerRecoverySubject(runDir, envelope) {
  try {
    const receiptPath = join(runDir, 'integration.json');
    const startedPath = join(runDir, 'worker-started.json');
    const isolated = existsSync(startedPath) && JSON.parse(readFileSync(startedPath, 'utf8')).workspace;
    if (!isolated && !existsSync(receiptPath)) return envelope?.verification_subject_after ?? null;
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    const digest = createHash('sha256').update(readFileSync(join(runDir, 'runtime-envelope.json'))).digest('hex');
    if (receipt.status !== 'integrated' || receipt.run_id !== envelope?.run_id || receipt.task_id !== envelope?.task_id || receipt.worker_envelope_sha256 !== digest) return null;
    return receipt.main_subject_after ?? null;
  } catch { return null; }
}
