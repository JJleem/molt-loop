/** Bounded pool, preserves input order. Wait for all started work even after a failure. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const errors = [];
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length && errors.length === 0) {
      const i = cursor++;
      try { results[i] = await fn(items[i], i); } catch (e) { errors.push(e); }
    }
  }));
  if (errors.length) throw new AggregateError(errors, 'parallel operation failed');
  return results;
}
