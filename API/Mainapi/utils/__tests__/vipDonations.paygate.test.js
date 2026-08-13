'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const {
  PAYGATE_FIXTURE,
  buildWalletPayload,
  buildCallbackPayload
} = require('./fixtures/paygateFixtures');
const axios = require('axios');
const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);

mock.method(console, 'log', (...args) => {
  const message = String(args[0] || '');
  if (message.startsWith('[dotenv@') || message.startsWith('[WIFLIX FREE PROXY]')) {
    return;
  }
  originalConsoleLog(...args);
});

mock.method(console, 'error', (...args) => {
  if (args[0] === 'VIP PayGate operation failed') {
    return;
  }
  originalConsoleError(...args);
});

mock.method(axios, 'get', async (url, config = {}) => {
  if (url.startsWith('https://api.proxyscrape.com/')) {
    return { data: '' };
  }
  if (url === 'https://api.paygate.to/control/convert.php') {
    return { data: { value_coin: '7.6' } };
  }
  if (url === 'https://api.paygate.to/control/wallet.php') {
    return {
      data: buildWalletPayload({ callback_url: config.params?.callback })
    };
  }
  throw new Error(`Unexpected HTTP request in PayGate creation test: ${url}`);
});

const vipPaygate = require('../vipPaygate');
const {
  createVipInvoice,
  handlePaygateCallback,
  refreshInvoiceStatus,
  forceValidateInvoice,
  cancelInvoice,
  serializePublicInvoice,
  serializeAdminInvoice,
  ensureVipDonationsTables
} = require('../vipDonations');

function setEnv(t, values) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function makeCreatedInvoice(overrides = {}) {
  return {
    id: 41,
    public_id: PAYGATE_FIXTURE.legacyPublicId,
    payment_method: 'paygate_hosted',
    status: 'awaiting_payment',
    pack_eur: 7,
    amount_eur: 7,
    amount_usd: 7.6,
    vip_years: 1.5,
    recipient_mode: 'self',
    paygate_checkout_url: 'https://checkout.saved.example/pay.php?frozen=1',
    paygate_tracking_address: PAYGATE_FIXTURE.addressInRaw,
    paygate_payer_email: 'payer@example.test',
    created_at: new Date('2026-07-28T12:00:00Z'),
    expires_at: new Date('2026-07-28T15:30:00Z'),
    ...overrides
  };
}

function makeCreationPool({ eventError = null } = {}) {
  const calls = [];
  const state = {
    began: 0,
    committed: 0,
    rolledBack: 0,
    released: 0,
    insertParams: null,
    eventParams: null,
    events: 0
  };
  const connection = {
    async beginTransaction() {
      state.began += 1;
    },
    async execute(sql, params = []) {
      calls.push({ scope: 'connection', sql, params });
      if (/INSERT INTO vip_invoices/i.test(sql)) {
        state.insertParams = params;
        return [{ insertId: 41, affectedRows: 1 }, []];
      }
      if (/INSERT INTO vip_invoice_events/i.test(sql)) {
        if (eventError) throw eventError;
        state.eventParams = params;
        state.events += 1;
        return [{ insertId: 91, affectedRows: 1 }, []];
      }
      return [{ affectedRows: 1 }, []];
    },
    async commit() {
      state.committed += 1;
    },
    async rollback() {
      state.rolledBack += 1;
    },
    release() {
      state.released += 1;
    }
  };
  const pool = {
    async getConnection() {
      return connection;
    },
    async execute(sql, params = []) {
      calls.push({ scope: 'pool', sql, params });
      if (/SELECT \* FROM vip_invoices WHERE id = \?/i.test(sql)) {
        return [[makeCreatedInvoice()], []];
      }
      return [[], []];
    }
  };
  return { pool, state, calls };
}

function makePaygateClient() {
  const calls = {
    convert: [],
    wallet: []
  };
  return {
    calls,
    async convertEurToUsd(amountEur) {
      calls.convert.push(amountEur);
      return 7.6;
    },
    async createWallet(input) {
      calls.wallet.push(input);
      return vipPaygate.parsePaygateWalletResponse(
        buildWalletPayload({ callback_url: input.callbackUrl }),
        input.callbackUrl
      );
    }
  };
}

test('PayGate remains unavailable for 5 EUR and available from 7 EUR', async (t) => {
  setEnv(t, {
    NODE_ENV: 'development',
    VIP_PAYGATE_ENABLED: 'true',
    VIP_PAYGATE_MIN_PACK_EUR: '7',
    VIP_PAYGATE_SETTLEMENT_WALLET: PAYGATE_FIXTURE.settlementWallet
  });
  const { pool } = makeCreationPool();
  const paygateClient = makePaygateClient();

  await assert.rejects(
    createVipInvoice(pool, {
      packEur: 5,
      paymentMethod: 'paygate_hosted',
      recipientMode: 'self',
      payerEmail: 'payer@example.test'
    }, {
      callbackBaseUrl: 'http://localhost:25565',
      paygateClient
    }),
    /pack 5 EUR/
  );

  await assert.doesNotReject(createVipInvoice(pool, {
    packEur: 7,
    paymentMethod: 'paygate_hosted',
    recipientMode: 'self',
    payerEmail: 'payer@example.test'
  }, {
    callbackBaseUrl: 'http://localhost:25565',
    paygateClient
  }));
});

test('production requires a configured HTTPS callback origin and ignores request host fallback', async (t) => {
  setEnv(t, {
    NODE_ENV: 'production',
    VIP_PAYGATE_ENABLED: 'true',
    VIP_PAYGATE_CALLBACK_BASE_URL: undefined,
    VIP_PAYGATE_SETTLEMENT_WALLET: PAYGATE_FIXTURE.settlementWallet
  });
  const { pool, state } = makeCreationPool();

  await assert.rejects(
    createVipInvoice(pool, {
      packEur: 7,
      paymentMethod: 'paygate_hosted',
      recipientMode: 'self',
      payerEmail: 'payer@example.test'
    }, {
      callbackBaseUrl: 'https://attacker.example',
      paygateClient: makePaygateClient()
    }),
    (error) => error.statusCode >= 500 && !error.message.includes('attacker.example')
  );
  assert.equal(state.began, 0);
});

test('malformed wallet response creates neither invoice nor event', async (t) => {
  setEnv(t, {
    NODE_ENV: 'production',
    VIP_PAYGATE_ENABLED: 'true',
    VIP_PAYGATE_CALLBACK_BASE_URL: 'https://api.movix.example',
    VIP_PAYGATE_SETTLEMENT_WALLET: PAYGATE_FIXTURE.settlementWallet
  });
  const { pool, state } = makeCreationPool();
  const paygateClient = makePaygateClient();
  paygateClient.createWallet = async () => {
    throw new vipPaygate.PaygateProtocolError(
      'wallet response contains secret details',
      'PAYGATE_WALLET_RESPONSE_INVALID',
      502
    );
  };

  await assert.rejects(
    createVipInvoice(pool, {
      packEur: 7,
      paymentMethod: 'paygate_hosted',
      recipientMode: 'self',
      payerEmail: 'payer@example.test'
    }, { paygateClient }),
    (error) => error.statusCode === 502
      && error.message === 'Service PayGate temporairement indisponible'
  );
  assert.equal(state.began, 0);
  assert.equal(state.events, 0);
});

test('tiny injected EUR conversion cannot create a zero-value stored invoice', async (t) => {
  setEnv(t, {
    NODE_ENV: 'production',
    VIP_PAYGATE_ENABLED: 'true',
    VIP_PAYGATE_CALLBACK_BASE_URL: 'https://api.movix.example',
    VIP_PAYGATE_SETTLEMENT_WALLET: PAYGATE_FIXTURE.settlementWallet
  });
  const { pool, state } = makeCreationPool();
  const createWallet = mock.fn(async () => {
    throw new Error('wallet creation must not run');
  });

  await assert.rejects(
    createVipInvoice(pool, {
      packEur: 7,
      paymentMethod: 'paygate_hosted',
      recipientMode: 'self',
      payerEmail: 'payer@example.test'
    }, {
      paygateClient: {
        async convertEurToUsd() {
          return 0.004;
        },
        createWallet
      }
    }),
    (error) => (
      error.message === 'Service PayGate temporairement indisponible'
      && error.code === 'PAYGATE_CONVERT_INVALID'
      && error.statusCode === 502
      && !error.message.includes('0.004')
    )
  );

  assert.equal(createWallet.mock.callCount(), 0);
  assert.equal(state.began, 0);
  assert.equal(state.events, 0);
});

