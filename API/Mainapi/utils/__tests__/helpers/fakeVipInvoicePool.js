'use strict';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function createFakeVipInvoicePool(initialInvoices, options = {}) {
  const rows = new Map(initialInvoices.map((invoice) => [Number(invoice.id), clone(invoice)]));
  const events = [];
  const calls = [];
  const stats = {
    updates: 0,
    identityUpdates: 0,
    commits: 0,
    rollbacks: 0
  };
  let transactionTail = Promise.resolve();

  function findBy(field, value) {
    return [...rows.values()].find((row) => row[field] === value) || null;
  }

  async function read(sql, params) {
    const normalized = normalizeSql(sql);
    if (/WHERE paygate_callback_reference = \?/i.test(normalized)) {
      return [[clone(findBy('paygate_callback_reference', params[0]))].filter(Boolean), []];
    }
    if (/WHERE public_id = \?/i.test(normalized)) {
      const invoice = findBy('public_id', params[0]);
      if (/paygate_callback_reference IS NULL/i.test(normalized) && invoice?.paygate_callback_reference) {
        return [[], []];
      }
      return [[clone(invoice)].filter(Boolean), []];
    }
    if (/WHERE id = \?/i.test(normalized) && /SELECT \*/i.test(normalized)) {
      return [[clone(rows.get(Number(params[0])))].filter(Boolean), []];
    }
    if (/SELECT id FROM vip_invoices WHERE paygate_paid_txid_in = \?/i.test(normalized)) {
      const owner = [...rows.values()].find((row) => (
        row.paygate_paid_txid_in === params[0] && Number(row.id) !== Number(params[1])
      ));
      return [[owner ? { id: owner.id } : null].filter(Boolean), []];
    }
    if (/SELECT key_value FROM access_keys WHERE key_value = \?/i.test(normalized)) {
      return [[], []];
    }
    return null;
  }

  async function executeSql(sql, params, scope) {
    const normalized = normalizeSql(sql);
    calls.push({ scope, sql: normalized, params: clone(params) });
    const selected = await read(normalized, params);
    if (selected) return selected;

    if (/UPDATE vip_invoices SET status = \?/i.test(normalized)) {
      const [
        nextStatus,
        txHash,
        markPaidAt,
        paidCoin,
        paidValue,
        valueCoin,
        txidIn,
        txidOut,
        _statusForNextCheck,
        invoiceId
      ] = params;
      const invoice = rows.get(Number(invoiceId));
      if (!invoice || !['awaiting_payment', 'partial_payment', 'expired'].includes(invoice.status)) {
        return [{ affectedRows: 0 }, []];
      }
      invoice.status = nextStatus;
      invoice.tx_hash = invoice.tx_hash || txHash;
      invoice.paid_at = markPaidAt ? (invoice.paid_at || new Date().toISOString()) : invoice.paid_at;
      invoice.paygate_paid_coin = paidCoin;
      invoice.paygate_paid_value = paidValue;
      invoice.amount_crypto_received = valueCoin;
      invoice.paygate_paid_txid_in = invoice.paygate_paid_txid_in || txidIn;
      invoice.paygate_paid_txid = invoice.paygate_paid_txid || txidOut;
      stats.updates += 1;
      return [{ affectedRows: 1 }, []];
    }

    if (/UPDATE vip_invoices SET paygate_paid_txid_in = \?/i.test(normalized)) {
      if (options.failTxidClaim) throw options.failTxidClaim;
      const [txidIn, invoiceId] = params;
      const invoice = rows.get(Number(invoiceId));
      if (
        !invoice
        || invoice.status === 'cancelled'
        || invoice.paygate_paid_txid_in
      ) {
        return [{ affectedRows: 0 }, []];
      }
      const duplicateOwner = [...rows.values()].find((row) => (
        Number(row.id) !== Number(invoiceId)
        && row.paygate_paid_txid_in === txidIn
      ));
      if (duplicateOwner) {
        const error = new Error('Duplicate entry');
        error.code = 'ER_DUP_ENTRY';
        error.errno = 1062;
        throw error;
      }
      invoice.paygate_paid_txid_in = txidIn;
      stats.identityUpdates += 1;
      return [{ affectedRows: 1 }, []];
    }

    if (/UPDATE vip_invoices SET status = 'paid'/i.test(normalized)) {
      const paymentMethod = params[0];
      const invoiceId = Number(params.at(-1));
      const invoice = rows.get(invoiceId);
      if (!invoice) {
        return [{ affectedRows: 0 }, []];
      }
      invoice.status = 'paid';
      invoice.paid_at = invoice.paid_at || new Date().toISOString();
      if (paymentMethod === 'paygate_hosted') {
        invoice.paygate_paid_coin = invoice.paygate_paid_coin || 'manual';
        invoice.paygate_paid_value = invoice.paygate_paid_value ?? invoice.amount_usd;
      }
      stats.updates += 1;
      return [{ affectedRows: 1 }, []];
    }

    if (/UPDATE vip_invoices SET status = 'delivered'/i.test(normalized)) {
      const invoiceId = Number(params.at(-1));
      const invoice = rows.get(invoiceId);
      if (!invoice || invoice.status !== 'paid' || invoice.vip_key_value) {
        return [{ affectedRows: 0 }, []];
      }
      invoice.status = 'delivered';
      invoice.vip_key_value = params[0];
      return [{ affectedRows: 1 }, []];
    }

    if (/INSERT INTO vip_invoice_events/i.test(normalized)) {
      if (options.failEvent) throw options.failEvent;
      events.push({
        invoiceId: params[0],
        eventType: params[1],
        actorType: params[2],
        actorId: params[3],
        message: params[4],
        payload: params[5] ? JSON.parse(params[5]) : null
      });
      return [{ insertId: events.length, affectedRows: 1 }, []];
    }

    return [{ affectedRows: 1 }, []];
  }

  const pool = {
    async execute(sql, params = []) {
      return executeSql(sql, params, 'pool');
    },
    async getConnection() {
      let unlock = null;
      let snapshot = null;
      let eventLength = 0;
      return {
        async beginTransaction() {
          const previous = transactionTail;
          transactionTail = new Promise((resolve) => {
            unlock = resolve;
          });
          await previous;
          snapshot = new Map([...rows].map(([id, row]) => [id, clone(row)]));
          eventLength = events.length;
        },
        async execute(sql, params = []) {
          return executeSql(sql, params, 'connection');
        },
        async commit() {
          stats.commits += 1;
          unlock?.();
          unlock = null;
        },
        async rollback() {
          stats.rollbacks += 1;
          rows.clear();
          for (const [id, row] of snapshot || []) rows.set(id, row);
          events.length = eventLength;
          unlock?.();
          unlock = null;
        },
        release() {
          unlock?.();
          unlock = null;
        }
      };
    }
  };

  return {
    pool,
    events,
    calls,
    stats,
    getInvoice(id) {
      return clone(rows.get(Number(id)));
    },
    mutateInvoice(id, changes) {
      Object.assign(rows.get(Number(id)), clone(changes));
    }
  };
}

module.exports = {
  createFakeVipInvoicePool
};
