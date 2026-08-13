#!/usr/bin/env node

function loadProductionDependencies() {
  const readline = require('node:readline/promises');
  const mysql = require('mysql2/promise');
  const { stdin, stdout } = require('node:process');
  const { dbConfig, SCHEMA_BOOTSTRAP_LOCK_NAME, withMysqlAdvisoryLock } = require('../mysqlPool');
  const { schema } = require('../db/schema');
  const { loadSchemaMetadata } = require('../db/schemaMetadata');
  const { planSchema } = require('../db/schemaPlanner');
  const { runDatabaseInitialization } = require('../db/initDatabase');

  return {
    createPool: mysql.createPool,
    createPrompt: readline.createInterface,
    input: stdin,
    output: stdout,
    config: dbConfig,
    lockName: SCHEMA_BOOTSTRAP_LOCK_NAME,
    withAdvisoryLock: withMysqlAdvisoryLock,
    schemaManifest: schema,
    loadMetadata: loadSchemaMetadata,
    createPlan: planSchema,
    runInitialization: runDatabaseInitialization,
  };
}

function parseArguments(argv) {
  const unknown = argv.filter((arg) => arg !== '--dry-run');
  if (unknown.length > 0) throw new Error(`Option inconnue: ${unknown.join(', ')}`);
  return { dryRun: argv.includes('--dry-run') };
}

function validateConfig(config) {
  for (const key of ['host', 'user', 'password', 'database']) {
    if (!config[key]) throw new Error(`Configuration MySQL manquante: ${key}`);
  }
}

function createInitializer(dependencies = {}) {
  let productionDependencies;
  const production = () => {
    if (!productionDependencies) {
      const loader = dependencies.loadProductionDependencies || loadProductionDependencies;
      productionDependencies = loader();
    }
    return productionDependencies;
  };

  return async function main() {
    const { dryRun } = parseArguments(dependencies.argv || process.argv.slice(2));
    const config = dependencies.config || production().config;
    validateConfig(config);
    let pool;
    let prompt;

    try {
      const createPool = dependencies.createPool || production().createPool;
      const createPrompt = dependencies.createPrompt || production().createPrompt;
      const input = dependencies.input || process.stdin;
      const output = dependencies.output || process.stdout;
      pool = createPool({ ...config, connectionLimit: 1, maxIdle: 1, queueLimit: 0 });
      prompt = createPrompt({ input, output });
      const loadMetadata = dependencies.loadMetadata || production().loadMetadata;
      const schemaManifest = dependencies.schemaManifest || production().schemaManifest;
      const createPlan = dependencies.createPlan || production().createPlan;
      const runInitialization = dependencies.runInitialization || production().runInitialization;
      const withAdvisoryLock = dependencies.withAdvisoryLock || production().withAdvisoryLock;
      const lockName = dependencies.lockName || production().lockName;
      const logger = dependencies.logger || console;
      const confirm = async (question) => prompt.question(`${question} `);
      const inspect = (queryable = pool) => loadMetadata(queryable);
      const plan = (metadata) => createPlan(schemaManifest, metadata);
      const result = await runInitialization({
        inspect,
        plan,
        withLock: (task) => withAdvisoryLock(pool, lockName, task),
        execute: (sql, queryable = pool) => queryable.execute(sql),
        confirm,
        logger,
        dryRun,
        interactive: input.isTTY === true && output.isTTY === true,
      });
      if (['failed', 'drift', 'changed'].includes(result.status)) process.exitCode = 1;
    } finally {
      try {
        if (prompt) prompt.close();
      } finally {
        if (pool) await pool.end();
      }
    }
  }
}

function reportInitializationFailure(logger = console) {
  logger.error('Initialisation impossible.');
}

const main = createInitializer();

if (require.main === module) {
  main().catch(() => {
    reportInitializationFailure();
    process.exitCode = 1;
  });
}

module.exports = {
  createInitializer,
  loadProductionDependencies,
  main,
  parseArguments,
  reportInitializationFailure,
  validateConfig,
};
