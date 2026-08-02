const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/;
const TABLE_OPTIONS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
const CHARACTER_COLUMN_PATTERN = /^(?:char|varchar|tinytext|text|mediumtext|longtext|enum|set)\b/i;
const LOB_COLUMN_PATTERN = /^(?:tinytext|text|mediumtext|longtext|tinyblob|blob|mediumblob|longblob)\b/i;

function quoteIdentifier(name) {
  if (!IDENTIFIER_PATTERN.test(String(name))) {
    throw new Error(`Identifiant SQL invalide: ${name}`);
  }
  return `\`${name}\``;
}

function column(name, definition, columnType, nullable, defaultValue = null, extra = '') {
  const portableDefinition = LOB_COLUMN_PATTERN.test(columnType)
    ? definition.replace(/\s+DEFAULT\s+NULL\b/i, '')
    : definition;
  const isCharacter = CHARACTER_COLUMN_PATTERN.test(columnType);
  const characterSetMatch = /\bCHARACTER\s+SET\s+([a-z0-9_]+)/i.exec(portableDefinition);
  const collationMatch = /\bCOLLATE\s+([a-z0-9_]+)/i.exec(portableDefinition);
  return {
    name,
    definition: portableDefinition,
    expected: {
      columnType,
      nullable,
      defaultValue,
      extra,
      characterSet: isCharacter ? (characterSetMatch?.[1] || 'utf8mb4') : null,
      collation: isCharacter ? (collationMatch?.[1] || 'utf8mb4_unicode_ci') : null,
    },
  };
}
function index(name, columns) { return { name, unique: false, columns }; }
function uniqueIndex(name, columns) { return { name, unique: true, columns }; }
function foreignKey(name, columns, referencedTable, referencedColumns, onDelete = null) {
  return { name, columns, referencedTable, referencedColumns, onDelete };
}
function renderIndexDefinition(value) {
  return `${value.unique ? 'UNIQUE KEY' : 'KEY'} ${quoteIdentifier(value.name)} (${value.columns.map(quoteIdentifier).join(', ')})`;
}
function renderForeignKeyDefinition(value) {
  const onDelete = value.onDelete ? ` ON DELETE ${value.onDelete}` : '';
  return `CONSTRAINT ${quoteIdentifier(value.name)} FOREIGN KEY (${value.columns.map(quoteIdentifier).join(', ')}) REFERENCES ${quoteIdentifier(value.referencedTable)} (${value.referencedColumns.map(quoteIdentifier).join(', ')})${onDelete}`;
}
function renderCreateTable(table) {
  const definitions = table.columns.map((value) => `${quoteIdentifier(value.name)} ${value.definition}`);
  if (table.primaryKey?.length) definitions.push(`PRIMARY KEY (${table.primaryKey.map(quoteIdentifier).join(', ')})`);
  definitions.push(...table.indexes.map(renderIndexDefinition));
  definitions.push(...table.foreignKeys.map(renderForeignKeyDefinition));
  return `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(table.name)} (\n  ${definitions.join(',\n  ')}\n) ${table.options}`;
}
function renderAddColumn(table, value) { return `ALTER TABLE ${quoteIdentifier(table.name)} ADD COLUMN ${quoteIdentifier(value.name)} ${value.definition}`; }
function renderAddIndex(table, value) { return `ALTER TABLE ${quoteIdentifier(table.name)} ADD ${renderIndexDefinition(value)}`; }
function renderAddForeignKey(table, value) { return `ALTER TABLE ${quoteIdentifier(table.name)} ADD ${renderForeignKeyDefinition(value)}`; }

module.exports = { TABLE_OPTIONS, column, index, uniqueIndex, foreignKey, quoteIdentifier, renderCreateTable, renderAddColumn, renderAddIndex, renderAddForeignKey };
