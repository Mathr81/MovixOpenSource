const test = require('node:test');
const assert = require('node:assert/strict');
const { formatPlan, runDatabaseInitialization } = require('../initDatabase');

function operation(id, wrapped = false) {
  return {
    id,
    kind: 'add_index',
    table: wrapped ? 'wrapped_viewing_data' : 'comments',
    objectName: id,
    wrapped,
    sql: `ALTER TABLE x ADD INDEX ${id} (id)`,
  };
}

function harness({ tableCount = 1, answers = [], operations = [operation('normal')], dryRun = false, interactive = true, failAt = null } = {}) {
  const writes = [];
  const prompts = [];
  let answerIndex = 0;
  const metadata = { tableCount, tables: new Map() };
  const plan = { operations, drift: [] };
  return {
    writes,
    prompts,
    run: () => runDatabaseInitialization({
      inspect: async () => metadata,
      plan: () => plan,
      withLock: async (task) => task(),
      execute: async (sql) => {
        if (failAt && sql.includes(failAt)) throw new Error('ddl failed');
        writes.push(sql);
      },
      confirm: async (question) => { prompts.push(question); return answers[answerIndex++]; },
      logger: { log() {}, error() {} },
      dryRun,
      interactive,
    }),
  };
}

test('N at the general prompt cancels before writes', async () => {
  const h = harness({ answers: ['N'] });
  const result = await h.run();
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(h.writes, []);
});

test('O accepts a non-empty database plan', async () => {
  const h = harness({ answers: ['o'] });
  const result = await h.run();
  assert.equal(result.status, 'applied');
  assert.equal(h.writes.length, 1);
});

test('N at the Wrapped prompt skips only Wrapped operations', async () => {
  const h = harness({ answers: ['O', 'N'], operations: [operation('normal'), operation('wrapped', true)] });
  const result = await h.run();
  assert.equal(result.status, 'applied');
  assert.equal(h.writes.length, 1);
  assert.equal(result.skipped.length, 1);
});

test('dry-run never prompts, locks, or writes', async () => {
  const h = harness({ dryRun: true, interactive: false });
  const result = await h.run();
  assert.equal(result.status, 'dry-run');
  assert.deepEqual(h.prompts, []);
  assert.deepEqual(h.writes, []);
});

test('write mode refuses a non-interactive terminal', async () => {
  const h = harness({ interactive: false });
  await assert.rejects(h.run(), /terminal interactif/i);
  assert.deepEqual(h.writes, []);
});

test('DDL error reports applied and remaining operations', async () => {
  const h = harness({ answers: ['O'], operations: [operation('first'), operation('second')], failAt: 'second' });
  const result = await h.run();
  assert.equal(result.status, 'failed');
  assert.equal(result.applied.length, 1);
  assert.equal(result.remaining.length, 1);
});

