const test = require('node:test');
const assert = require('node:assert/strict');
const { planSchema } = require('../schemaPlanner');

const table = {
  name: 'sample', group: 'test', wrapped: false,
  columns: [
    { name: 'id', definition: 'INT NOT NULL', expected: { columnType: 'int', nullable: false, defaultValue: null, extra: '' } },
    { name: 'name', definition: 'VARCHAR(50) DEFAULT NULL', expected: { columnType: 'varchar(50)', nullable: true, defaultValue: null, extra: '' } },
  ],
  primaryKey: ['id'],
  indexes: [{ name: 'idx_sample_name', unique: false, columns: ['name'] }],
  foreignKeys: [], options: 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
};

function metadata(tables = []) {
  return { tableCount: tables.length, tables: new Map(tables.map((item) => [item.name, item])) };
}

test('plans one CREATE TABLE for a missing table', () => {
  const plan = planSchema([table], metadata());
  assert.deepEqual(plan.drift, []);
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].kind, 'create_table');
});

test('plans only a missing column and index on an existing table', () => {
  const plan = planSchema([table], metadata([{
    name: 'sample',
    columns: new Map([['id', { columnType: 'int', nullable: false, defaultValue: null, extra: '' }]]),
    indexes: new Map([['PRIMARY', { unique: true, columns: ['id'] }]]),
    foreignKeys: new Map(),
  }]));
  assert.deepEqual(plan.operations.map((operation) => operation.kind), ['add_column', 'add_index']);
});

test('returns no operation for a conforming table', () => {
  const plan = planSchema([table], metadata([{
    name: 'sample',
    columns: new Map([
      ['id', { columnType: 'int', nullable: false, defaultValue: null, extra: '' }],
      ['name', { columnType: 'varchar(50)', nullable: true, defaultValue: null, extra: '' }],
    ]),
    indexes: new Map([
      ['PRIMARY', { unique: true, columns: ['id'] }],
      ['idx_sample_name', { unique: false, columns: ['name'] }],
    ]),
    foreignKeys: new Map(),
  }]));
  assert.deepEqual(plan, { operations: [], drift: [] });
});

test('blocks a different existing definition instead of changing it', () => {
  const plan = planSchema([table], metadata([{
    name: 'sample',
    columns: new Map([
      ['id', { columnType: 'bigint', nullable: false, defaultValue: null, extra: '' }],
      ['name', { columnType: 'varchar(50)', nullable: true, defaultValue: null, extra: '' }],
    ]),
    indexes: new Map([['PRIMARY', { unique: true, columns: ['id'] }]]),
    foreignKeys: new Map(),
  }]));
  assert.equal(plan.drift[0].objectName, 'id');
  assert.doesNotMatch(plan.operations.map((item) => item.sql).join('\n'), /MODIFY|CHANGE|DROP/i);
});

const enumTable = {
  ...table,
  columns: [{
    name: 'user_type',
    definition: "ENUM('oauth', 'bip39') NOT NULL",
    expected: { columnType: 'enum', nullable: false, defaultValue: null, extra: '' },
  }],
  primaryKey: ['user_type'],
  indexes: [],
};

test('compares full ENUM definitions and treats identifier lookups case-insensitively', () => {
  const plan = planSchema([enumTable], {
    tableCount: 1,
    tables: new Map([['SAMPLE', {
      name: 'SAMPLE',
      columns: new Map([['USER_TYPE', { columnType: "enum('oauth','bip39')", nullable: false, defaultValue: null, extra: '' }]]),
      indexes: new Map([['primary', { unique: true, columns: ['USER_TYPE'] }]]),
      foreignKeys: new Map(),
    }]]),
  });
  assert.deepEqual(plan, { operations: [], drift: [] });
});

test('reports drift for a different ENUM value list', () => {
  const plan = planSchema([enumTable], metadata([{
    name: 'sample',
    columns: new Map([['user_type', { columnType: "enum('oauth','discord')", nullable: false, defaultValue: null, extra: '' }]]),
    indexes: new Map([['PRIMARY', { unique: true, columns: ['user_type'] }]]),
    foreignKeys: new Map(),
  }]));
  assert.equal(plan.drift[0].objectName, 'user_type');
  assert.equal(plan.drift[0].objectType, 'column');
});

