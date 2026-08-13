const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSchemaMetadata } = require('../schemaMetadata');

test('loads complete MySQL 8.0.13 semantic metadata using fixed queries', async () => {
  const calls = [];
  const resultSets = [
    [{ LOWER_CASE_TABLE_NAMES: 0 }],
    [{ TABLE_NAME: 'Sample', ENGINE: 'InnoDB', CHARACTER_SET_NAME: 'utf8mb4', TABLE_COLLATION: 'utf8mb4_unicode_ci' }],
    [{
      TABLE_NAME: 'Sample', COLUMN_NAME: 'Code', COLUMN_TYPE: 'varchar(64)', IS_NULLABLE: 'NO',
      COLUMN_DEFAULT: null, EXTRA: '', CHARACTER_SET_NAME: 'ascii', COLLATION_NAME: 'ascii_bin',
    }],
    [{
      TABLE_NAME: 'Sample', INDEX_NAME: 'idx_code', NON_UNIQUE: 0, COLUMN_NAME: 'Code',
      EXPRESSION: null, SUB_PART: 12, COLLATION: 'D', INDEX_TYPE: 'BTREE', IS_VISIBLE: 'YES', SEQ_IN_INDEX: 1,
    }],
    [{
      TABLE_NAME: 'Sample', CONSTRAINT_NAME: 'fk_sample_parent', COLUMN_NAME: 'Code',
      REFERENCED_TABLE_NAME: 'Parent', REFERENCED_COLUMN_NAME: 'Code', ORDINAL_POSITION: 1,
      DELETE_RULE: 'CASCADE', UPDATE_RULE: 'RESTRICT', MATCH_OPTION: 'NONE',
    }],
  ];
  const metadata = await loadSchemaMetadata({
    execute: async (sql) => { calls.push(sql); return [resultSets.shift()]; },
  });

  assert.equal(calls.length, 5);
  assert.match(calls[0], /@@lower_case_table_names/);
  assert.ok(calls.every((sql) => !sql.includes('?')));
  assert.equal(metadata.lowerCaseTableNames, 0);
  const table = metadata.tables.get('Sample');
  assert.deepEqual(
    { engine: table.engine, characterSet: table.characterSet, collation: table.collation },
    { engine: 'innodb', characterSet: 'utf8mb4', collation: 'utf8mb4_unicode_ci' },
  );
  assert.deepEqual(table.columns.get('code'), {
    columnType: 'varchar(64)', nullable: false, defaultValue: null, extra: '',
    characterSet: 'ascii', collation: 'ascii_bin',
  });
  assert.deepEqual(table.indexes.get('idx_code'), {
    unique: true,
    parts: [{ column: 'Code', expression: null, prefixLength: 12, order: 'desc' }],
    type: 'btree',
    visible: true,
  });
  assert.deepEqual(table.foreignKeys.get('fk_sample_parent'), {
    columns: ['Code'], referencedTable: 'Parent', referencedColumns: ['Code'],
    onDelete: 'cascade', onUpdate: 'restrict', matchOption: 'none',
  });
});

test('lower_case_table_names zero preserves exact table names for collision detection', async () => {
  const resultSets = [
    [{ LOWER_CASE_TABLE_NAMES: 0 }],
    [
      { TABLE_NAME: 'Users', ENGINE: 'InnoDB', CHARACTER_SET_NAME: 'utf8mb4', TABLE_COLLATION: 'utf8mb4_unicode_ci' },
      { TABLE_NAME: 'users', ENGINE: 'InnoDB', CHARACTER_SET_NAME: 'utf8mb4', TABLE_COLLATION: 'utf8mb4_unicode_ci' },
    ],
    [], [], [],
  ];
  const metadata = await loadSchemaMetadata({ execute: async () => [resultSets.shift()] });

  assert.equal(metadata.tables.size, 2);
  assert.ok(metadata.tables.has('Users'));
  assert.ok(metadata.tables.has('users'));
});