test('new PayGate creation separates publicId from callback reference and commits invoice plus event atomically', async (t) => {
  setEnv(t, {
    NODE_ENV: 'production',
    VIP_PAYGATE_ENABLED: 'true',
    VIP_PAYGATE_CALLBACK_BASE_URL: 'https://api.movix.example',
    VIP_PAYGATE_SETTLEMENT_WALLET: PAYGATE_FIXTURE.settlementWallet,
    VIP_PAYGATE_DOMAIN: 'checkout.paygate.to',
    VIP_PAYGATE_MIN_AMOUNT_EUR: '6.25'
  });
  const { pool, state } = makeCreationPool();
  const paygateClient = makePaygateClient();

  await createVipInvoice(pool, {
    packEur: 7,
    paymentMethod: 'paygate_hosted',
    recipientMode: 'self',
    payerEmail: 'payer+vip@example.test'
  }, { paygateClient });

  assert.equal(paygateClient.calls.convert[0], 7);
  assert.equal(paygateClient.calls.wallet.length, 1);
  const callback = new URL(paygateClient.calls.wallet[0].callbackUrl);
  assert.deepEqual([...callback.searchParams.keys()].sort(), ['nonce', 'reference']);
  assert.match(callback.searchParams.get('reference'), /^[a-f0-9]{48}$/);
  assert.match(callback.searchParams.get('nonce'), /^[a-f0-9]{48}$/);
  assert.equal(callback.searchParams.has('publicId'), false);
  assert.equal(callback.toString().includes(PAYGATE_FIXTURE.legacyPublicId), false);

  assert.equal(state.began, 1);
  assert.equal(state.committed, 1);
  assert.equal(state.rolledBack, 0);
  assert.equal(state.events, 1);
  assert.ok(state.insertParams.includes(callback.searchParams.get('reference')));
  assert.ok(state.insertParams.includes(callback.searchParams.get('nonce')));
});

test('event failure rolls back the invoice transaction', async (t) => {
  setEnv(t, {
    NODE_ENV: 'production',
    VIP_PAYGATE_ENABLED: 'true',
    VIP_PAYGATE_CALLBACK_BASE_URL: 'https://api.movix.example',
    VIP_PAYGATE_SETTLEMENT_WALLET: PAYGATE_FIXTURE.settlementWallet
  });
  const { pool, state } = makeCreationPool({ eventError: new Error('event failed') });

  await assert.rejects(createVipInvoice(pool, {
    packEur: 7,
    paymentMethod: 'paygate_hosted',
    recipientMode: 'self',
    payerEmail: 'payer@example.test'
  }, { paygateClient: makePaygateClient() }));

  assert.equal(state.committed, 0);
  assert.equal(state.rolledBack, 1);
});

test('public serializer returns only the frozen stored checkout URL', (t) => {
  setEnv(t, {
    VIP_PAYGATE_DOMAIN: 'changed.example',
    VIP_PAYGATE_LOGO_URL: 'https://changed.example/new-logo.png',
    VIP_PAYGATE_MIN_AMOUNT_EUR: '999'
  });
  const invoice = makeCreatedInvoice();
  assert.equal(
    serializePublicInvoice(invoice).checkoutUrl,
    invoice.paygate_checkout_url
  );
  assert.equal(
    serializePublicInvoice({ ...invoice, paygate_checkout_url: null }).checkoutUrl,
    null
  );
});

test('admin serializer preserves nullable callback contract without authentication material', () => {
  const invoice = makeCreatedInvoice({
    paygate_callback_reference: PAYGATE_FIXTURE.callbackReference,
    paygate_callback_nonce: PAYGATE_FIXTURE.callbackNonce,
    paygate_ipn_token: PAYGATE_FIXTURE.ipnTokenEncoded,
    paygate_callback_url: `https://api.movix.example/api/vip/paygate/callback?reference=${PAYGATE_FIXTURE.callbackReference}&nonce=${PAYGATE_FIXTURE.callbackNonce}`
  });

  const response = serializeAdminInvoice(invoice);
  const serialized = JSON.stringify(response);

  assert.equal(Object.hasOwn(response, 'callbackUrl'), true);
  assert.equal(response.callbackUrl, null);
  assert.equal(serialized.includes(invoice.paygate_callback_url), false);
  assert.equal(serialized.includes(PAYGATE_FIXTURE.callbackReference), false);
  assert.equal(serialized.includes(PAYGATE_FIXTURE.callbackNonce), false);
  assert.equal(serialized.includes(PAYGATE_FIXTURE.ipnTokenEncoded), false);
});

test('PayGate creation event exposes only its explicit non-secret allowlist', async (t) => {
  setEnv(t, {
    NODE_ENV: 'production',
    VIP_PAYGATE_ENABLED: 'true',
    VIP_PAYGATE_CALLBACK_BASE_URL: 'https://api.movix.example',
    VIP_PAYGATE_SETTLEMENT_WALLET: PAYGATE_FIXTURE.settlementWallet
  });
  const { pool, state } = makeCreationPool();
  const paygateClient = makePaygateClient();

  await createVipInvoice(pool, {
    packEur: 7,
    paymentMethod: 'paygate_hosted',
    recipientMode: 'gift',
    payerEmail: 'payer+event-secret@example.test'
  }, { paygateClient });

  const callbackUrl = new URL(paygateClient.calls.wallet[0].callbackUrl);
  const callbackReference = callbackUrl.searchParams.get('reference');
  const callbackNonce = callbackUrl.searchParams.get('nonce');
  const event = JSON.parse(String(state.eventParams[5]));
  const eventPayload = String(state.eventParams[5]);
  const giftToken = state.insertParams.find((value) => (
    typeof value === 'string' && value.startsWith('gift_')
  ));
  const checkoutUrl = state.insertParams.find((value) => (
    typeof value === 'string' && value.startsWith('https://checkout.paygate.to/pay.php')
  ));

  assert.match(giftToken, /^gift_[a-f0-9]{32}$/);
  assert.equal(typeof checkoutUrl, 'string');
  assert.equal(
    paygateClient.calls.wallet[0].settlementWallet,
    PAYGATE_FIXTURE.settlementWallet
  );
  assert.ok(state.insertParams.includes(PAYGATE_FIXTURE.ipnTokenRaw));
  assert.ok(state.insertParams.includes(PAYGATE_FIXTURE.temporaryWallet));
  assert.ok(state.insertParams.includes(PAYGATE_FIXTURE.addressInRaw));
  assert.deepEqual(Object.keys(event).sort(), [
    'amountUsd',
    'checkoutAmountEur',
    'packEur',
    'paymentMethod',
    'recipientMode',
    'vipYears'
  ]);
  for (const secretValue of [
    'payer+event-secret@example.test',
    callbackReference,
    callbackNonce,
    PAYGATE_FIXTURE.ipnTokenRaw,
    paygateClient.calls.wallet[0].callbackUrl,
    checkoutUrl,
    PAYGATE_FIXTURE.settlementWallet,
    PAYGATE_FIXTURE.temporaryWallet,
    PAYGATE_FIXTURE.addressInRaw,
    giftToken,
    'VIP-KEY-SENTINEL'
  ]) {
    assert.equal(eventPayload.includes(secretValue), false);
  }
  for (const secretKey of [
    'payerEmail',
    'callbackReference',
    'callbackNonce',
    'callbackUrl',
    'checkoutUrl',
    'ipnToken',
    'settlementWallet',
    'temporaryWalletAddress',
    'encryptedAddress',
    'giftToken',
    'giftUrl',
    'vipKey'
  ]) {
    assert.equal(Object.hasOwn(event, secretKey), false);
  }
});

