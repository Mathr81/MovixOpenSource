const {
  renderCreateTable,
  renderAddColumn,
  renderAddIndex,
  renderAddForeignKey,
} = require('./schema');

function normalize(value) {
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

function normalizeColumnType(value) {
  return normalize(value)
    .replace(/\b(tinyint|smallint|mediumint|int|integer|bigint)\((\d+)\)/g, (match, type, width) => (
      type === 'tinyint' && width === '1' ? match : type
    ))
    .replace(/\s*([(),])\s*/g, '$1');
}

function normalizeNumericDefault(value, columnType) {
  const normalized = normalize(value);
  if (!/^(?:decimal|numeric)\b/.test(normalizeColumnType(columnType))) return normalized;
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) return normalized;
  const integer = match[2].replace(/^0+(?=\d)/, '') || '0';
  const fraction = String(match[3] || '').replace(/0+$/, '');
  const isZero = integer === '0' && fraction === '';
  const sign = match[1] === '-' && !isZero ? '-' : '';
  return `${sign}${integer}${fraction ? `.${fraction}` : ''}`;
}

function getInsensitive(map, name) {
  if (!(map instanceof Map)) return undefined;
  const key = identifierKey(name);
  if (map.has(key)) return map.get(key);
  for (const [candidate, value] of map) {
    if (identifierKey(candidate) === key) return value;
  }
  return undefined;
}

function expectedTable(table) {
  const options = String(table.options || '');
  return {
    engine: normalize(/\bENGINE\s*=\s*([a-z0-9_]+)/i.exec(options)?.[1]),
    characterSet: normalize(/\b(?:DEFAULT\s+)?CHARSET\s*=\s*([a-z0-9_]+)/i.exec(options)?.[1]),
    collation: normalize(/\bCOLLATE\s*=\s*([a-z0-9_]+)/i.exec(options)?.[1]),
  };
}

function actualTableDefinition(actual) {
  return {
    engine: normalize(actual.engine),
    characterSet: normalize(actual.characterSet),
    collation: normalize(actual.collation),
  };
}

function equivalentTable(table, actual) {
  const expected = expectedTable(table);
  const current = actualTableDefinition(actual);
  return Object.entries(expected).every(([key, value]) => (
    actual[key] === undefined || value === current[key]
  ));
}

function expectedColumnType(column) {
  if (normalize(column.expected.columnType) !== 'enum') return column.expected.columnType;
  const enumDefinition = /^\s*(enum\s*\(.*?\))/i.exec(column.definition);
  return enumDefinition ? enumDefinition[1] : column.expected.columnType;
}

function isCharacterColumn(column) {
  return /^(?:char|varchar|tinytext|text|mediumtext|longtext|enum|set)\b/i
    .test(expectedColumnType(column));
}

function expectedColumn(table, column) {
  const tableDefinition = expectedTable(table);
  const columnType = normalizeColumnType(expectedColumnType(column));
  const characterSet = /\bCHARACTER\s+SET\s+([a-z0-9_]+)/i.exec(column.definition)?.[1];
  const collation = /\bCOLLATE\s+([a-z0-9_]+)/i.exec(column.definition)?.[1];
  const characterColumn = isCharacterColumn(column);
  return {
    columnType,
    nullable: Boolean(column.expected.nullable),
    defaultValue: column.expected.defaultValue == null
      ? null
      : normalizeNumericDefault(column.expected.defaultValue, columnType),
    extra: normalize(column.expected.extra),
    characterSet: characterColumn
      ? normalize(column.expected.characterSet || characterSet || tableDefinition.characterSet)
      : null,
    collation: characterColumn
      ? normalize(column.expected.collation || collation || tableDefinition.collation)
      : null,
  };
}

function actualColumn(actual) {
  const columnType = normalizeColumnType(actual.columnType);
  return {
    columnType,
    nullable: Boolean(actual.nullable),
    defaultValue: actual.defaultValue == null
      ? null
      : normalizeNumericDefault(actual.defaultValue, columnType),
    extra: normalize(actual.extra),
    characterSet: actual.characterSet === undefined ? undefined : normalize(actual.characterSet) || null,
    collation: actual.collation === undefined ? undefined : normalize(actual.collation) || null,
  };
}

function equivalentColumn(table, column, actual) {
  const expected = expectedColumn(table, column);
  const current = actualColumn(actual);
  return Object.entries(expected).every(([key, value]) => (
    current[key] === undefined || value === current[key]
  ));
}

function normalizeIndexPart(part) {
  if (typeof part === 'string') {
    return { column: identifierKey(part), expression: null, prefixLength: null, order: 'asc' };
  }
  return {
    column: part.column == null ? null : identifierKey(part.column),
    expression: part.expression == null ? null : normalize(part.expression),
    prefixLength: part.prefixLength == null ? null : Number(part.prefixLength),
    order: normalize(part.order || 'asc'),
  };
}

function indexDefinition(index) {
  return {
    unique: Boolean(index.unique),
    parts: (index.parts || index.columns || []).map(normalizeIndexPart),
    type: normalize(index.type || index.indexType || 'btree'),
    visible: index.visible !== false,
  };
}

