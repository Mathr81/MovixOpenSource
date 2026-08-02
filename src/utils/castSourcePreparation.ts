export interface CastSourcePreparationOptions {
  fallbackUrl: string;
  prepare: () => Promise<string>;
  timeoutMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export async function prepareCastSourceWithFallback({
  fallbackUrl,
  prepare,
  timeoutMs = 1_500,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: CastSourcePreparationOptions): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const prepared = Promise.resolve()
    .then(prepare)
    .then(value => value.trim() || fallbackUrl)
    .catch(() => fallbackUrl);
  const deadline = new Promise<string>(resolve => {
    timer = setTimer(() => resolve(fallbackUrl), timeoutMs);
  });
  try {
    return await Promise.race([prepared, deadline]);
  } finally {
    if (timer !== undefined) clearTimer(timer);
  }
}