test('schema adds nullable unique callback reference and inbound transaction fields', async () => {
  const sqlCalls = [];
  const missingColumns = new Set([
    'paygate_callback_reference',
    'paygate_ipn_token',
    'paygate_paid_txid_in'
  ]);
  const missingIndexes = new Set([
    'uniq_vip_invoices_paygate_callback_reference',
    'uniq_vip_invoices_paygate_paid_txid_in'
  ]);
  const pool = {
    async execute(sql, params = []) {
      sqlCalls.push({ sql, params });
      if (/INFORMATION_SCHEMA\.COLUMNS/i.test(sql)) {
        return [missingColumns.has(params[1]) ? [] : [{ COLUMN_NAME: params[1] }], []];
      }
      if (/INFORMATION_SCHEMA\.STATISTICS/i.test(sql)) {
        return [missingIndexes.has(params[1]) ? [] : [{ INDEX_NAME: params[1] }], []];
      }
      return [[], []];
    }
  };

  await ensureVipDonationsTables(pool);
  const allSql = sqlCalls.map((item) => item.sql).join('\n');
  assert.match(allSql, /paygate_callback_reference VARCHAR\(64\) DEFAULT NULL/);
  assert.match(allSql, /paygate_paid_txid_in VARCHAR\(255\) DEFAULT NULL/);
  assert.match(allSql, /UNIQUE INDEX `uniq_vip_invoices_paygate_callback_reference`/);
  assert.match(allSql, /UNIQUE INDEX `uniq_vip_invoices_paygate_paid_txid_in`/);

  const historicalPaygatePredicates = sqlCalls
    .map((item) => item.sql)
    .filter((sql) => (
      /WHERE payment_method IS NULL/i.test(sql)
      && /paygate_tracking_address/i.test(sql)
    ));
  assert.equal(historicalPaygatePredicates.length, 2);
  for (const sql of historicalPaygatePredicates) {
    assert.match(sql, /NULLIF\(paygate_callback_reference, ''\) IS NOT NULL/);
    assert.match(sql, /NULLIF\(paygate_ipn_token, ''\) IS NOT NULL/);
    assert.match(sql, /NULLIF\(paygate_paid_txid_in, ''\) IS NOT NULL/);
  }

  const callbackNormalizationIndex = sqlCalls.findIndex((item) => (
    /SET paygate_callback_reference = NULL/i.test(item.sql)
  ));
  const txidNormalizationIndex = sqlCalls.findIndex((item) => (
    /SET paygate_paid_txid_in = NULL/i.test(item.sql)
  ));
  const callbackIndexCheckIndex = sqlCalls.findIndex((item) => (
    /INFORMATION_SCHEMA\.STATISTICS/i.test(item.sql)
    && item.params[1] === 'uniq_vip_invoices_paygate_callback_reference'
  ));
  const txidIndexCheckIndex = sqlCalls.findIndex((item) => (
    /INFORMATION_SCHEMA\.STATISTICS/i.test(item.sql)
    && item.params[1] === 'uniq_vip_invoices_paygate_paid_txid_in'
  ));
  assert.ok(callbackNormalizationIndex >= 0);
  assert.ok(txidNormalizationIndex >= 0);
  assert.ok(callbackNormalizationIndex < callbackIndexCheckIndex);
  assert.ok(txidNormalizationIndex < txidIndexCheckIndex);
  assert.match(
    sqlCalls[callbackNormalizationIndex].sql,
    /TRIM\(paygate_callback_reference\) = ''/
  );
  assert.match(
    sqlCalls[txidNormalizationIndex].sql,
    /TRIM\(paygate_paid_txid_in\) = ''/
  );

  const migrationUpdates = sqlCalls
    .map((item) => item.sql)
    .filter((sql) => /^\s*UPDATE vip_invoices/i.test(sql));
  assert.equal(
    migrationUpdates.filter((sql) => /SET paygate_callback_reference\s*=/i.test(sql)).length,
    1
  );
  assert.equal(
    migrationUpdates.filter((sql) => /SET paygate_paid_txid_in\s*=/i.test(sql)).length,
    1
  );
});

test('startup rejects a named PayGate security index that is not unique', async () => {
  const pool = {
    async execute(sql, params = []) {
      if (/INFORMATION_SCHEMA\.COLUMNS/i.test(sql)) {
        return [[{ COLUMN_NAME: params[1] }], []];
      }
      if (/INFORMATION_SCHEMA\.STATISTICS/i.test(sql)) {
        if (params[1] === 'uniq_vip_invoices_paygate_callback_reference') {
          return [[{
            INDEX_NAME: params[1],
            NON_UNIQUE: 1,
            COLUMN_NAME: 'paygate_callback_reference',
            SEQ_IN_INDEX: 1
          }], []];
        }
        return [[{
          INDEX_NAME: params[1],
          NON_UNIQUE: 0,
          COLUMN_NAME: params[1] === 'uniq_vip_invoices_paygate_paid_txid_in'
            ? 'paygate_paid_txid_in'
            : 'unrelated',
          SEQ_IN_INDEX: 1
        }], []];
      }
      return [[], []];
    }
  };

  await assert.rejects(
    ensureVipDonationsTables(pool),
    /Index de sécurité invalide/
  );
});

test('startup rejects a named PayGate security index with the wrong column or sequence', async () => {
  for (const invalidShape of [
    { COLUMN_NAME: 'paygate_paid_txid', SEQ_IN_INDEX: 1 },
    { COLUMN_NAME: 'paygate_paid_txid_in', SEQ_IN_INDEX: 2 }
  ]) {
    const pool = {
      async execute(sql, params = []) {
        if (/INFORMATION_SCHEMA\.COLUMNS/i.test(sql)) {
          return [[{ COLUMN_NAME: params[1] }], []];
        }
        if (/INFORMATION_SCHEMA\.STATISTICS/i.test(sql)) {
          const columnName = params[1] === 'uniq_vip_invoices_paygate_callback_reference'
            ? 'paygate_callback_reference'
            : 'paygate_paid_txid_in';
          return [[{
            INDEX_NAME: params[1],
            NON_UNIQUE: 0,
            COLUMN_NAME: columnName,
            SEQ_IN_INDEX: 1,
            ...(params[1] === 'uniq_vip_invoices_paygate_paid_txid_in'
              ? invalidShape
              : {})
          }], []];
        }
        return [[], []];
      }
    };

    await assert.rejects(
      ensureVipDonationsTables(pool),
      /Index de sécurité invalide/
    );
  }
});

test('startup rejects a two-row composite shape for the named inbound-tx security index', async () => {
  const pool = {
    async execute(sql, params = []) {
      if (/INFORMATION_SCHEMA\.COLUMNS/i.test(sql)) {
        return [[{ COLUMN_NAME: params[1] }], []];
      }
      if (/INFORMATION_SCHEMA\.STATISTICS/i.test(sql)) {
        if (params[1] === 'uniq_vip_invoices_paygate_paid_txid_in') {
          return [[
            {
              INDEX_NAME: params[1],
              NON_UNIQUE: 0,
              COLUMN_NAME: 'paygate_paid_txid_in',
              SEQ_IN_INDEX: 1
            },
            {
              INDEX_NAME: params[1],
              NON_UNIQUE: 0,
              COLUMN_NAME: 'paygate_paid_txid',
              SEQ_IN_INDEX: 2
            }
          ], []];
        }
        return [[{
          INDEX_NAME: params[1],
          NON_UNIQUE: 0,
          COLUMN_NAME: 'paygate_callback_reference',
          SEQ_IN_INDEX: 1
        }], []];
      }
      return [[], []];
    }
  };

  await assert.rejects(
    ensureVipDonationsTables(pool),
    /Index de s.curit. invalide/
  );
});

const { createFakeVipInvoicePool } = require('./helpers/fakeVipInvoicePool');

function makePaygateInvoice(overrides = {}) {
  return {
    ...makeCreatedInvoice(),
    id: 51,
    public_id: PAYGATE_FIXTURE.legacyPublicId,
    status: 'awaiting_payment',
    amount_usd: 7.6,
    paygate_callback_reference: PAYGATE_FIXTURE.callbackReference,
    paygate_callback_nonce: PAYGATE_FIXTURE.callbackNonce,
    paygate_temporary_wallet_address: PAYGATE_FIXTURE.temporaryWallet,
    amount_crypto_received: null,
    paygate_paid_coin: null,
    paygate_paid_value: null,
    paygate_paid_txid_in: null,
    paygate_paid_txid: null,
    paid_at: null,
    vip_key_value: null,
    ...overrides
  };
}

const INVALID_STORED_PAYGATE_AMOUNTS = [
  { name: 'zero', value: 0 },
  { name: 'negative', value: -1 },
  { name: 'null', value: null },
  { name: 'blank', value: '' },
  { name: 'malformed', value: 'not-a-number' },
  { name: 'sub-cent', value: 0.004 }
];

function isStoredPaygateAmountError(error) {
  return error.message === 'Callback PayGate invalide'
    && error.code === 'PAYGATE_INVOICE_AMOUNT_INVALID'
    && error.statusCode === 409;
}