test('DDL errors redact secrets from logs and caller results', async () => {
  const secret = 'mysql://movix:fake-secret@db.example/movix';
  const errors = [];
  const result = await runDatabaseInitialization({
    inspect: async () => ({ tableCount: 0, tables: new Map() }),
    plan: () => ({ operations: [operation('first'), operation('second')], drift: [] }),
    withLock: async (task) => task(),
    execute: async (sql) => {
      if (sql.includes('second')) throw new Error(`connection failed: ${secret}`);
    },
    confirm: async () => 'O',
    logger: { log() {}, error: (message) => errors.push(message) },
    dryRun: false,
    interactive: true,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.applied.length, 1);
  assert.equal(result.remaining.length, 1);
  assert.match(errors[0], /Echec DDL pour second/);
  assert.doesNotMatch(errors.join('\n'), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test('blocking drift stops before prompts, lock, and writes', async () => {
  let prompted = false;
  let locked = false;
  let wrote = false;
  const result = await runDatabaseInitialization({
    inspect: async () => ({ tableCount: 1, tables: new Map() }),
    plan: () => ({ operations: [], drift: [{ table: 'films', objectType: 'column', objectName: 'id' }] }),
    withLock: async () => { locked = true; },
    execute: async () => { wrote = true; },
    confirm: async () => { prompted = true; return 'O'; },
    logger: { log() {}, error() {} },
    dryRun: false,
    interactive: true,
  });
  assert.equal(result.status, 'drift');
  assert.equal(prompted, false);
  assert.equal(locked, false);
  assert.equal(wrote, false);
});

test('changed plan under the advisory lock stops before writes', async () => {
  let planCall = 0;
  const writes = [];
  const result = await runDatabaseInitialization({
    inspect: async () => ({ tableCount: 0, tables: new Map() }),
    plan: () => ({ operations: [operation(planCall++ === 0 ? 'before' : 'after')], drift: [] }),
    withLock: async (task) => task(),
    execute: async (sql) => { writes.push(sql); },
    confirm: async () => 'O',
    logger: { log() {}, error() {} },
    dryRun: false,
    interactive: true,
  });
  assert.equal(result.status, 'changed');
  assert.deepEqual(writes, []);
});

test('drift diagnostics include safe expected and actual definitions', () => {
  const output = formatPlan({
    operations: [],
    drift: [{
      table: 'likes', objectType: 'column', objectName: 'user_id',
      expected: { characterSet: 'ascii', collation: 'ascii_bin' },
      actual: { characterSet: 'utf8mb4', collation: 'utf8mb4_unicode_ci' },
    }],
  });

  assert.match(output, /expected=.*ascii/);
  assert.match(output, /actual=.*utf8mb4/);
});

test('Wrapped warning describes operational risks and affected safe IDs before the exact prompt', async () => {
  const events = [];
  const wrapped = [operation('wrapped-one', true), operation('wrapped-two', true)];
  const result = await runDatabaseInitialization({
    inspect: async () => ({ tableCount: 0, tables: new Map() }),
    plan: () => ({ operations: wrapped, drift: [] }),
    withLock: async (task) => task({ execute: async () => {} }),
    execute: async () => {},
    confirm: async (question) => { events.push(`PROMPT:${question}`); return 'N'; },
    logger: { log: (message) => events.push(`LOG:${message}`), error() {} },
    dryRun: false,
    interactive: true,
  });

  assert.equal(result.status, 'applied');
  const warningIndex = events.findIndex((event) => /verrou|lock/i.test(event) && /disque/i.test(event));
  const promptIndex = events.indexOf('PROMPT:Modifier les tables Wrapped ? (O/N)');
  assert.ok(warningIndex >= 0 && warningIndex < promptIndex);
  assert.match(events[warningIndex], /charge/i);
  assert.match(events[warningIndex], /dur[ée]e/i);
  assert.match(events[warningIndex], /wrapped-one/);
  assert.match(events[warningIndex], /wrapped-two/);
  assert.match(events[warningIndex], /2 operation/i);
});

test('locked drift and changed plans log safe reasons with rerun guidance', async () => {
  const lockedDriftLogs = [];
  let inspection = 0;
  const driftResult = await runDatabaseInitialization({
    inspect: async () => ({ tableCount: inspection++, tables: new Map() }),
    plan: (metadata) => metadata.tableCount === 0
      ? { operations: [], drift: [] }
      : { operations: [], drift: [{ table: 'films', objectType: 'table', objectName: 'films', expected: 'innodb', actual: 'myisam' }] },
    withLock: async (task) => task({}),
    execute: async () => {},
    confirm: async () => 'O',
    logger: { log: (message) => lockedDriftLogs.push(message), error() {} },
    dryRun: false,
    interactive: true,
  });
  assert.equal(driftResult.status, 'drift');
  assert.match(lockedDriftLogs.join('\n'), /sous verrou/i);
  assert.match(lockedDriftLogs.join('\n'), /films/);

  const changedLogs = [];
  let planCall = 0;
  const changedResult = await runDatabaseInitialization({
    inspect: async () => ({ tableCount: 0, tables: new Map() }),
    plan: () => ({ operations: [operation(planCall++ === 0 ? 'before' : 'after')], drift: [] }),
    withLock: async (task) => task({}),
    execute: async () => {},
    confirm: async () => 'O',
    logger: { log: (message) => changedLogs.push(message), error() {} },
    dryRun: false,
    interactive: true,
  });
  assert.equal(changedResult.status, 'changed');
  assert.match(changedLogs.join('\n'), /plan.*chang|modifi/i);
  assert.match(changedLogs.join('\n'), /relanc/i);
  assert.match(changedLogs.join('\n'), /before/);
  assert.match(changedLogs.join('\n'), /after/);
});

test('DDL failure logs applied, failed, and remaining safe operation IDs', async () => {
  const errors = [];
  const operations = [operation('first'), operation('second'), operation('third')];
  const result = await runDatabaseInitialization({
    inspect: async () => ({ tableCount: 0, tables: new Map() }),
    plan: () => ({ operations, drift: [] }),
    withLock: async (task) => task({}),
    execute: async (sql) => { if (sql.includes('second')) throw new Error('secret'); },
    confirm: async () => 'O',
    logger: { log() {}, error: (message) => errors.push(message) },
    dryRun: false,
    interactive: true,
  });

  assert.equal(result.status, 'failed');
  assert.match(errors.join('\n'), /applied=\[first\]/);
  assert.match(errors.join('\n'), /failed=second/);
  assert.match(errors.join('\n'), /remaining=\[second, third\]/);
  assert.doesNotMatch(errors.join('\n'), /secret/);
});
