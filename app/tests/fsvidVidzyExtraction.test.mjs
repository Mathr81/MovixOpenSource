import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const implementations = [
  ['userscript', '../../userscript/movix.user.js'],
  ['chrome', '../../extension/Chrome/extractors.js'],
  ['firefox', '../../extension/Firefox/extractors.js'],
];

async function loadProductionHelper(relativePath) {
  const sourceUrl = new URL(relativePath, import.meta.url);
  const source = await readFile(sourceUrl, 'utf8');
  const sourceFile = ts.createSourceFile(
    sourceUrl.pathname,
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS,
  );
  let declaration;

  function visit(node) {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === 'extractM3u8UrlFromDecodedScript'
    ) {
      declaration = node;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  assert.ok(
    declaration,
    `${relativePath} doit exposer extractM3u8UrlFromDecodedScript`,
  );
  const functionSource = source.slice(
    declaration.getStart(sourceFile),
    declaration.end,
  );
  return vm.runInNewContext(`(${functionSource})`, {
    URL,
    Uint8Array,
    TextDecoder,
    atob,
  });
}

async function loadAllHelpers() {
  return Promise.all(
    implementations.map(async ([name, relativePath]) => [
      name,
      await loadProductionHelper(relativePath),
    ]),
  );
}

function xorPlayerScript(mediaUrl, key, { urlSafe = false } = {}) {
  const clear = Buffer.from(mediaUrl, 'utf8');
  const encrypted = Buffer.from(
    clear.map((value, index) => value ^ key[index % key.length]),
  );
  let payload = encrypted.toString('base64');
  if (urlSafe) {
    payload = payload
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
  }
  return {
    payload,
    script:
      `(function(s){var k=[${key.join(',')}],b=atob(s),r="";` +
      'for(var i=0;i<b.length;i++){r+=String.fromCharCode(' +
      'b.charCodeAt(i)^k[i%k.length])}return r})' +
      `("${payload}")`,
  };
}

test('decodes the new Fsvid/Vidzy Base64 XOR media URL in every implementation', async () => {
  const expected = 'https://u14.vidzy.cc/hls/movie/master.m3u8?token=test';
  const { script } = xorPlayerScript(expected, [17, 93, 201, 4]);

  for (const [name, extract] of await loadAllHelpers()) {
    assert.equal(
      extract(script, 'https://vidzy.org/embed-test.html'),
      expected,
      name,
    );
  }
});

test('accepts URL-safe Base64 and keeps the legacy absolute/relative fallbacks', async () => {
  const expected = 'https://s1.fsvid.lol/hls/movie/master.m3u8?token=test';
  const urlSafeKey = Array.from({ length: 255 }, (_, index) => index + 1)
    .find(key => /[+/]/.test(xorPlayerScript(expected, [key]).payload));
  assert.ok(urlSafeKey, 'le fixture doit produire des caractères Base64 URL-safe');
  const encoded = xorPlayerScript(expected, [urlSafeKey], { urlSafe: true });
  assert.match(encoded.payload, /[-_]/);

  for (const [name, extract] of await loadAllHelpers()) {
    assert.equal(
      extract(encoded.script, 'https://fsvid.lol/embed-test.html'),
      expected,
      `${name}: URL-safe XOR`,
    );
    assert.equal(
      extract(
        'player({file:"https://cdn.example/movie/master.m3u8?token=test"})',
        'https://vidzy.org/embed-test.html',
      ),
      'https://cdn.example/movie/master.m3u8?token=test',
      `${name}: legacy absolute`,
    );
    assert.equal(
      extract(
        'player({file:"/movie/master.m3u8?token=test"})',
        'https://vidzy.org/embed-test.html',
      ),
      'https://vidzy.org/movie/master.m3u8?token=test',
      `${name}: legacy relative`,
    );
  }
});

test('rejects malformed, unsafe, and false-positive media candidates', async () => {
  const validPayload = xorPlayerScript(
    'https://cdn.example/movie/master.m3u8',
    [1],
  ).payload;
  const invalidScripts = [
    'const template=",.urlset/master.m3u8";',
    'player({file:"http://cdn.example/movie/master.m3u8"})',
    '(function(s){var k=[1],b=atob(s),r=""})("%%%")',
    `(function(s){var k=[${Array(65).fill(1).join(',')}],b=atob(s),r=""})("${validPayload}")`,
    `(function(s){var k=[300],b=atob(s),r=""})("${validPayload}")`,
    xorPlayerScript('https://cdn.example/movie/video.mp4', [9]).script,
  ];

  for (const [name, extract] of await loadAllHelpers()) {
    for (const script of invalidScripts) {
      assert.equal(
        extract(script, 'https://vidzy.org/embed-test.html'),
        null,
        name,
      );
    }
  }
});

test('publishes updated userscript and extension versions', async () => {
  const userscript = await readFile(
    new URL('../../userscript/movix.user.js', import.meta.url),
    'utf8',
  );
  const chromeManifest = JSON.parse(
    await readFile(
      new URL('../../extension/Chrome/manifest.json', import.meta.url),
      'utf8',
    ),
  );
  const firefoxManifest = JSON.parse(
    await readFile(
      new URL('../../extension/Firefox/manifest.json', import.meta.url),
      'utf8',
    ),
  );

  assert.match(userscript, /^\/\/ @version\s+1\.4\.11$/m);
  assert.match(userscript, /version:\s*"1\.4\.11"/);
  assert.equal(chromeManifest.version, '1.3.12');
  assert.equal(firefoxManifest.version, '1.5.9');
});
