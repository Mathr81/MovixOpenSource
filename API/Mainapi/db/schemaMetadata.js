const LOWER_CASE_TABLE_NAMES_SQL = `
  SELECT @@lower_case_table_names AS LOWER_CASE_TABLE_NAMES
`;
const TABLES_SQL = `
  SELECT t.TABLE_NAME, t.ENGINE, c.CHARACTER_SET_NAME, t.TABLE_COLLATION
  FROM INFORMATION_SCHEMA.TABLES t
  JOIN INFORMATION_SCHEMA.COLLATION_CHARACTER_SET_APPLICABILITY c
    ON c.COLLATION_NAME = t.TABLE_COLLATION
  WHERE t.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE'
`;
const COLUMNS_SQL = `
  SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA,
         CHARACTER_SET_NAME, COLLATION_NAME
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
  ORDER BY TABLE_NAME, ORDINAL_POSITION
`;
const INDEXES_SQL = `
  SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, COLUMN_NAME, EXPRESSION, SUB_PART,
         COLLATION, INDEX_TYPE, IS_VISIBLE, SEQ_IN_INDEX
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
  ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
`;
const FOREIGN_KEYS_SQL = `
  SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME,
         k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
         k.ORDINAL_POSITION, r.DELETE_RULE, r.UPDATE_RULE, r.MATCH_OPTION
  FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
  JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS r
    ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
   AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
   AND r.TABLE_NAME = k.TABLE_NAME
  WHERE k.CONSTRAINT_SCHEMA = DATABASE()
    AND k.REFERENCED_TABLE_NAME IS NOT NULL
  ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION
`;

function normalizeText(value) {
  return String(value == null ? '' : value)
    .replace(/DEFAULT_GENERATED/gi, '')
    .replace(/CURRENT_TIMESTAMP\(\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function identifierKey(value) {
  return String(value).toLowerCase();
}

function normalizeNullableText(value) {
  return value == null ? null : normalizeText(value);
}

function tableKey(name, lowerCaseTableNames) {
  return lowerCaseTableNames === 0 ? String(name) : identifierKey(name);
}

function getTable(tables, name, lowerCaseTableNames) {
  return tables.get(tableKey(name, lowerCaseTableNames));
}

function ensureTable(tables, row, lowerCaseTableNames) {
  const key = tableKey(row.TABLE_NAME, lowerCaseTableNames);
  if (!tables.has(key)) {
    tables.set(key, {
      name: row.TABLE_NAME,
      engine: normalizeNullableText(row.ENGINE),
      characterSet: normalizeNullableText(row.CHARACTER_SET_NAME),
      collation: normalizeNullableText(row.TABLE_COLLATION),
      columns: new Map(),
      indexes: new Map(),
      foreignKeys: new Map(),
    });
  }
  return tables.get(key);
}

function orderedRows(items) {
  return [...items].sort(
    (left, right) => Number(left.SEQ_IN_INDEX || left.ORDINAL_POSITION)
      - Number(right.SEQ_IN_INDEX || right.ORDINAL_POSITION),
  );
}

function normalizeIndexOrder(value) {
  if (String(value).toUpperCase() === 'A') return 'asc';
  if (String(value).toUpperCase() === 'D') return 'desc';
  return null;
}

async function loadSchemaMetadata(queryable) {
  const [settingRows] = await queryable.execute(LOWER_CASE_TABLE_NAMES_SQL);
  const lowerCaseTableNames = Number(settingRows?.[0]?.LOWER_CASE_TABLE_NAMES);
  if (![0, 1, 2].includes(lowerCaseTableNames)) {
    throw new Error('Valeur MySQL lower_case_table_names non supportee');
  }

  const [tableRows] = await queryable.execute(TABLES_SQL);
  const [columnRows] = await queryable.execute(COLUMNS_SQL);
  const [indexRows] = await queryable.execute(INDEXES_SQL);
  const [foreignKeyRows] = await queryable.execute(FOREIGN_KEYS_SQL);
  const tables = new Map();

  for (const row of tableRows) ensureTable(tables, row, lowerCaseTableNames);
  for (const row of columnRows) {
    const table = getTable(tables, row.TABLE_NAME, lowerCaseTableNames);
    if (!table) continue;
    table.columns.set(identifierKey(row.COLUMN_NAME), {
      columnType: normalizeText(row.COLUMN_TYPE),
      nullable: String(row.IS_NULLABLE).toUpperCase() === 'YES',
      defaultValue: normalizeNullableText(row.COLUMN_DEFAULT),
      extra: normalizeText(row.EXTRA),
      characterSet: normalizeNullableText(row.CHARACTER_SET_NAME),
      collation: normalizeNullableText(row.COLLATION_NAME),
    });
  }

  const indexes = new Map();
  for (const row of indexRows) {
    if (!getTable(tables, row.TABLE_NAME, lowerCaseTableNames)) continue;
    const key = `${tableKey(row.TABLE_NAME, lowerCaseTableNames)}\u0000${identifierKey(row.INDEX_NAME)}`;
    if (!indexes.has(key)) indexes.set(key, []);
    indexes.get(key).push(row);
  }
  for (const rows of indexes.values()) {
    const ordered = orderedRows(rows);
    const first = ordered[0];
    getTable(tables, first.TABLE_NAME, lowerCaseTableNames).indexes.set(
      identifierKey(first.INDEX_NAME),
      {
        unique: Number(first.NON_UNIQUE) === 0,
        parts: ordered.map((row) => ({
          column: row.COLUMN_NAME == null ? null : String(row.COLUMN_NAME),
          expression: normalizeNullableText(row.EXPRESSION),
          prefixLength: row.SUB_PART == null ? null : Number(row.SUB_PART),
          order: normalizeIndexOrder(row.COLLATION),
        })),
        type: normalizeText(first.INDEX_TYPE),
        visible: String(first.IS_VISIBLE).toUpperCase() === 'YES',
      },
    );
  }

  const foreignKeys = new Map();
  for (const row of foreignKeyRows) {
    if (!getTable(tables, row.TABLE_NAME, lowerCaseTableNames)) continue;
    const key = `${tableKey(row.TABLE_NAME, lowerCaseTableNames)}\u0000${identifierKey(row.CONSTRAINT_NAME)}`;
    if (!foreignKeys.has(key)) foreignKeys.set(key, []);
    foreignKeys.get(key).push(row);
  }
  for (const rows of foreignKeys.values()) {
    const ordered = orderedRows(rows);
    const first = ordered[0];
    getTable(tables, first.TABLE_NAME, lowerCaseTableNames).foreignKeys.set(
      identifierKey(first.CONSTRAINT_NAME),
      {
        columns: ordered.map((row) => row.COLUMN_NAME),
        referencedTable: first.REFERENCED_TABLE_NAME,
        referencedColumns: ordered.map((row) => row.REFERENCED_COLUMN_NAME),
        onDelete: normalizeText(first.DELETE_RULE) || 'restrict',
        onUpdate: normalizeText(first.UPDATE_RULE) || 'restrict',
        matchOption: normalizeText(first.MATCH_OPTION) || 'none',
      },
    );
  }

  return { lowerCaseTableNames, tableCount: tableRows.length, tables };
}

module.exports = {
  loadSchemaMetadata,
  LOWER_CASE_TABLE_NAMES_SQL,
  TABLES_SQL,
  COLUMNS_SQL,
  INDEXES_SQL,
  FOREIGN_KEYS_SQL,
};