function makeCallbackDeps(fake, overrides = {}) {
  let deliveryTail = Promise.resolve();
  let deliveries = 0;
  const deliverInvoice = async (_pool, invoiceId) => {
    let deliveredInvoice;
    deliveryTail = deliveryTail.then(async () => {
      const invoice = fake.getInvoice(invoiceId);
      if (invoice.status === 'paid' && !invoice.vip_key_value) {
        deliveries += 1;
        fake.mutateInvoice(invoiceId, {
          status: 'delivered',
          vip_key_value: 'VIP-TEST'
        });
      }
      deliveredInvoice = fake.getInvoice(invoiceId);
    });
    await deliveryTail;
    return deliveredInvoice;
  };
  return {
    paygateClient: {
      async convertPaymentToUsd(payment) {
        return payment.valueCoin;
      },
      ...overrides.paygateClient
    },
    deliverInvoice,
    getDeliveryCount: () => deliveries
  };
}

test('callback rejects every invalid stored PayGate USD amount before pricing or state change', async (t) => {
  for (const invalidAmount of INVALID_STORED_PAYGATE_AMOUNTS) {
    await t.test(invalidAmount.name, async () => {
      const invoice = makePaygateInvoice({ amount_usd: invalidAmount.value });
      const fake = createFakeVipInvoicePool([invoice]);
      const before = fake.getInvoice(invoice.id);
      const convertPaymentToUsd = mock.fn(async () => 5);
      const deps = makeCallbackDeps(fake, {
        paygateClient: { convertPaymentToUsd }
      });

      await assert.rejects(
        handlePaygateCallback(fake.pool, buildCallbackPayload(), deps),
        isStoredPaygateAmountError
      );

      assert.deepEqual(fake.getInvoice(invoice.id), before);
      assert.equal(fake.stats.updates, 0);
      assert.equal(fake.stats.identityUpdates, 0);
      assert.equal(fake.events.length, 0);
      assert.equal(deps.getDeliveryCount(), 0);
      assert.equal(convertPaymentToUsd.mock.callCount(), 0);
    });
  }
});

test('callback rejects wrong nonce, address, coin, or transaction without state change', async () => {
  const invalidPayloads = [
    buildCallbackPayload({ nonce: '0'.repeat(48) }),
    buildCallbackPayload({ address_in: '0x1111111111111111111111111111111111111111' }),
    buildCallbackPayload({ coin: 'doge' }),
    buildCallbackPayload({ txid_in: '0x1234' })
  ];

  for (const payload of invalidPayloads) {
    const fake = createFakeVipInvoicePool([makePaygateInvoice()]);
    const deps = makeCallbackDeps(fake);
    await assert.rejects(handlePaygateCallback(fake.pool, payload, deps));
    assert.equal(fake.stats.updates, 0);
    assert.equal(fake.events.length, 0);
    assert.equal(deps.getDeliveryCount(), 0);
  }
});

test('native-price failure makes no state change and remains retryable', async () => {
  const fake = createFakeVipInvoicePool([
    makePaygateInvoice({
      paygate_paid_txid_in: PAYGATE_FIXTURE.txidIn
    })
  ]);
  const deps = makeCallbackDeps(fake, {
    paygateClient: {
      async convertPaymentToUsd() {
        const error = new Error('temporary price failure');
        error.code = 'PAYGATE_NATIVE_PRICE_UNAVAILABLE';
        error.statusCode = 503;
        throw error;
      }
    }
  });
  await assert.rejects(
    handlePaygateCallback(
      fake.pool,
      buildCallbackPayload({ coin: 'polygon_pol', value_coin: '23' }),
      deps
    ),
    (error) => error.statusCode === 503
  );
  assert.equal(fake.stats.updates, 0);
  assert.equal(fake.events.length, 0);
  assert.equal(deps.getDeliveryCount(), 0);
});

test('paid native callback retries delivery without requesting a fresh price', async () => {
  const fake = createFakeVipInvoicePool([
    makePaygateInvoice({
      status: 'paid',
      amount_crypto_received: 5,
      paygate_paid_coin: 'polygon_pol',
      paygate_paid_value: 5,
      paygate_paid_txid_in: PAYGATE_FIXTURE.txidIn,
      paygate_paid_txid: PAYGATE_FIXTURE.txidOut,
      paid_at: new Date('2026-07-28T12:30:00Z')
    })
  ]);
  const convertPaymentToUsd = mock.fn(async () => {
    throw new Error('native price is unavailable');
  });
  const deps = makeCallbackDeps(fake, {
    paygateClient: { convertPaymentToUsd }
  });

  const result = await handlePaygateCallback(
    fake.pool,
    buildCallbackPayload({ coin: 'polygon_pol', value_coin: '5.00' }),
    deps
  );

  assert.equal(convertPaymentToUsd.mock.callCount(), 0);
  assert.equal(result.status, 'delivered');
  assert.equal(fake.getInvoice(51).paygate_paid_value, 5);
  assert.equal(fake.getInvoice(51).amount_crypto_received, 5);
  assert.equal(fake.stats.updates, 0);
  assert.equal(fake.events.length, 0);
  assert.equal(deps.getDeliveryCount(), 1);
});

test('identical native callback replay remains a no-op during a price outage', async (t) => {
  setEnv(t, { VIP_PAYGATE_MIN_PAID_RATIO: '0.60' });
  const fake = createFakeVipInvoicePool([makePaygateInvoice()]);
  let priceAvailable = true;
  const convertPaymentToUsd = mock.fn(async () => {
    if (!priceAvailable) {
      const error = new Error('native price is unavailable');
      error.code = 'PAYGATE_NATIVE_PRICE_UNAVAILABLE';
      error.statusCode = 503;
      throw error;
    }
    return 3;
  });
  const deps = makeCallbackDeps(fake, {
    paygateClient: {
      convertPaymentToUsd
    }
  });
  const payload = buildCallbackPayload({
    coin: 'polygon_pol',
    value_coin: '2.00'
  });

  await handlePaygateCallback(fake.pool, payload, deps);
  const firstObservation = fake.getInvoice(51);
  const updatesAfterFirst = fake.stats.updates;
  const eventsAfterFirst = fake.events.length;

  priceAvailable = false;
  await handlePaygateCallback(fake.pool, payload, deps);
  const replayedObservation = fake.getInvoice(51);

  assert.equal(convertPaymentToUsd.mock.callCount(), 1);
  assert.equal(firstObservation.status, 'partial_payment');
  assert.equal(firstObservation.paygate_paid_value, 3);
  assert.equal(updatesAfterFirst, 1);
  assert.equal(eventsAfterFirst, 1);
  assert.equal(replayedObservation.status, firstObservation.status);
  assert.equal(firstObservation.amount_crypto_received, 2);
  assert.equal(
    replayedObservation.amount_crypto_received,
    firstObservation.amount_crypto_received
  );
  assert.equal(replayedObservation.paygate_paid_value, firstObservation.paygate_paid_value);
  assert.equal(fake.stats.updates, updatesAfterFirst);
  assert.equal(fake.events.length, eventsAfterFirst);
  assert.equal(deps.getDeliveryCount(), 0);
});

test('pricing failure rechecks a concurrent paid or same-raw observation before failing', async () => {
  for (const race of [
    {
      name: 'paid',
      changes: {
        status: 'paid',
        amount_crypto_received: 23,
        paygate_paid_coin: 'polygon_pol',
        paygate_paid_value: 5,
        paygate_paid_txid_in: PAYGATE_FIXTURE.txidIn,
        paygate_paid_txid: PAYGATE_FIXTURE.txidOut,
        paid_at: new Date('2026-07-28T12:30:00Z')
      },
      expectedDeliveryCount: 1
    },
    {
      name: 'same raw',
      changes: {
        status: 'partial_payment',
        amount_crypto_received: 23,
        paygate_paid_coin: 'polygon_pol',
        paygate_paid_value: 3,
        paygate_paid_txid_in: PAYGATE_FIXTURE.txidIn,
        paygate_paid_txid: PAYGATE_FIXTURE.txidOut
      },
      expectedDeliveryCount: 0
    }
  ]) {
    const fake = createFakeVipInvoicePool([makePaygateInvoice()]);
    const deps = makeCallbackDeps(fake, {
      paygateClient: {
        async convertPaymentToUsd() {
          fake.mutateInvoice(51, race.changes);
          const error = new Error('native price is unavailable');
          error.code = 'PAYGATE_NATIVE_PRICE_UNAVAILABLE';
          error.statusCode = 503;
          throw error;
        }
      }
    });

    await assert.doesNotReject(
      handlePaygateCallback(
        fake.pool,
        buildCallbackPayload({ coin: 'polygon_pol', value_coin: '23' }),
        deps
      ),
      race.name
    );
    assert.equal(fake.stats.updates, 0, race.name);
    assert.equal(deps.getDeliveryCount(), race.expectedDeliveryCount, race.name);
  }
});

