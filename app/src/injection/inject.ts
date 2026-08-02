import { buildBridgeRuntime } from './bridge-runtime';
import { buildCastShim } from './cast-shim';
import { buildPictureInPictureShim } from './picture-in-picture-shim';
import { buildPlaybackAwakeShim } from './playback-awake-shim';
import { USERSCRIPT_SOURCE } from './userscript-source';

export function buildInjectedJavaScript(
  options: { pictureInPictureEnabled?: boolean } = {},
): string {
  const castShim = buildCastShim();
  const pipShim = buildPictureInPictureShim(options.pictureInPictureEnabled === true);
  const playbackAwakeShim = buildPlaybackAwakeShim();
  const bridge = buildBridgeRuntime();

  // Cast shim FIRST — must be on window before any page JS runs.
  return `
${castShim}

${pipShim}

${playbackAwakeShim}

${bridge}

// --- Userscript Movix ---
${USERSCRIPT_SOURCE}

true;
`;
}