function completeActual(overrides = {}) {
  return {
    name: 'sample',
    engine: 'innodb',
    characterSet: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
    columns: new Map([
      ['id', {
        columnType: 'int(11)', nullable: false, defaultValue: null, extra: '',
        characterSet: null, collation: null,
      }],
      ['name', {
        columnType: 'varchar(50)', nullable: true, defaultValue: null, extra: '',
        characterSet: 'utf8mb4', collation: 'utf8mb4_unicode_ci',
      }],
    ]),
    indexes: new Map([
      ['primary', {
        unique: true,
        parts: [{ column: 'id', expression: null, prefixLength: null, order: 'asc' }],
        type: 'btree', visible: true,
      }],
      ['idx_sample_name', {
        unique: false,
        parts: [{ column: 'name', expression: null, prefixLength: null, order: 'asc' }],
        type: 'btree', visible: true,
      }],
    ]),
    foreignKeys: new Map(),
    ...overrides,
  };
}

test('lower_case_table_names zero blocks a case-folded table collision', () => {
  const plan = planSchema([table], {
    tableCount: 1,
    lowerCaseTableNames: 0,
    tables: new Map([['Sample', completeActual({ name: 'Sample' })]]),
  });

  assert.equal(plan.operations.length, 0);
  assert.equal(plan.drift[0].objectType, 'table_name');
  assert.equal(plan.drift[0].expected, 'sample');
  assert.equal(plan.drift[0].actual, 'Sample');
});

test('lower_case_table_names one allows normalized table lookup', () => {
  const plan = planSchema([table], {
    tableCount: 1,
    lowerCaseTableNames: 1,
    tables: new Map([['sample', completeActual({ name: 'SAMPLE' })]]),
  });

  assert.deepEqual(plan, { operations: [], drift: [] });
});

test('compares table, column charset/collation, and complete index semantics', () => {
  const actual = completeActual();
  actual.engine = 'myisam';
  actual.columns.get('name').collation = 'utf8mb4_general_ci';
  actual.indexes.get('idx_sample_name').parts[0].prefixLength = 10;
  actual.indexes.get('idx_sample_name').parts[0].order = 'desc';
  actual.indexes.get('idx_sample_name').visible = false;
  const plan = planSchema([table], {
    tableCount: 1, lowerCaseTableNames: 1, tables: new Map([['sample', actual]]),
  });

  assert.deepEqual(
    plan.drift.map((item) => [item.objectType, item.objectName]),
    [['table', 'sample'], ['column', 'name'], ['index', 'idx_sample_name']],
  );
  assert.match(JSON.stringify(plan.drift), /myisam/);
  assert.match(JSON.stringify(plan.drift), /prefixLength/);
});

test('structurally equivalent index and foreign key aliases satisfy the manifest', () => {
  const aliasTable = {
    ...table,
    indexes: [{ name: 'idx_ls_status', unique: false, columns: ['name'] }],
    foreignKeys: [{
      name: 'fk_desired', columns: ['id'], referencedTable: 'parent', referencedColumns: ['id'],
      onDelete: 'CASCADE', onUpdate: 'RESTRICT', matchOption: 'NONE',
    }],
  };
  const actual = completeActual({
    indexes: new Map([
      ['primary', completeActual().indexes.get('primary')],
      ['idx_status', completeActual().indexes.get('idx_sample_name')],
    ]),
    foreignKeys: new Map([['anonymous_fk', {
      columns: ['id'], referencedTable: 'PARENT', referencedColumns: ['ID'],
      onDelete: 'cascade', onUpdate: 'restrict', matchOption: 'none',
    }]]),
  });
  const plan = planSchema([aliasTable], {
    tableCount: 1, lowerCaseTableNames: 1, tables: new Map([['sample', actual]]),
  });

  assert.deepEqual(plan, { operations: [], drift: [] });
});

test('foreign key referenced table names remain case-sensitive in lower_case_table_names mode 0', () => {
  const caseSensitiveTable = {
    ...table,
    foreignKeys: [{
      name: 'fk_desired', columns: ['id'], referencedTable: 'Parent', referencedColumns: ['id'],
      onDelete: 'CASCADE', onUpdate: 'RESTRICT', matchOption: 'NONE',
    }],
  };
  const actual = completeActual({
    foreignKeys: new Map([['fk_desired', {
      columns: ['id'], referencedTable: 'parent', referencedColumns: ['id'],
      onDelete: 'cascade', onUpdate: 'restrict', matchOption: 'none',
    }]]),
  });
  const plan = planSchema([caseSensitiveTable], {
    tableCount: 1, lowerCaseTableNames: 0, tables: new Map([['sample', actual]]),
  });

  assert.equal(plan.operations.length, 0);
  assert.deepEqual(
    plan.drift.map((item) => [item.objectType, item.objectName]),
    [['foreign_key', 'fk_desired']],
  );
  assert.equal(plan.drift[0].expected.referencedTable, 'Parent');
  assert.equal(plan.drift[0].actual.referencedTable, 'parent');
});