test('pricing failure remains authoritative when the recovery recheck cannot classify state', async () => {
  const fake = createFakeVipInvoicePool([makePaygateInvoice()]);
  const originalGetConnection = fake.pool.getConnection.bind(fake.pool);
  let lockedReads = 0;
  fake.pool.getConnection = async () => {
    const connection = await originalGetConnection();
    const originalExecute = connection.execute.bind(connection);
    connection.execute = async (sql, params) => {
      if (/SELECT \* FROM vip_invoices WHERE id = \? FOR UPDATE/i.test(sql)) {
        lockedReads += 1;
        if (lockedReads === 2) {
          throw new Error('recovery database failure');
        }
      }
      return originalExecute(sql, params);
    };
    return connection;
  };
  const pricingError = new Error('native price is unavailable');
  pricingError.code = 'PAYGATE_NATIVE_PRICE_UNAVAILABLE';
  pricingError.statusCode = 503;

  await assert.rejects(
    handlePaygateCallback(
      fake.pool,
      buildCallbackPayload({ coin: 'polygon_pol', value_coin: '23' }),
      {
        paygateClient: {
          async convertPaymentToUsd() {
            throw pricingError;
          }
        }
      }
    ),
    (error) => error === pricingError
  );
  assert.equal(lockedReads, 2);
  assert.equal(fake.stats.updates, 0);
  assert.equal(fake.events.length, 0);
});

test('callback accepts the inclusive 0.60 boundary and records both transaction hashes', async (t) => {
  setEnv(t, { VIP_PAYGATE_MIN_PAID_RATIO: '0.60' });
  const fake = createFakeVipInvoicePool([makePaygateInvoice()]);
  const deps = makeCallbackDeps(fake);

  await handlePaygateCallback(
    fake.pool,
    buildCallbackPayload({ value_coin: '4.56', value_forwarded_coin: '4.49' }),
    deps
  );

  const invoice = fake.getInvoice(51);
  assert.equal(invoice.status, 'delivered');
  assert.equal(invoice.paygate_paid_value, 4.56);
  assert.equal(invoice.paygate_paid_txid_in, PAYGATE_FIXTURE.txidIn);
  assert.equal(invoice.paygate_paid_txid, PAYGATE_FIXTURE.txidOut);
  assert.equal(fake.events.length, 1);
  assert.equal(deps.getDeliveryCount(), 1);
});

test('expired invoices move only to partial or paid, while delivered and cancelled stay final', async (t) => {
  setEnv(t, { VIP_PAYGATE_MIN_PAID_RATIO: '0.60' });

  const expiredPartial = createFakeVipInvoicePool([
    makePaygateInvoice({ status: 'expired' })
  ]);
  await handlePaygateCallback(
    expiredPartial.pool,
    buildCallbackPayload({ value_coin: '3.00', value_forwarded_coin: '2.95' }),
    makeCallbackDeps(expiredPartial)
  );
  assert.equal(expiredPartial.getInvoice(51).status, 'partial_payment');

  const expiredPaid = createFakeVipInvoicePool([
    makePaygateInvoice({ status: 'expired' })
  ]);
  const paidDeps = makeCallbackDeps(expiredPaid);
  await handlePaygateCallback(
    expiredPaid.pool,
    buildCallbackPayload({ value_coin: '5.00', value_forwarded_coin: '4.90' }),
    paidDeps
  );
  assert.equal(expiredPaid.getInvoice(51).status, 'delivered');
  assert.equal(paidDeps.getDeliveryCount(), 1);

  for (const finalStatus of ['delivered', 'cancelled']) {
    const finalFake = createFakeVipInvoicePool([
      makePaygateInvoice({ status: finalStatus })
    ]);
    const finalDeps = makeCallbackDeps(finalFake);
    await handlePaygateCallback(finalFake.pool, buildCallbackPayload(), finalDeps);
    assert.equal(finalFake.getInvoice(51).status, finalStatus);
    assert.equal(finalFake.stats.updates, 0);
    assert.equal(finalFake.events.length, 0);
    assert.equal(finalDeps.getDeliveryCount(), 0);
  }
});

test('event failure rolls back payment facts but preserves the authoritative txid claim', async () => {
  const fake = createFakeVipInvoicePool(
    [makePaygateInvoice()],
    { failEvent: new Error('event insert failed') }
  );
  const deps = makeCallbackDeps(fake);
  await assert.rejects(handlePaygateCallback(
    fake.pool,
    buildCallbackPayload(),
    deps
  ));
  assert.equal(fake.getInvoice(51).status, 'awaiting_payment');
  assert.equal(fake.getInvoice(51).paygate_paid_txid_in, PAYGATE_FIXTURE.txidIn);
  assert.equal(fake.stats.identityUpdates, 1);
  assert.equal(fake.stats.rollbacks, 1);
  assert.equal(deps.getDeliveryCount(), 0);
});

test('underpayment becomes partial and exact replay creates no update or event', async (t) => {
  setEnv(t, { VIP_PAYGATE_MIN_PAID_RATIO: '0.60' });
  const fake = createFakeVipInvoicePool([makePaygateInvoice()]);
  const deps = makeCallbackDeps(fake);
  const payload = buildCallbackPayload({
    value_coin: '4.55',
    value_forwarded_coin: '4.48'
  });

  await handlePaygateCallback(fake.pool, payload, deps);
  const updatesAfterFirst = fake.stats.updates;
  const eventsAfterFirst = fake.events.length;
  await handlePaygateCallback(fake.pool, payload, deps);

  assert.equal(fake.getInvoice(51).status, 'partial_payment');
  assert.equal(fake.stats.updates, updatesAfterFirst);
  assert.equal(fake.events.length, eventsAfterFirst);
});

test('same inbound transaction can increase partial to paid but can never regress paid', async (t) => {
  setEnv(t, { VIP_PAYGATE_MIN_PAID_RATIO: '0.60' });
  const fake = createFakeVipInvoicePool([makePaygateInvoice()]);
  const deps = makeCallbackDeps(fake);

  await handlePaygateCallback(fake.pool, buildCallbackPayload({
    value_coin: '3.00',
    value_forwarded_coin: '2.95'
  }), deps);
  await handlePaygateCallback(fake.pool, buildCallbackPayload({
    value_coin: '5.00',
    value_forwarded_coin: '4.92'
  }), deps);
  await handlePaygateCallback(fake.pool, buildCallbackPayload({
    value_coin: '2.00',
    value_forwarded_coin: '1.95'
  }), deps);

  assert.equal(fake.getInvoice(51).status, 'delivered');
  assert.equal(fake.getInvoice(51).paygate_paid_value, 5);
  assert.equal(deps.getDeliveryCount(), 1);
});

test('different inbound transaction on the same or another invoice conflicts', async () => {
  const otherTxid = `0x${'b'.repeat(64)}`;
  const sameInvoiceFake = createFakeVipInvoicePool([
    makePaygateInvoice({
      status: 'partial_payment',
      paygate_paid_value: 3,
      paygate_paid_txid_in: PAYGATE_FIXTURE.txidIn,
      paygate_paid_txid: PAYGATE_FIXTURE.txidOut
    })
  ]);
  await assert.rejects(
    handlePaygateCallback(
      sameInvoiceFake.pool,
      buildCallbackPayload({ txid_in: otherTxid }),
      makeCallbackDeps(sameInvoiceFake)
    ),
    (error) => error.statusCode === 409
  );

  const otherInvoiceFake = createFakeVipInvoicePool([
    makePaygateInvoice(),
    makePaygateInvoice({
      id: 52,
      public_id: 'inv_aaaaaaaaaaaaaaaaaaaaaaaa',
      paygate_callback_reference: 'b'.repeat(48),
      paygate_paid_txid_in: PAYGATE_FIXTURE.txidIn
    })
  ]);
  await assert.rejects(
    handlePaygateCallback(
      otherInvoiceFake.pool,
      buildCallbackPayload(),
      makeCallbackDeps(otherInvoiceFake)
    ),
    (error) => error.statusCode === 409
  );
});

