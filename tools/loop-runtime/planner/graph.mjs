// planner/graph — 제안 의존 그래프의 결정론적 검증과 위상 정렬.
//
// LLM에게 순환을 찾아 달라고 하지 않는다. 그래프 문제는 그래프로 푼다.
// 배열 순서는 의존 관계의 근거가 아니다 — 순서는 여기서 다시 계산한다.

/**
 * 제안 목록의 의존 그래프를 검증한다.
 * @param {{proposal_id: string, depends_on: string[]}[]} items
 * @returns {{ errors: string[], order: string[] }} order는 유효한 DAG일 때만 채워진다.
 */
export function validateProposalGraph(items) {
  const errors = [];
  const ids = items.map((t) => t.proposal_id);
  const known = new Set(ids);

  const edges = new Map();   // id -> 정규화된 선행 id 목록
  for (const t of items) {
    const deps = Array.isArray(t.depends_on) ? t.depends_on : [];
    const seen = new Set();
    const clean = [];
    deps.forEach((dep, i) => {
      if (typeof dep !== 'string' || dep.trim() === '') {
        errors.push(`${t.proposal_id}: depends_on[${i}] must be a non-empty proposal id`);
        return;
      }
      if (dep === t.proposal_id) {
        errors.push(`${t.proposal_id}: depends_on references itself`);
        return;
      }
      if (seen.has(dep)) {
        errors.push(`${t.proposal_id}: duplicate dependency "${dep}"`);
        return;
      }
      seen.add(dep);
      if (!known.has(dep)) {
        errors.push(`${t.proposal_id}: depends_on references unknown proposal "${dep}"`);
        return;
      }
      clean.push(dep);
    });
    edges.set(t.proposal_id, clean);
  }

  if (errors.length > 0) return { errors, order: [] };

  const { order, cyclic } = topoOrder(ids, edges);
  if (cyclic.length > 0) {
    errors.push(`dependency cycle detected among: ${cyclic.join(', ')}`);
    return { errors, order: [] };
  }
  return { errors, order };
}

/**
 * Kahn 위상 정렬. 동시에 준비된 노드가 여럿이면 **원래 제안 순서**로 tie-break 한다.
 * 그래야 같은 Plan이 항상 같은 순서로 보인다.
 * @returns {{ order: string[], cyclic: string[] }}
 */
export function topoOrder(ids, edges) {
  const rank = new Map(ids.map((id, i) => [id, i]));
  const indegree = new Map(ids.map((id) => [id, (edges.get(id) ?? []).length]));
  const dependents = new Map(ids.map((id) => [id, []]));
  for (const id of ids) {
    for (const dep of edges.get(id) ?? []) dependents.get(dep).push(id);
  }

  const ready = ids.filter((id) => indegree.get(id) === 0);
  const order = [];
  while (ready.length > 0) {
    ready.sort((a, b) => rank.get(a) - rank.get(b));
    const id = ready.shift();
    order.push(id);
    for (const next of dependents.get(id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) ready.push(next);
    }
  }
  const cyclic = ids.filter((id) => indegree.get(id) > 0);
  return { order, cyclic };
}
