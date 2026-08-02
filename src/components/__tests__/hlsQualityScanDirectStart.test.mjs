import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const playerPath = new URL('../HLSPlayer.tsx', import.meta.url);
const panelPath = new URL('../HLSPlayerSettingsPanel.tsx', import.meta.url);

test('les deux boutons lancent directement la vérification de qualité HLS', async () => {
  const [player, panel] = await Promise.all([
    readFile(playerPath, 'utf8'),
    readFile(panelPath, 'utf8'),
  ]);
  const source = `${player}\n${panel}`;

  assert.equal((source.match(/onClick=\{runHlsQualityScan\}/g) ?? []).length, 2);
  assert.doesNotMatch(source, /status === 'confirm'/);
  assert.doesNotMatch(source, /status: 'idle' \| 'confirm' \| 'running'/);
});
