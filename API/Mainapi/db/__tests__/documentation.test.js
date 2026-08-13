const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainapiReadme = fs.readFileSync(path.join(__dirname, '../../README.md'), 'utf8');
const apiReadme = fs.readFileSync(path.join(__dirname, '../../../README.md'), 'utf8');
const rootReadme = fs.readFileSync(path.join(__dirname, '../../../../README.md'), 'utf8');

test('MainAPI README documents both guarded and dry-run commands', () => {
  assert.match(mainapiReadme, /npm run db:init/);
  assert.match(mainapiReadme, /npm run db:init -- --dry-run/);
  assert.match(mainapiReadme, /Continuer \? \(O\/N\)/);
  assert.match(mainapiReadme, /Modifier les tables Wrapped \? \(O\/N\)/);
  assert.match(mainapiReadme, /aucune suppression/i);
});

test('root and API setup guides include the MainAPI initialization step', () => {
  assert.match(apiReadme, /npm run db:init/);
  assert.match(rootReadme, /npm run db:init/);
});

test('API setup configures MainAPI before initializing it and returns to the root directory', () => {
  const envIndex = apiReadme.indexOf('cp API/Mainapi/.env.example API/Mainapi/.env');
  const initIndex = apiReadme.indexOf('npm run db:init');

  assert.notEqual(envIndex, -1);
  assert.notEqual(initIndex, -1);
  assert.ok(envIndex < initIndex);
  assert.match(
    apiReadme,
    /cd API\/Mainapi\s+npm install\s+npm run db:init\s+cd \.\.\/\.\./,
  );
});

test('MainAPI README documents the MySQL floor and complete operator diagnostics', () => {
  assert.match(mainapiReadme, /MySQL\s+8\.0\.13/i);
  assert.match(mainapiReadme, /expected.*actual|attendu.*observ[ée]/is);
  assert.match(mainapiReadme, /relanc/i);
  assert.match(mainapiReadme, /verrou/i);
  assert.match(mainapiReadme, /charge/i);
  assert.match(mainapiReadme, /dur[ée]e/i);
  assert.match(mainapiReadme, /disque/i);
});
