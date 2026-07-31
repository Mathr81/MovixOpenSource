/**
 * Wraps a dynamic-import loader to recover from chunk-load failures
 * after a deploy (the production domain serves only the latest deployment's
 * hashed assets, so a client still running the previous `index.html` requests
 * chunks that now 404 — or hits a brand-new chunk that hasn't propagated to the
 * edge node yet).
 *
 * Recovery strategy (in order):
 *   1. Retry the import a few times with exponential backoff. Most post-deploy
 *      404s are CDN-propagation lag measured in seconds — a couple of retries
 *      on the *current* page resolve them without a disruptive reload.
 *   2. If retries are exhausted, force ONE full page reload to pull a fresh
 *      `index.html` (and therefore fresh chunk hashes). Guarded by a budget
 *      (max reloads per window) + minimum spacing so a genuinely broken /
 *      offline client can never reload-loop.
 *   3. If the reload budget is spent, the error bubbles to <ErrorBoundary>,
 *      which shows a soft "new version available" screen instead of crashing.
 *
 * Background prefetch loads (`{ silent: true }`) NEVER reload or surface a
 * crash — a hover-prefetch on a stale chunk must not yank the page out from
 * under the user. They retry quietly and, on failure, reject so the caller's
 * `.catch` can swallow them.
 *
 * On the FIRST successful chunk load the reload budget is cleared, so a future
 * deploy gets a fresh set of recovery attempts.
 *
 * Also tracks in-flight interactive chunk loads. When the count transitions
 * 0 → 1 a `chunk:load:start` event is dispatched on `window`; when it returns
 * to 0 a `chunk:load:end` event fires. Silent loads (prefetch) are not counted.
 * Used by `<TopProgressBar />` for the global loading indicator.
 *
 * Used by every entry in the route registry:
 *   loader: () => lazyWithRetry(() => import('../pages/MyPage'))
 */

const RELOAD_KEY = '__movix_chunk_reload';
const RELOAD_WINDOW_MS = 120_000; // counter resets after 2 min of no failures
const MAX_RELOADS = 3; // hard cap within the window — loop guard
const MIN_RELOAD_SPACING_MS = 3_000; // never reload twice in quick succession

const MAX_IMPORT_RETRIES = 2; // in-place retries before falling back to reload
const RETRY_BASE_DELAY_MS = 350; // 350ms, then 700ms

export const isChunkLoadError = (err: unknown): boolean => {
  const msg = String((err as Error)?.message || err || '');
  const name = String((err as { name?: string })?.name || '');
  return (
    name === 'ChunkLoadError' ||
    /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload (?:CSS|module)|Importing binding name .* is not found|is not a valid JavaScript MIME type|expected expression, got '<'|'text\/html' is not a valid/i.test(
      msg
    )
  );
};

type ReloadState = { n: number; at: number };

const readReloadState = (): ReloadState => {
  try {
    const raw = sessionStorage.getItem(RELOAD_KEY);
    if (!raw) return { n: 0, at: 0 };
    const parsed = JSON.parse(raw) as ReloadState;
    if (typeof parsed?.n !== 'number' || typeof parsed?.at !== 'number') {
      return { n: 0, at: 0 };
    }
    // Window elapsed since the last failure → start fresh.
    if (Date.now() - parsed.at > RELOAD_WINDOW_MS) return { n: 0, at: 0 };
    return parsed;
  } catch {
    return { n: 0, at: 0 };
  }
};

/** Clears the reload budget. Called after any successful chunk load. */
export const clearChunkReloadHistory = (): void => {
  try {
    sessionStorage.removeItem(RELOAD_KEY);
  } catch {
    // sessionStorage may throw in private/locked-down contexts — ignore
  }
};

/**
 * Schedules a guarded full-page reload to recover from a chunk-load failure.
 * Returns `true` if a reload was scheduled, `false` if the budget is spent
 * (caller should then surface the error to the ErrorBoundary).
 *
 * Shared by `lazyWithRetry` (interactive route loads) and the global
 * `vite:preloadError` handler in `main.tsx`.
 */
export const reloadForChunkFailure = (): boolean => {
  const state = readReloadState();
  if (state.n >= MAX_RELOADS) return false;

  const now = Date.now();
  const wait = Math.max(0, MIN_RELOAD_SPACING_MS - (now - state.at));
  try {
    sessionStorage.setItem(RELOAD_KEY, JSON.stringify({ n: state.n + 1, at: now + wait }));
  } catch {
    // If we can't persist the counter we still reload once, but the loop
    // guard is weakened — acceptable vs. leaving the user on a broken page.
  }
  window.setTimeout(() => window.location.reload(), wait);
  return true;
};

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * Synthesises a chunk-load error for a *silently* failed import — one that
 * resolved to a nullish module instead of rejecting. Vite's preload helper does
 * this when a `vite:preloadError` event is preventDefault()-ed (see main.tsx).
 * `name = 'ChunkLoadError'` makes `isChunkLoadError` match it, so it flows
 * through the same retry + guarded-reload recovery as a normal rejection
 * instead of reaching React.lazy as `undefined` (→ "Cannot read properties of
 * undefined (reading 'default')").
 */
const nullishModuleError = (): Error => {
  const e = new Error('Dynamic import resolved to a nullish module (stale or failed chunk)');
  e.name = 'ChunkLoadError';
  return e;
};

const importWithRetry = async <T>(loader: () => Promise<T>, attempt = 0): Promise<T> => {
  let mod: T;
  try {
    mod = await loader();
  } catch (err) {
    if (!isChunkLoadError(err) || attempt >= MAX_IMPORT_RETRIES) throw err;
    await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
    return importWithRetry(loader, attempt + 1);
  }
  // A valid `import()` always resolves to a module namespace object; a nullish
  // result means the load silently failed (see nullishModuleError). Retry, then
  // surface it as a chunk failure so the reload path below recovers it.
  if (mod == null) {
    if (attempt >= MAX_IMPORT_RETRIES) throw nullishModuleError();
    await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
    return importWithRetry(loader, attempt + 1);
  }
  return mod;
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

  let settled = false;
  const settle = () => {
    if (silent || settled) return;
    settled = true;
    activeLoads = Math.max(0, activeLoads - 1);
    if (activeLoads === 0) {
      window.dispatchEvent(new Event('chunk:load:end'));
    }
  };

  return importWithRetry(loader)
    .then((mod) => {
      // A chunk resolved → the client is on a consistent build again. Reset the
      // budget so a future deploy gets a fresh set of recovery attempts.
      clearChunkReloadHistory();
      settle();
      return mod;
    })
    .catch((err) => {
      settle();
      if (!isChunkLoadError(err)) throw err;

      // Background prefetch: never reload or crash. Reject quietly so the
      // caller's `.catch` swallows it (PrefetchLink drops it from its set).
      if (silent) throw err;

      // Interactive load still failing after retries → try a guarded reload.
      if (reloadForChunkFailure()) {
        return new Promise<T>(() => {}); // never resolves; page is reloading
      }
      // Reload budget spent → bubble to <ErrorBoundary> (soft recovery screen).
      throw err;
    });
};
