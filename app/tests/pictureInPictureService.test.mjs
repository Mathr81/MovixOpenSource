import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

async function loadService() {
  const source = await readFile(
    new URL('../src/services/pictureInPicture.ts', import.meta.url),
    'utf8',
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  const require = id => {
    if (id !== 'react-native') throw new Error(`Unexpected dependency: ${id}`);
    return {
      NativeEventEmitter: class {},
      NativeModules: {},
    };
  };
  vm.runInNewContext(`(function(require,module,exports){${output}\n})`, {})(
    require,
    module,
    module.exports,
  );
  return module.exports;
}

test('parses only the three supported PiP action values', async () => {
  const { parsePictureInPictureEvent } = await loadService();
  for (const action of ['seek-backward', 'toggle-playback', 'seek-forward']) {
    assert.equal(JSON.stringify(parsePictureInPictureEvent({
      kind: 'action',
      action,
    })), JSON.stringify({ kind: 'action', action }));
  }
  assert.equal(parsePictureInPictureEvent({
    kind: 'action',
    action: 'delete-everything',
  }), null);
});
