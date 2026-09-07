import { computeSubject, diffSubjects } from '../subject.mjs';

export function assessResume(gate, config) {
  const current = computeSubject();
  const diff = diffSubjects(gate?.verification_subject, current);
  const detail = diff.known
    ? `${diff.head_changed ? 'HEAD changed; ' : ''}${diff.changes.map((c) => `${c.kind} ${c.path}`).join('; ') || 'no file-level changes'}`
    : 'historical per-file hashes are unavailable';
  const protectedChange = diff.changes.some((c) => /^(\.loop\/|\.git|tools\/loop-runtime\/)/.test(c.path));
  const paths = config.efficiency?.recovery_paths ?? [];
  const approvedPaths = diff.known && !diff.head_changed && diff.changes.length > 0 && diff.changes.every((c) => paths.some((p) => c.path === p || (p.endsWith('/') && c.path.startsWith(p))));
  // Explicit resume acknowledges the current subject, but never suppresses a control-plane change.
  const allowed = current.available && !protectedChange && (approvedPaths || config.resumeRerunGates === true);
  return { allowed, detail, diff, protectedChange, subject_sha256: current.sha256 };
}