test('legacy partial callback without a raw baseline fails closed', async () => {
  const legacyPayload = buildCallbackPayload({
    reference: undefined,
    publicId: PAYGATE_FIXTURE.legacyPublicId,
    coin: 'polygon_pol',
    value_coin: '2.00'
  });

  for (const rawBaseline of [null, 0]) {
    const fake = createFakeVipInvoicePool([
      makePaygateInvoice({
        status: 'partial_payment',
        paygate_callback_reference: null,
        amount_crypto_received: rawBaseline,
        paygate_paid_coin: 'polygon_pol',
        paygate_paid_value: 3,
        paygate_paid_txid_in: PAYGATE_FIXTURE.txidIn,
        paygate_paid_txid: PAYGATE_FIXTURE.txidOut
      })
    ]);
    const before = fake.getInvoice(51);
    const deps = makeCallbackDeps(fake, {
      paygateClient: {
        async convertPaymentToUsd() {
          return 5;
        }
      }
    });

    await assert.rejects(
      handlePaygateCallback(fake.pool, legacyPayload, deps),
      (error) => (
        error.message === 'Callback PayGate invalide'
        && error.code === 'PAYGATE_PAYMENT_BASELINE_MISSING'
        && error.statusCode === 409
      )
    );

    assert.deepEqual(fake.getInvoice(51), before);
    assert.equal(fake.stats.updates, 0);
    assert.equal(fake.events.length, 0);
    assert.equal(deps.getDeliveryCount(), 0);
  }
});

test('legacy paid callback without a raw baseline retries delivery', async () => {
  const legacyPayload = buildCallbackPayload({
    reference: undefined,
    publicId: PAYGATE_FIXTURE.legacyPublicId
  });

  for (const rawBaseline of [null, 0]) {
    const fake = createFakeVipInvoicePool([
      makePaygateInvoice({
        status: 'paid',
        paygate_callback_reference: null,
        amount_crypto_received: rawBaseline,
        paygate_paid_coin: 'polygon_usdc',
        paygate_paid_value: 5,
        paygate_paid_txid_in: PAYGATE_FIXTURE.txidIn,
        paygate_paid_txid: PAYGATE_FIXTURE.txidOut
      })
    ]);
    const deps = makeCallbackDeps(fake);

    const result = await handlePaygateCallback(fake.pool, legacyPayload, deps);

    assert.equal(result.status, 'delivered');
    assert.equal(fake.getInvoice(51).status, 'delivered');
    assert.equal(fake.getInvoice(51).amount_crypto_received, rawBaseline);
    assert.equal(fake.getInvoice(51).paygate_paid_value, 5);
    assert.equal(fake.stats.updates, 0);
    assert.equal(fake.events.length, 0);
    assert.equal(deps.getDeliveryCount(), 1);
  }
});

test('legacy publicId callback is accepted only when callback reference is NULL', async () => {
  const legacyPayload = buildCallbackPayload({
    reference: undefined,
    publicId: PAYGATE_FIXTURE.legacyPublicId
  });
  const legacyFake = createFakeVipInvoicePool([
    makePaygateInvoice({ paygate_callback_reference: null })
  ]);
  await assert.doesNotReject(handlePaygateCallback(
    legacyFake.pool,
    legacyPayload,
    makeCallbackDeps(legacyFake)
  ));

  const newFake = createFakeVipInvoicePool([makePaygateInvoice()]);
  await assert.rejects(
    handlePaygateCallback(newFake.pool, legacyPayload, makeCallbackDeps(newFake)),
    (error) => error.statusCode === 403
  );
});

test('concurrent sufficient and partial callbacks end delivered exactly once', async (t) => {
  setEnv(t, { VIP_PAYGATE_MIN_PAID_RATIO: '0.60' });
  const fake = createFakeVipInvoicePool([makePaygateInvoice()]);
  const deps = makeCallbackDeps(fake);
  await Promise.all([
    handlePaygateCallback(fake.pool, buildCallbackPayload({
      value_coin: '5.00',
      value_forwarded_coin: '4.90'
    }), deps),
    handlePaygateCallback(fake.pool, buildCallbackPayload({
      value_coin: '3.00',
      value_forwarded_coin: '2.90'
    }), deps)
  ]);

  assert.equal(fake.getInvoice(51).status, 'delivered');
  assert.equal(fake.getInvoice(51).paygate_paid_value, 5);
  assert.equal(deps.getDeliveryCount(), 1);
});

test('admin cancellation cannot race a paid invoice back to cancelled', async () => {
  const fake = createFakeVipInvoicePool([
    makePaygateInvoice({ status: 'paid' })
  ]);
  await assert.rejects(
    cancelInvoice(fake.pool, 51, { userId: 'admin-1' }),
    /déjà payée ou livrée/
  );
  assert.equal(fake.getInvoice(51).status, 'paid');
});

test('public PayGate refresh never calls payment-status.php', async () => {
  const invoice = makePaygateInvoice({
    paygate_ipn_token: PAYGATE_FIXTURE.ipnTokenEncoded,
    expires_at: new Date(Date.now() + 60_000)
  });
  const fake = createFakeVipInvoicePool([invoice]);
  const fetchPaymentStatus = mock.fn(async () => ({ status: 'unpaid' }));

  await refreshInvoiceStatus(fake.pool, invoice, {
    actorType: 'system',
    actorId: invoice.public_id,
    paygateClient: { fetchPaymentStatus }
  });

  assert.equal(fetchPaymentStatus.mock.callCount(), 0);
  assert.equal(fake.getInvoice(invoice.id).status, 'awaiting_payment');
});

test('admin reconciliation without IPN token or on final invoice makes no external call', async () => {
  const fetchPaymentStatus = mock.fn(async () => ({ status: 'unpaid' }));
  for (const invoice of [
    makePaygateInvoice({ paygate_ipn_token: null }),
    makePaygateInvoice({ status: 'delivered', paygate_ipn_token: PAYGATE_FIXTURE.ipnTokenRaw }),
    makePaygateInvoice({ status: 'cancelled', paygate_ipn_token: PAYGATE_FIXTURE.ipnTokenRaw })
  ]) {
    const fake = createFakeVipInvoicePool([invoice]);
    await refreshInvoiceStatus(fake.pool, invoice, {
      allowPaygateReconciliation: true,
      actorType: 'admin',
      actorId: 'admin-1',
      paygateClient: { fetchPaymentStatus }
    });
  }
  assert.equal(fetchPaymentStatus.mock.callCount(), 0);
});

test('admin unpaid reconciliation calls PayGate once, changes no status, and is audited', async () => {
  const invoice = makePaygateInvoice({
    paygate_ipn_token: PAYGATE_FIXTURE.ipnTokenEncoded,
    expires_at: new Date(Date.now() + 60_000)
  });
  const fake = createFakeVipInvoicePool([invoice]);
  const fetchPaymentStatus = mock.fn(async () => ({ status: 'unpaid' }));

  await refreshInvoiceStatus(fake.pool, invoice, {
    allowPaygateReconciliation: true,
    actorType: 'admin',
    actorId: 'admin-1',
    paygateClient: { fetchPaymentStatus }
  });

  assert.equal(fetchPaymentStatus.mock.callCount(), 1);
  assert.equal(fetchPaymentStatus.mock.calls[0].arguments[0], PAYGATE_FIXTURE.ipnTokenEncoded);
  assert.equal(fake.getInvoice(invoice.id).status, 'awaiting_payment');
  assert.equal(fake.events.at(-1).eventType, 'invoice_paygate_admin_reconciliation_unpaid');
  assert.equal(fake.events.at(-1).actorType, 'admin');
});

test('stale unpaid reconciliation does not audit an invoice delivered during the PayGate request', async () => {
  const invoice = makePaygateInvoice({
    paygate_ipn_token: PAYGATE_FIXTURE.ipnTokenEncoded
  });
  const fake = createFakeVipInvoicePool([invoice]);
  const fetchPaymentStatus = mock.fn(async () => {
    fake.mutateInvoice(invoice.id, {
      status: 'delivered',
      vip_key_value: 'VIP-CONCURRENT'
    });
    return { status: 'unpaid' };
  });

  const result = await refreshInvoiceStatus(fake.pool, invoice, {
    allowPaygateReconciliation: true,
    actorType: 'admin',
    actorId: 'admin-1',
    paygateClient: { fetchPaymentStatus }
  });

  assert.equal(fetchPaymentStatus.mock.callCount(), 1);
  assert.equal(result.status, 'delivered');
  assert.equal(result.vip_key_value, 'VIP-CONCURRENT');
  assert.equal(fake.events.length, 0);
});

