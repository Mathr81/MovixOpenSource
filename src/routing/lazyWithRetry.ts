/**
 * Wraps a dynamic-import loader to recover from chunk-load failures
 * after a deploy (CDN evicted an old chunk before the client refreshed).
 *
 * Strategy: if a known chunk-load error is caught, force a full page
 * reload — but only once per cooldown (60s) to prevent infinite loops.
 *
 * Also tracks in-flight interactive chunk loads (i.e., loads not initiated
 * by background prefetch). When the count transitions 0 → 1 a
 * `chunk:load:start` event is dispatched on `window`; when it returns to 0
 * a `chunk:load:end` event fires. Silent loads (prefetch) are not counted.
 * Used by `<TopProgressBar />` for the global loading indicator.
 *
 * Used by every entry in the route registry:
 *   loader: () => lazyWithRetry(() => import('../pages/MyPage'))
 */

const RELOAD_KEY = '__movix_chunk_reload_at';
const RELOAD_COOLDOWN_MS = 60_000;

const isChunkLoadError = (err: unknown): boolean => {
  const msg = String((err as Error)?.message || err || '');
  return /Failed to fetch dynamically imported module|Importing a module script failed|ChunkLoadError|error loading dynamically imported module|Unable to preload CSS for/i.test(msg);
};

let activeLoads = 0;

export const getActiveChunkLoads = (): number => activeLoads;

export const lazyWithRetry = <T>(
  loader: () => Promise<T>,
  opts?: { silent?: boolean }
): Promise<T> => {
  const silent = opts?.silent === true;
  if (!silent) {
    if (activeLoads === 0) {
      window.dispatchEvent(new Event('chunk:load:start'));
    }
    activeLoads++;
  }
  return loader()
    .catch((err) => {
      if (!isChunkLoadError(err)) throw err;

      let last = 0;
      try {
        last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
      } catch {
        // sessionStorage may throw in private/SSR contexts — fall through to throw
      }
      if (Date.now() - last < RELOAD_COOLDOWN_MS) {
        throw err; // cooldown not elapsed → bubble to ErrorBoundary
      }
      try {
        sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
      } catch {
        // sessionStorage may throw — proceed with reload anyway
      }
      // Manually settle the counter before reload — the never-resolving
      // promise below means `.finally()` would otherwise never run.
      if (!silent) {
        activeLoads--;
        if (activeLoads === 0) {
          window.dispatchEvent(new Event('chunk:load:end'));
        }
      }
      window.location.reload();
      return new Promise<T>(() => {}); // never resolves; page is reloading
    })
    .finally(() => {
      if (!silent) {
        activeLoads--;
        if (activeLoads === 0) {
          window.dispatchEvent(new Event('chunk:load:end'));
        }
      }
    });
};
