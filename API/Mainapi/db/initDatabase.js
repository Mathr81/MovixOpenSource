function isAccepted(answer) {
  return String(answer || '').trim().toUpperCase() === 'O';
}

function fingerprintOperations(operations) {
  return JSON.stringify(operations.map(({ id, sql }) => [id, sql]));
}

function safeDefinition(value) {
  if (value === undefined) return 'undefined';
  return JSON.stringify(value);
}

function operationIds(operations) {
  return operations.map((operation) => operation.id).join(', ');
}

function formatPlan(plan) {
  const lines = [];
  if (plan.operations.length === 0) lines.push('Aucune operation DDL planifiee.');
  for (const operation of plan.operations) {
    lines.push(`${operation.id}: ${operation.sql}`);
  }
  for (const drift of plan.drift) {
    lines.push(
      `DRIFT ${drift.table}.${drift.objectName} (${drift.objectType}) expected=${safeDefinition(drift.expected)} actual=${safeDefinition(drift.actual)}`,
    );
  }
  return lines.join('\n');
}

async function selectOperations({ metadata, operations, confirm, logger }) {
  if (metadata.tableCount > 0 && !isAccepted(await confirm('Continuer ? (O/N)'))) {
    return { cancelled: true, selected: [], skipped: [], includeWrapped: false };
  }
  const wrapped = operations.filter((item) => item.wrapped);
  if (wrapped.length > 0) {
    logger.log(
      `AVERTISSEMENT Wrapped: ${wrapped.length} operation(s) [${operationIds(wrapped)}]. Ces DDL peuvent provoquer des verrous longs, une forte charge, une duree importante et une consommation supplementaire d'espace disque.`,
    );
  }
  if (wrapped.length > 0 && !isAccepted(await confirm('Modifier les tables Wrapped ? (O/N)'))) {
    return {
      cancelled: false,
      selected: operations.filter((item) => !item.wrapped),
      skipped: wrapped,
      includeWrapped: false,
    };
  }
  return { cancelled: false, selected: operations, skipped: [], includeWrapped: true };
}

async function applySequentially(operations, execute) {
  const applied = [];
  for (let index = 0; index < operations.length; index += 1) {
    const current = operations[index];
    try {
      await execute(current.sql);
      applied.push(current);
    } catch (error) {
      return {
        status: 'failed',
        applied,
        remaining: operations.slice(index),
        failed: current,
      };
    }
  }
  return { status: 'applied', applied, remaining: [] };
}

function selectLockedOperations(operations, includeWrapped) {
  return includeWrapped ? operations : operations.filter((item) => !item.wrapped);
}

function result(status, { applied = [], skipped = [], remaining = [] } = {}) {
  return { status, applied, skipped, remaining };
}

async function runDatabaseInitialization(dependencies) {
  const {
    inspect,
    plan,
    withLock,
    execute,
    confirm,
    logger,
    dryRun = false,
    interactive = false,
  } = dependencies;
  const metadata = await inspect();
  const initialPlan = plan(metadata);
  logger.log(formatPlan(initialPlan));

  if (initialPlan.drift.length > 0) return result('drift', { remaining: initialPlan.operations });
  if (dryRun) return result('dry-run', { remaining: initialPlan.operations });
  if (interactive !== true) throw new Error('Un terminal interactif est requis pour initialiser la base de donnees');

  const selection = await selectOperations({
    metadata,
    operations: initialPlan.operations,
    confirm,
    logger,
  });
  if (selection.cancelled) return result('cancelled', { skipped: initialPlan.operations });

  const confirmedFingerprint = fingerprintOperations(selection.selected);
  return withLock(async (connection) => {
    const lockedMetadata = await inspect(connection);
    const lockedPlan = plan(lockedMetadata);
    if (lockedPlan.drift.length > 0) {
      logger.log(`Drift detecte sous verrou; aucune DDL appliquee. ${formatPlan(lockedPlan)}`);
      return result('drift', { remaining: lockedPlan.operations });
    }

    const selected = selectLockedOperations(lockedPlan.operations, selection.includeWrapped);
    if (fingerprintOperations(selected) !== confirmedFingerprint) {
      logger.log(
        `Plan modifie sous verrou: confirme=[${operationIds(selection.selected)}], actuel=[${operationIds(selected)}]. Relancez l'initialiseur pour revalider le nouveau plan.`,
      );
      return result('changed', { skipped: selection.skipped, remaining: selected });
    }

    const execution = await applySequentially(
      selected,
      (sql) => execute(sql, connection),
    );
    if (execution.status === 'failed') {
      logger.error(
        `Echec DDL pour ${execution.failed.id}: applied=[${operationIds(execution.applied)}] failed=${execution.failed.id} remaining=[${operationIds(execution.remaining)}]`,
      );
    }
    return result(execution.status, {
      applied: execution.applied,
      skipped: selection.skipped,
      remaining: execution.remaining,
    });
  });
}

module.exports = {
  formatPlan,
  fingerprintOperations,
  runDatabaseInitialization,
};