function makePaidReconciliationClient(valueCoin) {
  return {
    async fetchPaymentStatus() {
      return {
        status: 'paid',
        coin: 'polygon_usdc',
        valueCoin,
        txidOut: PAYGATE_FIXTURE.txidOut
      };
    },
    async convertPaymentToUsd(payment) {
      return payment.valueCoin;
    }
  };
}

test('explicit admin reconciliation rejects every invalid stored PayGate USD amount without mutation', async (t) => {
  for (const invalidAmount of INVALID_STORED_PAYGATE_AMOUNTS) {
    for (const reportedStatus of ['paid', 'unpaid']) {
      await t.test(`${invalidAmount.name}/${reportedStatus}`, async () => {
        const invoice = makePaygateInvoice({
          amount_usd: invalidAmount.value,
          paygate_ipn_token: PAYGATE_FIXTURE.ipnTokenEncoded
        });
        const fake = createFakeVipInvoicePool([invoice]);
        const before = fake.getInvoice(invoice.id);
        const deps = makeCallbackDeps(fake, {
          paygateClient: reportedStatus === 'paid'
            ? makePaidReconciliationClient(5)
            : {
              async fetchPaymentStatus() {
                return { status: 'unpaid' };
              }
            }
        });

        await assert.rejects(
          refreshInvoiceStatus(fake.pool, invoice, {
            allowPaygateReconciliation: true,
            actorType: 'admin',
            actorId: 'admin-1',
            paygateClient: deps.paygateClient,
            deliverInvoice: deps.deliverInvoice
          }),
          isStoredPaygateAmountError
        );

        assert.deepEqual(fake.getInvoice(invoice.id), before);
        assert.equal(fake.stats.updates, 0);
        assert.equal(fake.stats.identityUpdates, 0);
        assert.equal(fake.events.length, 0);
        assert.equal(deps.getDeliveryCount(), 0);
      });
    }
  }
});

test('admin paid reconciliation reuses the monotonic transition without inventing txid_in', async (t) => {
  setEnv(t, { VIP_PAYGATE_MIN_PAID_RATIO: '0.60' });
  const invoice = makePaygateInvoice({
    paygate_ipn_token: PAYGATE_FIXTURE.ipnTokenEncoded
  });
  const fake = createFakeVipInvoicePool([invoice]);
  const deps = makeCallbackDeps(fake, {
    paygateClient: {
      async fetchPaymentStatus() {
        return {
          status: 'paid',
          coin: 'polygon_usdc',
          valueCoin: 4.56,
          txidOut: PAYGATE_FIXTURE.txidOut
        };
      },
      async convertPaymentToUsd(payment) {
        return payment.valueCoin;
      }
    }
  });

  await refreshInvoiceStatus(fake.pool, invoice, {
    allowPaygateReconciliation: true,
    actorType: 'admin',
    actorId: 'admin-1',
    paygateClient: deps.paygateClient,
    deliverInvoice: deps.deliverInvoice
  });

  const refreshed = fake.getInvoice(invoice.id);
  assert.equal(refreshed.status, 'delivered');
  assert.equal(refreshed.paygate_paid_txid_in, null);
  assert.equal(refreshed.paygate_paid_txid, PAYGATE_FIXTURE.txidOut);
  assert.equal(fake.events[0].eventType, 'invoice_paygate_admin_reconciliation_paid');
  assert.equal(deps.getDeliveryCount(), 1);
});

test('callback enriches an admin-reconciled partial payment exactly once without repricing', async (t) => {
  setEnv(t, { VIP_PAYGATE_MIN_PAID_RATIO: '0.60' });
  const invoice = makePaygateInvoice({
    paygate_ipn_token: PAYGATE_FIXTURE.ipnTokenEncoded
  });
  const fake = createFakeVipInvoicePool([invoice]);

  await refreshInvoiceStatus(fake.pool, invoice, {
    allowPaygateReconciliation: true,
    actorType: 'admin',
    actorId: 'admin-1',
    paygateClient: makePaidReconciliationClient(3)
  });
  const reconciled = fake.getInvoice(invoice.id);
  const eventsAfterReconciliation = fake.events.length;
  const updatesAfterReconciliation = fake.stats.updates;
  assert.equal(reconciled.status, 'partial_payment');
  assert.equal(reconciled.paygate_paid_txid_in, null);

  const convertPaymentToUsd = mock.fn(async () => {
    throw new Error('exact replay must not request pricing');
  });
  const callbackDeps = makeCallbackDeps(fake, {
    paygateClient: { convertPaymentToUsd }
  });
  const payload = buildCallbackPayload({ value_coin: '3.00' });
  await handlePaygateCallback(fake.pool, payload, callbackDeps);
  await handlePaygateCallback(fake.pool, payload, callbackDeps);

  const enriched = fake.getInvoice(invoice.id);
  assert.equal(convertPaymentToUsd.mock.callCount(), 0);
  assert.equal(enriched.paygate_paid_txid_in, PAYGATE_FIXTURE.txidIn);
  assert.equal(enriched.status, reconciled.status);
  assert.equal(enriched.paygate_paid_value, reconciled.paygate_paid_value);
  assert.equal(enriched.amount_crypto_received, reconciled.amount_crypto_received);
  assert.equal(enriched.paid_at, reconciled.paid_at);
  assert.equal(fake.stats.identityUpdates, 1);
  assert.equal(fake.stats.updates, updatesAfterReconciliation);
  assert.equal(fake.events.length, eventsAfterReconciliation);
  assert.equal(callbackDeps.getDeliveryCount(), 0);
});

test('callback enriches an admin-reconciled paid invoice and retries delivery without repricing', async (t) => {
  setEnv(t, { VIP_PAYGATE_MIN_PAID_RATIO: '0.60' });
  const invoice = makePaygateInvoice({
    paygate_ipn_token: PAYGATE_FIXTURE.ipnTokenEncoded
  });
  const fake = createFakeVipInvoicePool([invoice]);
  const keepPaid = mock.fn(async () => fake.getInvoice(invoice.id));

  await refreshInvoiceStatus(fake.pool, invoice, {
    allowPaygateReconciliation: true,
    actorType: 'admin',
    actorId: 'admin-1',
    paygateClient: makePaidReconciliationClient(4.56),
    deliverInvoice: keepPaid
  });
  const reconciled = fake.getInvoice(invoice.id);
  const eventsAfterReconciliation = fake.events.length;
  const updatesAfterReconciliation = fake.stats.updates;
  assert.equal(reconciled.status, 'paid');
  assert.equal(reconciled.paygate_paid_txid_in, null);

  const convertPaymentToUsd = mock.fn(async () => {
    throw new Error('paid recovery must not request pricing');
  });
  const retryDelivery = mock.fn(async () => fake.getInvoice(invoice.id));
  await handlePaygateCallback(
    fake.pool,
    buildCallbackPayload({ value_coin: '4.56' }),
    {
      paygateClient: { convertPaymentToUsd },
      deliverInvoice: retryDelivery
    }
  );

  const enriched = fake.getInvoice(invoice.id);
  assert.equal(convertPaymentToUsd.mock.callCount(), 0);
  assert.equal(retryDelivery.mock.callCount(), 1);
  assert.equal(enriched.paygate_paid_txid_in, PAYGATE_FIXTURE.txidIn);
  assert.equal(enriched.status, reconciled.status);
  assert.equal(enriched.paygate_paid_value, reconciled.paygate_paid_value);
  assert.equal(enriched.amount_crypto_received, reconciled.amount_crypto_received);
  assert.deepEqual(enriched.paid_at, reconciled.paid_at);
  assert.equal(fake.stats.identityUpdates, 1);
  assert.equal(fake.stats.updates, updatesAfterReconciliation);
  assert.equal(fake.events.length, eventsAfterReconciliation);
});

