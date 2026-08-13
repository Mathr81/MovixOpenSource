export const PLAYER_CONTROL_INTERACTION_SELECTOR = [
  '[data-player-controls]',
  '.control-bar',
  '.settings-menu',
  '.volume-slider',
  '.progress-bar',
  'button',
  'a',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '[role="slider"]',
].join(',');

export function isPlayerControlInteractionTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const closest = (target as { closest?: unknown }).closest;
  if (typeof closest !== 'function') return false;
  return Boolean(
    closest.call(target, PLAYER_CONTROL_INTERACTION_SELECTOR),
  );
}
