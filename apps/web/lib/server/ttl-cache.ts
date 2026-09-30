/**
 * A small time-limited cache for answers that are the same for everyone for a few seconds.
 *
 * It exists to keep our Iris traffic proportional to the number of *questions* rather than the
 * number of *askers*: a receipt polling every five seconds, times everyone watching the same
 * burn, times a health check on every page load, is how a small product ends up rate limited.
 *
 * Per server instance, deliberately. Sharing it would need the same store the budget uses and buy
 * little — the budget is what actually bounds the total. Concurrent requests for the same key
 * share one in-flight call, so a burst of identical questions costs one.
 */
export function createTtlCache<T>(ttlMs: number, now: () => number = Date.now, maxEntries = 500) {
  const done = new Map<string, { at: number; value: T }>();
  const inflight = new Map<string, Promise<T>>();

  return async function get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = done.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;

    const pending = inflight.get(key);
    if (pending) return pending;

    const p = load()
      .then((value) => {
        if (done.size >= maxEntries) {
          // Oldest first; a Map iterates in insertion order.
          const oldest = done.keys().next().value;
          if (oldest !== undefined) done.delete(oldest);
        }
        done.delete(key);
        done.set(key, { at: now(), value });
        return value;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
}