test('callback enriches an admin-reconciled delivered invoice without repricing or redelivery', async (t) => {
  setEnv(t, { VIP_PAYGATE_MIN_PAID_RATIO: '0.60' });
  const invoice = makePaygateInvoice({
    paygate_ipn_token: PAYGATE_FIXTURE.ipnTokenEncoded
  });
  const fake = createFakeVipInvoicePool([invoice]);
  const reconciliationDeps = makeCallbackDeps(fake, {
    paygateClient: makePaidReconciliationClient(4.56)
  });

  await refreshInvoiceStatus(fake.pool, invoice, {
    allowPaygateReconciliation: true,
    actorType: 'admin',
    actorId: 'admin-1',
    paygateClient: reconciliationDeps.paygateClient,
    deliverInvoice: reconciliationDeps.deliverInvoice
  });
  const reconciled = fake.getInvoice(invoice.id);
  const eventsAfterReconciliation = fake.events.length;
  const updatesAfterReconciliation = fake.stats.updates;
  assert.equal(reconciled.status, 'delivered');
  assert.equal(reconciled.paygate_paid_txid_in, null);

  const convertPaymentToUsd = mock.fn(async () => {
    throw new Error('delivered callback must not request pricing');
  });
  const retryDelivery = mock.fn(async () => fake.getInvoice(invoice.id));
  await handlePaygateCallback(
    fake.pool,
    buildCallbackPayload({ value_coin: '4.56' }),
    {
      paygateClient: { convertPaymentToUsd },
      deliverInvoice: retryDelivery
    }
  );

  const enriched = fake.getInvoice(invoice.id);
  assert.equal(convertPaymentToUsd.mock.callCount(), 0);
  assert.equal(retryDelivery.mock.callCount(), 0);
  assert.equal(enriched.paygate_paid_txid_in, PAYGATE_FIXTURE.txidIn);
  assert.equal(enriched.status, reconciled.status);
  assert.equal(enriched.paygate_paid_value, reconciled.paygate_paid_value);
  assert.equal(enriched.amount_crypto_received, reconciled.amount_crypto_received);
  assert.deepEqual(enriched.paid_at, reconciled.paid_at);
  assert.equal(fake.stats.identityUpdates, 1);
  assert.equal(fake.stats.updates, updatesAfterReconciliation);
  assert.equal(fake.events.length, eventsAfterReconciliation);
});

test('callback enrichment rejects an inbound transaction already owned by another invoice', async () => {
  const fake = createFakeVipInvoicePool([
    makePaygateInvoice({
      status: 'delivered',
      amount_crypto_received: 5,
      paygate_paid_coin: 'polygon_usdc',
      paygate_paid_value: 5,
      paygate_paid_txid_in: null,
      paygate_paid_txid: PAYGATE_FIXTURE.txidOut,
      vip_key_value: 'VIP-TEST'
    }),
    makePaygateInvoice({
      id: 52,
      public_id: 'inv_aaaaaaaaaaaaaaaaaaaaaaaa',
      paygate_callback_reference: 'b'.repeat(48),
      paygate_paid_txid_in: PAYGATE_FIXTURE.txidIn
    })
  ]);
  const convertPaymentToUsd = mock.fn(async () => 5);

  await assert.rejects(
    handlePaygateCallback(
      fake.pool,
      buildCallbackPayload({ value_coin: '5.00' }),
      { paygateClient: { convertPaymentToUsd } }
    ),
    (error) => error.code === 'PAYGATE_TXID_ALREADY_USED' && error.statusCode === 409
  );
  assert.equal(convertPaymentToUsd.mock.callCount(), 0);
  assert.equal(fake.getInvoice(51).paygate_paid_txid_in, null);
  assert.equal(fake.stats.identityUpdates, 0);
});

test('callback enrichment maps a duplicate-key claim race to the generic conflict', async () => {
  const duplicate = new Error('Duplicate entry');
  duplicate.code = 'ER_DUP_ENTRY';
  duplicate.errno = 1062;
  const fake = createFakeVipInvoicePool([
    makePaygateInvoice({
      status: 'partial_payment',
      amount_crypto_received: 3,
      paygate_paid_coin: 'polygon_usdc',
      paygate_paid_value: 3,
      paygate_paid_txid_in: null,
      paygate_paid_txid: PAYGATE_FIXTURE.txidOut
    })
  ], { failTxidClaim: duplicate });

  await assert.rejects(
    handlePaygateCallback(
      fake.pool,
      buildCallbackPayload({ value_coin: '3.00' }),
      { paygateClient: { async convertPaymentToUsd() { return 3; } } }
    ),
    (error) => (
      error.message === 'Callback PayGate invalide'
      && error.code === 'PAYGATE_TXID_ALREADY_USED'
      && error.statusCode === 409
    )
  );
  assert.equal(fake.getInvoice(51).paygate_paid_txid_in, null);
  assert.equal(fake.stats.identityUpdates, 0);
});

test('cancelled callback neither enriches identity nor requests pricing', async () => {
  const fake = createFakeVipInvoicePool([
    makePaygateInvoice({
      status: 'cancelled',
      paygate_paid_txid_in: null
    })
  ]);
  const convertPaymentToUsd = mock.fn(async () => {
    throw new Error('cancelled callback must not request pricing');
  });

  const result = await handlePaygateCallback(
    fake.pool,
    buildCallbackPayload(),
    { paygateClient: { convertPaymentToUsd } }
  );

  assert.equal(result.status, 'cancelled');
  assert.equal(convertPaymentToUsd.mock.callCount(), 0);
  assert.equal(fake.getInvoice(51).paygate_paid_txid_in, null);
  assert.equal(fake.stats.identityUpdates, 0);
  assert.equal(fake.stats.updates, 0);
  assert.equal(fake.events.length, 0);
});

test('a locally paid invoice is delivered without another PayGate status call', async () => {
  const invoice = makePaygateInvoice({
    status: 'paid',
    paygate_ipn_token: PAYGATE_FIXTURE.ipnTokenEncoded
  });
  const fake = createFakeVipInvoicePool([invoice]);
  const fetchPaymentStatus = mock.fn(async () => ({ status: 'unpaid' }));

  await refreshInvoiceStatus(fake.pool, invoice, {
    allowPaygateReconciliation: true,
    paygateClient: { fetchPaymentStatus }
  });

  assert.equal(fetchPaymentStatus.mock.callCount(), 0);
  assert.equal(fake.getInvoice(invoice.id).status, 'delivered');
  assert.match(fake.getInvoice(invoice.id).vip_key_value, /^VIP-[A-F0-9]{16}$/);
  assert.equal(fake.events.at(-1).eventType, 'invoice_delivered');
});

test('local paid recovery rejects every invalid stored PayGate USD amount before delivery', async (t) => {
  for (const invalidAmount of INVALID_STORED_PAYGATE_AMOUNTS) {
    await t.test(invalidAmount.name, async () => {
      const invoice = makePaygateInvoice({
        amount_usd: invalidAmount.value,
        status: 'paid',
        paygate_ipn_token: PAYGATE_FIXTURE.ipnTokenEncoded,
        amount_crypto_received: 5,
        paygate_paid_coin: 'polygon_usdc',
        paygate_paid_value: 5,
        paygate_paid_txid_in: PAYGATE_FIXTURE.txidIn,
        paygate_paid_txid: PAYGATE_FIXTURE.txidOut,
        paid_at: new Date('2026-07-28T12:30:00Z')
      });
      const fake = createFakeVipInvoicePool([invoice]);
      const before = fake.getInvoice(invoice.id);
      const fetchPaymentStatus = mock.fn(async () => ({ status: 'unpaid' }));

      await assert.rejects(
        refreshInvoiceStatus(fake.pool, invoice, {
          allowPaygateReconciliation: true,
          paygateClient: { fetchPaymentStatus }
        }),
        isStoredPaygateAmountError
      );

      assert.deepEqual(fake.getInvoice(invoice.id), before);
      assert.equal(fake.stats.updates, 0);
      assert.equal(fake.stats.identityUpdates, 0);
      assert.equal(fake.events.length, 0);
      assert.equal(fetchPaymentStatus.mock.callCount(), 0);
      assert.equal(
        fake.calls.some(({ sql }) => /access_keys|status = 'delivered'/i.test(sql)),
        false
      );
    });
  }
});

test('manual admin validation rejects an invalid stored PayGate USD amount before mutation', async () => {
  const invoice = makePaygateInvoice({ amount_usd: 0 });
  const fake = createFakeVipInvoicePool([invoice]);
  const before = fake.getInvoice(invoice.id);

  await assert.rejects(
    forceValidateInvoice(fake.pool, invoice.id, { userId: 'admin-1' }),
    isStoredPaygateAmountError
  );

  assert.deepEqual(fake.getInvoice(invoice.id), before);
  assert.equal(fake.stats.updates, 0);
  assert.equal(fake.stats.identityUpdates, 0);
  assert.equal(fake.events.length, 0);
  assert.equal(
    fake.calls.some(({ sql }) => /access_keys|status = 'delivered'/i.test(sql)),
    false
  );
});