function sameIndex(expected, actual) {
  return JSON.stringify(indexDefinition(expected)) === JSON.stringify(indexDefinition(actual));
}

function referencedTableKey(value, lowerCaseTableNames) {
  return lowerCaseTableNames === 0 ? String(value) : identifierKey(value);
}

function normalizeReferentialAction(value) {
  const action = normalize(value || 'restrict');
  return action === 'no action' ? 'restrict' : action;
}

function foreignKeyDefinition(foreignKey, lowerCaseTableNames) {
  return {
    columns: (foreignKey.columns || []).map(identifierKey),
    referencedTable: referencedTableKey(foreignKey.referencedTable, lowerCaseTableNames),
    referencedColumns: (foreignKey.referencedColumns || []).map(identifierKey),
    onDelete: normalizeReferentialAction(foreignKey.onDelete),
    onUpdate: normalizeReferentialAction(foreignKey.onUpdate),
    matchOption: normalize(foreignKey.matchOption || 'none'),
  };
}

function sameForeignKey(expected, actual, lowerCaseTableNames) {
  return JSON.stringify(foreignKeyDefinition(expected, lowerCaseTableNames))
    === JSON.stringify(foreignKeyDefinition(actual, lowerCaseTableNames));
}

function operation(kind, table, objectName, sql) {
  return {
    id: `${kind}:${table.name}:${objectName}`,
    kind,
    table: table.name,
    objectName,
    wrapped: table.wrapped === true,
    sql,
  };
}

function addDrift(drift, table, objectType, objectName, expected, actual) {
  drift.push({ table: table.name, objectType, objectName, expected, actual });
}

function findTable(metadata, desiredName) {
  const entries = [...metadata.tables.entries()];
  if (metadata.lowerCaseTableNames === 0) {
    const exact = metadata.tables.get(desiredName)
      || entries.find(([, value]) => value.name === desiredName)?.[1];
    if (exact) return { actual: exact, collision: null };
    const collisions = entries
      .map(([, value]) => value)
      .filter((value) => identifierKey(value.name) === identifierKey(desiredName));
    return { actual: null, collision: collisions.length ? collisions.map((value) => value.name) : null };
  }
  return { actual: getInsensitive(metadata.tables, desiredName) || null, collision: null };
}

function compareColumns(table, actual, operations, drift) {
  for (const column of table.columns) {
    const current = getInsensitive(actual.columns, column.name);
    if (!current) operations.push(operation('add_column', table, column.name, renderAddColumn(table, column)));
    else if (!equivalentColumn(table, column, current)) {
      addDrift(drift, table, 'column', column.name, expectedColumn(table, column), actualColumn(current));
    }
  }
}

function comparePrimaryKey(table, actual, drift) {
  const current = getInsensitive(actual.indexes, 'PRIMARY');
  const expected = { unique: true, columns: table.primaryKey, type: 'btree', visible: true };
  if (!current || !sameIndex(expected, current)) {
    addDrift(drift, table, 'primary_key', 'PRIMARY', indexDefinition(expected), current || null);
  }
}

function equivalentValue(map, expected, comparator) {
  if (!(map instanceof Map)) return undefined;
  return [...map.values()].find((actual) => comparator(expected, actual));
}

function compareIndexes(table, actual, operations, drift) {
  for (const index of table.indexes) {
    const current = getInsensitive(actual.indexes, index.name);
    if (equivalentValue(actual.indexes, index, sameIndex)) continue;
    if (current) addDrift(drift, table, 'index', index.name, indexDefinition(index), current);
    else operations.push(operation('add_index', table, index.name, renderAddIndex(table, index)));
  }
}

function compareForeignKeys(table, actual, operations, drift, lowerCaseTableNames) {
  for (const foreignKey of table.foreignKeys) {
    const current = getInsensitive(actual.foreignKeys, foreignKey.name);
    if (equivalentValue(
      actual.foreignKeys,
      foreignKey,
      (expected, candidate) => sameForeignKey(expected, candidate, lowerCaseTableNames),
    )) continue;
    if (current) {
      addDrift(
        drift,
        table,
        'foreign_key',
        foreignKey.name,
        foreignKeyDefinition(foreignKey, lowerCaseTableNames),
        current,
      );
    } else {
      operations.push(operation(
        'add_foreign_key',
        table,
        foreignKey.name,
        renderAddForeignKey(table, foreignKey),
      ));
    }
  }
}

function planSchema(manifest, metadata) {
  const operations = [];
  const drift = [];
  for (const table of manifest) {
    const { actual, collision } = findTable(metadata, table.name);
    if (collision) {
      addDrift(drift, table, 'table_name', table.name, table.name, collision.join(', '));
      continue;
    }
    if (!actual) {
      operations.push(operation('create_table', table, table.name, renderCreateTable(table)));
      continue;
    }
    if (!equivalentTable(table, actual)) {
      addDrift(drift, table, 'table', table.name, expectedTable(table), actualTableDefinition(actual));
    }
    compareColumns(table, actual, operations, drift);
    comparePrimaryKey(table, actual, drift);
    compareIndexes(table, actual, operations, drift);
    compareForeignKeys(table, actual, operations, drift, metadata.lowerCaseTableNames);
  }
  return { operations, drift };
}

module.exports = { planSchema };
