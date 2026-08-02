const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('OAuth runtime storage delegates every OAuth table to the manifest group', async () => {
  process.env.DOTENV_CONFIG_QUIET = 'true';
  const { ensureOAuthStorage } = require('../../utils/oauthStorage');
  const { getTablesByGroup, renderCreateTable } = require('../schema');
  const executed = [];
  const pool = { execute: async (sql) => { executed.push(sql); } };

  await ensureOAuthStorage(pool);

  assert.deepEqual(executed, getTablesByGroup('oauth').map(renderCreateTable));
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'utils', 'oauthStorage.js'), 'utf8');
  assert.doesNotMatch(source, /CREATE\s+TABLE/i);
});
