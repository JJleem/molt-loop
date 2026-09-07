// Validated opt-in policies. Old project/task files retain their meaning.
export function efficiencyConfig(runtime = {}, policies = {}) {
  const bool = (key, fallback = false) => {
    const v = runtime[key] ?? fallback;
    if (typeof v !== 'boolean') throw new Error(`runtime.${key} must be boolean`);
    return v;
  };
  const count = (key, fallback) => {
    const v = runtime[key] ?? fallback;
    if (!Number.isInteger(v) || v < 1 || v > 8) throw new Error(`runtime.${key} must be an integer from 1 to 8`);
    return v;
  };
  const budget = policies.budget ?? {};
  const amount = (key) => {
    const v = budget[key] ?? null;
    if (v !== null && (!Number.isFinite(v) || v < 0)) throw new Error(`budget.${key} must be nonnegative or null`);
    return v;
  };
  const paths = runtime.recovery_paths ?? [];
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string' || !p || p.includes('..') || p.includes('\\') || p.startsWith('/') || p.includes(':') || /[*?]/.test(p) || p.startsWith('.loop') || p.startsWith('tools/loop-runtime') || p.startsWith('.git'))) {
    throw new Error('runtime.recovery_paths must contain explicit relative non-control paths (no globs)');
  }
  const unknown = budget.on_unknown_cost ?? 'stop';
  if (!['stop', 'continue'].includes(unknown)) throw new Error('budget.on_unknown_cost must be stop or continue');
  const isolated = bool('isolate_workers');
  const simpleModel = runtime.worker_simple_model ?? null;
  if (simpleModel !== null && (typeof simpleModel !== 'string' || !simpleModel.trim())) throw new Error('runtime.worker_simple_model must be a nonempty string or null');
  const workers = count('max_parallel_workers', 1);
  if (workers > 1 && !isolated) throw new Error('parallel workers require runtime.isolate_workers: true');
  return {
    task_resources: bool('task_resources', true),
    goal_verification: bool('goal_verification'),
    adaptive_recovery: bool('adaptive_recovery'),
    worker_simple_model: simpleModel,
    gate_only_completion: bool('gate_only_completion'),
    isolate_workers: isolated,
    max_parallel_workers: workers,
    max_parallel_gates: count('max_parallel_gates', 1),
    recovery_paths: paths,
    budget: { task_usd: amount('task_usd'), plan_usd: amount('plan_usd'), task_output_tokens: amount('task_output_tokens'), on_unknown_cost: unknown },
  };
}
