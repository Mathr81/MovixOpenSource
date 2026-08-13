import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const playerPath = new URL('../HLSPlayer.tsx', import.meta.url);

test('les handlers touchend des boutons Play ne basculent pas la lecture', async () => {
  const player = await readFile(playerPath, 'utf8');
  const duplicateTouchHandler = player.match(
    /onTouchEnd=[\s\S]{0,220}?togglePlay\(\);/,
  );

  assert.equal(
    duplicateTouchHandler,
    null,
    'togglePlay doit être appelé uniquement par onClick',
  );
});