test('loads columns and ordered composite indexes from INFORMATION_SCHEMA rows', async () => {
  const resultSets = [
    [{ LOWER_CASE_TABLE_NAMES: 1 }],
    [{ TABLE_NAME: 'sample', ENGINE: 'InnoDB', CHARACTER_SET_NAME: 'utf8mb4', TABLE_COLLATION: 'utf8mb4_unicode_ci' }],
    [
      { TABLE_NAME: 'sample', COLUMN_NAME: 'id', COLUMN_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, EXTRA: '', CHARACTER_SET_NAME: null, COLLATION_NAME: null },
      { TABLE_NAME: 'sample', COLUMN_NAME: 'name', COLUMN_TYPE: 'varchar(50)', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null, EXTRA: '', CHARACTER_SET_NAME: 'utf8mb4', COLLATION_NAME: 'utf8mb4_unicode_ci' },
    ],
    [
      { TABLE_NAME: 'sample', INDEX_NAME: 'idx_sample', NON_UNIQUE: 1, COLUMN_NAME: 'name', EXPRESSION: null, SUB_PART: null, COLLATION: 'A', INDEX_TYPE: 'BTREE', IS_VISIBLE: 'YES', SEQ_IN_INDEX: 2 },
      { TABLE_NAME: 'sample', INDEX_NAME: 'idx_sample', NON_UNIQUE: 1, COLUMN_NAME: 'id', EXPRESSION: null, SUB_PART: null, COLLATION: 'A', INDEX_TYPE: 'BTREE', IS_VISIBLE: 'YES', SEQ_IN_INDEX: 1 },
    ],
    [],
  ];
  const queryable = { execute: async () => [resultSets.shift()] };
  const metadata = await loadSchemaMetadata(queryable);
  assert.equal(metadata.tableCount, 1);
  assert.deepEqual(metadata.tables.get('sample').indexes.get('idx_sample'), {
    unique: false,
    parts: [
      { column: 'id', expression: null, prefixLength: null, order: 'asc' },
      { column: 'name', expression: null, prefixLength: null, order: 'asc' },
    ],
    type: 'btree',
    visible: true,
  });
  assert.equal(metadata.tables.get('sample').columns.get('id').nullable, false);
});

test('preserves numeric defaults, normalizes identifier lookups, and ignores non-base-table rows', async () => {
  const resultSets = [
    [{ LOWER_CASE_TABLE_NAMES: 1 }],
    [
      { TABLE_NAME: 'Sample', ENGINE: 'InnoDB', CHARACTER_SET_NAME: 'utf8mb4', TABLE_COLLATION: 'utf8mb4_unicode_ci' },
      { TABLE_NAME: 'Parent', ENGINE: 'InnoDB', CHARACTER_SET_NAME: 'utf8mb4', TABLE_COLLATION: 'utf8mb4_unicode_ci' },
    ],
    [
      { TABLE_NAME: 'SAMPLE', COLUMN_NAME: 'Parent_ID', COLUMN_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_DEFAULT: 0, EXTRA: '', CHARACTER_SET_NAME: null, COLLATION_NAME: null },
      { TABLE_NAME: 'view_only', COLUMN_NAME: 'ignored', COLUMN_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, EXTRA: '', CHARACTER_SET_NAME: null, COLLATION_NAME: null },
    ],
    [
      { TABLE_NAME: 'SAMPLE', INDEX_NAME: 'IDX_SAMPLE_PARENT', NON_UNIQUE: 1, COLUMN_NAME: 'Parent_ID', EXPRESSION: null, SUB_PART: null, COLLATION: 'A', INDEX_TYPE: 'BTREE', IS_VISIBLE: 'YES', SEQ_IN_INDEX: 1 },
      { TABLE_NAME: 'view_only', INDEX_NAME: 'idx_ignored', NON_UNIQUE: 1, COLUMN_NAME: 'ignored', EXPRESSION: null, SUB_PART: null, COLLATION: 'A', INDEX_TYPE: 'BTREE', IS_VISIBLE: 'YES', SEQ_IN_INDEX: 1 },
    ],
    [
      { TABLE_NAME: 'SAMPLE', CONSTRAINT_NAME: 'FK_SAMPLE_PARENT', COLUMN_NAME: 'Parent_ID', REFERENCED_TABLE_NAME: 'PARENT', REFERENCED_COLUMN_NAME: 'ID', ORDINAL_POSITION: 1, DELETE_RULE: 'CASCADE', UPDATE_RULE: 'RESTRICT', MATCH_OPTION: 'NONE' },
      { TABLE_NAME: 'view_only', CONSTRAINT_NAME: 'fk_ignored', COLUMN_NAME: 'ignored', REFERENCED_TABLE_NAME: 'parent', REFERENCED_COLUMN_NAME: 'id', ORDINAL_POSITION: 1, DELETE_RULE: 'CASCADE', UPDATE_RULE: 'RESTRICT', MATCH_OPTION: 'NONE' },
    ],
  ];
  const metadata = await loadSchemaMetadata({ execute: async () => [resultSets.shift()] });

  assert.equal(metadata.tables.get('sample').name, 'Sample');
  assert.equal(metadata.tables.get('sample').columns.get('parent_id').defaultValue, '0');
  assert.deepEqual(metadata.tables.get('sample').indexes.get('idx_sample_parent').parts, [
    { column: 'Parent_ID', expression: null, prefixLength: null, order: 'asc' },
  ]);
  assert.equal(metadata.tables.get('sample').foreignKeys.get('fk_sample_parent').referencedTable, 'PARENT');
  assert.equal(metadata.tables.has('view_only'), false);
});
