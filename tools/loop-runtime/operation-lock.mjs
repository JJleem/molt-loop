// Atomic, repository-wide mutation lock. Self-check and read-only commands remain available.
import { openSync, closeSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_DIR } from './task-store.mjs';

export function acquireOperationLock(command) {
  mkdirSync(LOCAL_DIR, { recursive: true });
  const path = join(LOCAL_DIR, 'operation.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, command, started_at: new Date().toISOString() }));
      closeSync(fd);
      return () => { try { if (JSON.parse(readFileSync(path, 'utf8')).pid === process.pid) unlinkSync(path); } catch { /* Preserve an unrecognized owner. */ } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner;
      try { owner = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error(`operation lock is unreadable: ${path}`); }
      if (!Number.isInteger(owner.pid) || owner.pid < 1) throw new Error(`operation lock has invalid owner: ${path}`);
      let alive = true;
      try { process.kill(owner.pid, 0); } catch (err) { alive = err.code !== 'ESRCH'; }
      if (alive) throw new Error(`another runtime operation is active: ${owner.command} (pid ${owner.pid})`);
      // Only recover a demonstrably dead owner. Re-read before removing its lock.
      if (JSON.parse(readFileSync(path, 'utf8')).pid === owner.pid) unlinkSync(path);
    }
  }
  throw new Error('could not acquire operation lock');
}
