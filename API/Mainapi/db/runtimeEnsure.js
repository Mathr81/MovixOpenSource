const { getTablesByGroup, renderCreateTable } = require('./schema');

async function ensureTableGroup(pool, group, dependencies = {}) {
  if (!pool || typeof pool.execute !== 'function') {
    throw new Error('Pool MySQL invalide pour le bootstrap du schéma');
  }

  const tables = dependencies.tables || getTablesByGroup(group);
  const render = dependencies.renderCreateTable || renderCreateTable;
  for (const table of tables.filter((item) => item.group === group)) {
    await pool.execute(render(table));
  }
}

module.exports = { ensureTableGroup };
