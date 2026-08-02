const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  createInitializer,
  parseArguments,
  reportInitializationFailure,
  validateConfig,
} = require('../../scripts/init-db');
process.env.DOTENV_CONFIG_QUIET = 'true';
const { withMysqlAdvisoryLock } = require('../../mysqlPool');

test('requiring the CLI is silent and does not load production database dependencies', () => {
  const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'init-db.js');
  const source = `
    const Module = require('node:module');
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === 'mysql2/promise' || request === 'dotenv' || /mysqlPool$/.test(request)) {
        throw new Error('forbidden import: ' + request);
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    require(${JSON.stringify(scriptPath)});
  `;
  const child = spawnSync(process.execPath, ['-e', source], {
    cwd: path.join(__dirname, '..', '..'),
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });

  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, '');
});

test('one-connection initialization reinspects and applies DDL on the advisory-lock connection', async () => {
  let checkedOut = false;
  let ended = false;
  const ddl = [];
  const connection = {
    query: async (sql) => {
      if (sql.startsWith('SELECT GET_LOCK')) return [[{ acquired: 1 }]];
      if (sql.startsWith('SELECT RELEASE_LOCK')) return [[{ released: 1 }]];
      throw new Error(`unexpected lock query: ${sql}`);
    },
    execute: async (sql) => { ddl.push(sql); return [[], []]; },
    release: () => { checkedOut = false; },
  };
  const pool = {
    getConnection: async () => {
      assert.equal(checkedOut, false, 'a second connection checkout would deadlock');
      checkedOut = true;
      return connection;
    },
    execute: async () => {
      assert.equal(checkedOut, false, 'pool.execute cannot run while the sole connection owns the lock');
      return [[], []];
    },
    end: async () => { ended = true; },
  };
  const main = createInitializer({
    argv: [],
    config: { host: 'db', user: 'movix', password: 'secret', database: 'movix' },
    createPool: () => pool,
    createPrompt: () => ({ close() {}, question: async () => 'O' }),
    input: { isTTY: true },
    output: { isTTY: true },
    loadMetadata: async (queryable) => {
      assert.ok(queryable === pool || queryable === connection);
      if (checkedOut) assert.equal(queryable, connection);
      return { tableCount: 0, tables: new Map() };
    },
    createPlan: () => ({
      operations: [{
        id: 'create_table:sample:sample', kind: 'create_table', table: 'sample',
        objectName: 'sample', wrapped: false, sql: 'CREATE TABLE IF NOT EXISTS `sample` (`id` INT)',
      }],
      drift: [],
    }),
    schemaManifest: [],
    runInitialization: require('../initDatabase').runDatabaseInitialization,
    withAdvisoryLock: withMysqlAdvisoryLock,
    lockName: 'mainapi:schema-bootstrap:v1',
    logger: { log() {}, error() {} },
  });

  await main();

  assert.deepEqual(ddl, ['CREATE TABLE IF NOT EXISTS `sample` (`id` INT)']);
  assert.equal(ended, true);
});

test('CLI accepts only --dry-run', () => {
  assert.deepEqual(parseArguments([]), { dryRun: false });
  assert.deepEqual(parseArguments(['--dry-run']), { dryRun: true });
  assert.throws(() => parseArguments(['--yes']), /Option inconnue/);
});

test('CLI validates required MySQL environment fields before creating a pool', () => {
  assert.throws(
    () => validateConfig({ host: 'db', user: 'movix', password: '', database: 'movix' }),
    /password/,
  );
  assert.doesNotThrow(() => validateConfig({
    host: 'db', user: 'movix', password: 'secret', database: 'movix',
  }));
});

test('CLI failure output never exposes a database URI or password', () => {
  const output = [];
  const logger = { error: (message) => output.push(message) };
  const secret = 'mysql://movix:secret-password@example.test/movix';

  reportInitializationFailure(logger, new Error(secret));

  assert.deepEqual(output, ['Initialisation impossible.']);
  assert.doesNotMatch(output.join('\n'), /secret-password|example\.test|mysql:/);
});

test('CLI closes its pool when readline creation fails', async () => {
  let ended = false;
  const secret = 'mysql://movix:secret-password@example.test/movix';
  const main = createInitializer({
    argv: [],
    config: { host: 'db', user: 'movix', password: 'secret-password', database: 'movix' },
    createPool: () => ({ end: async () => { ended = true; } }),
    createPrompt: () => { throw new Error(secret); },
  });

  await assert.rejects(main(), new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(ended, true);
});

test('advisory lock cleanup does not expose a raw database error', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  const secret = 'mysql://movix:secret-password@example.test/movix';
  console.warn = (...args) => warnings.push(args.join(' '));

  try {
    await withMysqlAdvisoryLock({
      getConnection: async () => ({
        query: async (sql) => {
          if (sql.startsWith('SELECT GET_LOCK')) return [[{ acquired: 1 }]];
          throw new Error(secret);
        },
        release: () => {},
      }),
    }, 'mainapi:schema-bootstrap:v1', async () => {});
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings.join('\n'), /secret-password|example\.test|mysql:/);
});