test('foreign key referenced table names normalize case in lower_case_table_names mode 2', () => {
  const normalizedTable = {
    ...table,
    foreignKeys: [{
      name: 'fk_desired', columns: ['id'], referencedTable: 'Parent', referencedColumns: ['id'],
      onDelete: 'CASCADE', onUpdate: 'RESTRICT', matchOption: 'NONE',
    }],
  };
  const actual = completeActual({
    foreignKeys: new Map([['fk_desired', {
      columns: ['id'], referencedTable: 'parent', referencedColumns: ['id'],
      onDelete: 'cascade', onUpdate: 'restrict', matchOption: 'none',
    }]]),
  });
  const plan = planSchema([normalizedTable], {
    tableCount: 1, lowerCaseTableNames: 2, tables: new Map([['sample', actual]]),
  });

  assert.deepEqual(plan, { operations: [], drift: [] });
});

test('a differently defined desired name blocks only when no equivalent alias exists', () => {
  const actual = completeActual({
    indexes: new Map([
      ['primary', completeActual().indexes.get('primary')],
      ['idx_sample_name', {
        unique: true,
        parts: [{ column: 'name', expression: null, prefixLength: null, order: 'asc' }],
        type: 'btree', visible: true,
      }],
    ]),
  });
  const plan = planSchema([table], {
    tableCount: 1, lowerCaseTableNames: 1, tables: new Map([['sample', actual]]),
  });

  assert.equal(plan.operations.length, 0);
  assert.equal(plan.drift[0].objectType, 'index');
});

test('treats MySQL NO ACTION as the implicit RESTRICT foreign-key action', () => {
  const foreignKeyTable = {
    ...table,
    foreignKeys: [{
      name: 'fk_sample_parent', columns: ['id'], referencedTable: 'parent', referencedColumns: ['id'],
      onDelete: 'CASCADE', onUpdate: 'RESTRICT', matchOption: 'NONE',
    }],
  };
  const actual = completeActual({
    foreignKeys: new Map([['fk_sample_parent', {
      columns: ['id'], referencedTable: 'parent', referencedColumns: ['id'],
      onDelete: 'cascade', onUpdate: 'no action', matchOption: 'none',
    }]]),
  });

  assert.deepEqual(planSchema([foreignKeyTable], {
    tableCount: 1, lowerCaseTableNames: 1, tables: new Map([['sample', actual]]),
  }), { operations: [], drift: [] });
});

test('normalizes MySQL fixed-scale DECIMAL defaults without hiding numeric drift', () => {
  const decimalTable = {
    ...table,
    columns: [{
      name: 'amount', definition: 'DECIMAL(20,8) NOT NULL DEFAULT 0',
      expected: { columnType: 'decimal(20,8)', nullable: false, defaultValue: '0', extra: '' },
    }],
    primaryKey: ['amount'],
    indexes: [],
  };
  const conforming = completeActual({
    columns: new Map([['amount', {
      columnType: 'decimal(20,8)', nullable: false, defaultValue: '0.00000000', extra: '',
      characterSet: null, collation: null,
    }]]),
    indexes: new Map([['primary', {
      unique: true,
      parts: [{ column: 'amount', expression: null, prefixLength: null, order: 'asc' }],
      type: 'btree', visible: true,
    }]]),
  });
  const divergent = structuredClone(conforming);
  divergent.columns = new Map([['amount', {
    ...conforming.columns.get('amount'), defaultValue: '1.00000000',
  }]]);

  assert.deepEqual(planSchema([decimalTable], {
    tableCount: 1, lowerCaseTableNames: 1, tables: new Map([['sample', conforming]]),
  }), { operations: [], drift: [] });
  assert.equal(planSchema([decimalTable], {
    tableCount: 1, lowerCaseTableNames: 1, tables: new Map([['sample', divergent]]),
  }).drift[0].objectName, 'amount');
});
