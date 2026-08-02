'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const {
  PAYGATE_FIXTURE,
  buildCallbackUrl,
  buildWalletPayload,
  buildCallbackPayload
} = require('./fixtures/paygateFixtures');

const paygate = require('../vipPaygate');

test('opaque values: encoded and decoded inputs produce one canonical query layer', () => {
  assert.equal(
    paygate.normalizePaygateOpaqueValue(PAYGATE_FIXTURE.ipnTokenEncoded, 'ipn_token'),
    PAYGATE_FIXTURE.ipnTokenRaw
  );
  assert.equal(
    paygate.normalizePaygateOpaqueValue(PAYGATE_FIXTURE.ipnTokenRaw, 'ipn_token'),
    PAYGATE_FIXTURE.ipnTokenRaw
  );

  const encoded = new URLSearchParams();
  const decoded = new URLSearchParams();
  paygate.setOpaqueQueryParam(encoded, 'ipn_token', PAYGATE_FIXTURE.ipnTokenEncoded);
  paygate.setOpaqueQueryParam(decoded, 'ipn_token', PAYGATE_FIXTURE.ipnTokenRaw);

  assert.equal(encoded.toString(), decoded.toString());
  assert.equal(encoded.get('ipn_token'), PAYGATE_FIXTURE.ipnTokenRaw);
  assert.equal(encoded.toString().includes('%252F'), false);
  assert.match(encoded.toString(), /%2F/);
  assert.match(encoded.toString(), /%2B/);
  assert.match(encoded.toString(), /%3D/);
});

test('opaque values: malformed, ambiguous, missing, and non-scalar values fail closed', () => {
  for (const value of ['%', '%2', '%2G', '%GG', 'abc%252Fdef', '', '   ', null, undefined, [], {}]) {
    assert.throws(
      () => paygate.normalizePaygateOpaqueValue(value, 'ipn_token'),
      (error) => error.code === 'PAYGATE_OPAQUE_VALUE_INVALID'
    );
  }
});

test('opaque values: raw plus is preserved as plus, never converted to a space', () => {
  const params = new URLSearchParams();
  paygate.setOpaqueQueryParam(params, 'token', 'abc+def=');
  assert.equal(params.get('token'), 'abc+def=');
  assert.match(params.toString(), /abc%2Bdef%3D/);
});

test('nonce comparison is safe for equal, unequal, and unequal-length strings', () => {
  assert.equal(
    paygate.safeComparePaygateNonce(PAYGATE_FIXTURE.callbackNonce, PAYGATE_FIXTURE.callbackNonce),
    true
  );
  assert.equal(
    paygate.safeComparePaygateNonce(PAYGATE_FIXTURE.callbackNonce, `${PAYGATE_FIXTURE.callbackNonce}00`), false);
  assert.equal(paygate.safeComparePaygateNonce(PAYGATE_FIXTURE.callbackNonce, []), false);
});

test('callback URL contains only the gateway reference and nonce', () => {
  const result = paygate.buildPaygateCallbackUrl({
    baseUrl: 'https://api.movix.example',
    reference: PAYGATE_FIXTURE.callbackReference,
    nonce: PAYGATE_FIXTURE.callbackNonce,
    requireHttps: true
  });
  const url = new URL(result);
  assert.equal(url.origin, 'https://api.movix.example');
  assert.equal(url.pathname, '/api/vip/paygate/callback');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['nonce', 'reference']);
  assert.equal(url.searchParams.get('reference'), PAYGATE_FIXTURE.callbackReference);
  assert.equal(url.searchParams.get('nonce'), PAYGATE_FIXTURE.callbackNonce);
  assert.equal(url.searchParams.has('publicId'), false);
});

test('production callback base rejects HTTP, paths, credentials, query, and fragments', () => {
  for (const baseUrl of [
    'http://api.movix.example',
    'https://api.movix.example/base',
    'https://user:pass@api.movix.example',
    'https://api.movix.example?x=1',
    'https://api.movix.example#fragment'
  ]) {
    assert.throws(
      () => paygate.buildPaygateCallbackUrl({
        baseUrl,
        reference: PAYGATE_FIXTURE.callbackReference,
        nonce: PAYGATE_FIXTURE.callbackNonce,
        requireHttps: true
      }),
      paygate.PaygateProtocolError
    );
  }
});

test('hosted checkout encodes opaque address, email, amount, and branding exactly once', () => {
  const input = {
    checkoutAddress: PAYGATE_FIXTURE.addressInEncoded,
    amountEur: 7,
    payerEmail: 'payer+vip@example.test',
    branding: {
      logo: 'https://cdn.movix.example/paygate logo.png',
      background: '#0A0A0A',
      theme: '#FBBF24',
      button: '#EAB308'
    }
  };
  const encodedUrl = paygate.buildPaygateCheckoutUrl(input);
  const decodedUrl = paygate.buildPaygateCheckoutUrl({
    ...input,
    checkoutAddress: PAYGATE_FIXTURE.addressInRaw
  });

  assert.equal(encodedUrl, decodedUrl);
  const url = new URL(encodedUrl);
  assert.equal(url.origin, 'https://checkout.paygate.to');
  assert.equal(url.pathname, '/pay.php');
  assert.equal(url.searchParams.get('address'), PAYGATE_FIXTURE.addressInRaw);
  assert.equal(url.searchParams.get('amount'), '7.00');
  assert.equal(url.searchParams.get('email'), 'payer+vip@example.test');
  assert.equal(url.searchParams.get('currency'), 'EUR');
  assert.equal(url.searchParams.get('logo'), input.branding.logo);
  assert.equal(url.searchParams.get('background'), input.branding.background);
  assert.equal(url.searchParams.has('provider'), false);
  assert.equal(url.search.includes('%252F'), false);
});

test('wallet response is normalized only when every binding field is valid', () => {
  const parsed = paygate.parsePaygateWalletResponse(
    buildWalletPayload(),
    buildCallbackUrl()
  );
  assert.deepEqual(parsed, {
    checkoutAddress: PAYGATE_FIXTURE.addressInRaw,
    temporaryWalletAddress: PAYGATE_FIXTURE.temporaryWallet,
    callbackUrl: paygate.canonicalizeCallbackUrl(buildCallbackUrl()),
    ipnToken: PAYGATE_FIXTURE.ipnTokenRaw
  });

  const reversed = new URL(buildCallbackUrl());
  reversed.search = `?nonce=${PAYGATE_FIXTURE.callbackNonce}&reference=${PAYGATE_FIXTURE.callbackReference}`;
  assert.doesNotThrow(() => paygate.parsePaygateWalletResponse(
    buildWalletPayload({ callback_url: reversed.toString() }),
    buildCallbackUrl()
  ));
});

test('wallet response rejects missing fields, invalid EVM address, callback mismatch, and duplicate params', () => {
  const invalidPayloads = [
    buildWalletPayload({ address_in: '' }),
    buildWalletPayload({ polygon_address_in: 'not-an-address' }),
    buildWalletPayload({ callback_url: '' }),
    buildWalletPayload({ callback_url: buildCallbackUrl({ nonce: '0'.repeat(48) }) }),
    buildWalletPayload({ callback_url: `${buildCallbackUrl()}&nonce=${PAYGATE_FIXTURE.callbackNonce}` }),
    buildWalletPayload({ ipn_token: '' })
  ];

  for (const payload of invalidPayloads) {
    assert.throws(
      () => paygate.parsePaygateWalletResponse(payload, buildCallbackUrl()),
      paygate.PaygateProtocolError
    );
  }
});

test('callback URL canonicalization rejects malformed percent query values', () => {
  assert.throws(
    () => paygate.canonicalizeCallbackUrl(`${buildCallbackUrl()}&token=%`),
    paygate.PaygateProtocolError
  );
});

test('callback URL canonicalization rejects double-encoded query values', () => {
  assert.throws(
    () => paygate.canonicalizeCallbackUrl(`${buildCallbackUrl()}&token=%252F`),
    paygate.PaygateProtocolError
  );
});

test('callback URL canonicalization preserves raw plus query values', () => {
  const result = paygate.canonicalizeCallbackUrl(`${buildCallbackUrl()}&token=raw+plus`);
  assert.match(new URL(result).search, /token=raw%2Bplus/);
});

test('callback payload normalizes the documented card fields', () => {
  const result = paygate.parsePaygateCallbackPayload(buildCallbackPayload({
    coin: ' POLYGON_USDC ',
    address_in: PAYGATE_FIXTURE.temporaryWallet.toLowerCase()
  }));
  assert.deepEqual(result, {
    reference: PAYGATE_FIXTURE.callbackReference,
    publicId: null,
    nonce: PAYGATE_FIXTURE.callbackNonce,
    coin: 'polygon_usdc',
    valueCoin: 7.6,
    valueForwardedCoin: 7.486,
    txidIn: PAYGATE_FIXTURE.txidIn,
    txidOut: PAYGATE_FIXTURE.txidOut,
    addressIn: PAYGATE_FIXTURE.temporaryWallet.toLowerCase()
  });
});

test('callback payload rejects transfer legs that collapse to the same transaction ID', () => {
  assert.throws(
    () => paygate.parsePaygateCallbackPayload(buildCallbackPayload({
      txid_out: `0x${PAYGATE_FIXTURE.txidIn.slice(2).toUpperCase()}`
    })),
    (error) => error.code === 'PAYGATE_CALLBACK_TX_DUPLICATE'
  );
});

test('callback payload accepts legacy publicId but rejects ambiguous or malformed identifiers', () => {
  const legacy = buildCallbackPayload({
    reference: undefined,
    publicId: PAYGATE_FIXTURE.legacyPublicId
  });
  assert.equal(paygate.parsePaygateCallbackPayload(legacy).publicId, PAYGATE_FIXTURE.legacyPublicId);

  for (const payload of [
    buildCallbackPayload({ reference: [], nonce: PAYGATE_FIXTURE.callbackNonce }),
    buildCallbackPayload({ publicId: PAYGATE_FIXTURE.legacyPublicId }),
    buildCallbackPayload({ value_coin: '0' }),
    buildCallbackPayload({ value_coin: 'Infinity' }),
    buildCallbackPayload({ coin: 'doge' }),
    buildCallbackPayload({ address_in: '0x1234' }),
    buildCallbackPayload({ txid_in: '0x1234' }),
    buildCallbackPayload({ txid_out: '0x1234' }),
    buildCallbackPayload({ value_forwarded_coin: '' })
  ]) {
    assert.throws(() => paygate.parsePaygateCallbackPayload(payload), paygate.PaygateProtocolError);
  }
});

test('six stablecoin payout identifiers remain 1:1 USD without a price call', async () => {
  const httpClient = { get: mock.fn() };
  for (const coin of paygate.STABLE_PAYOUT_COINS) {
    assert.equal(
      await paygate.convertPaygatePaymentToUsd({ coin, valueCoin: 7.6 }, { httpClient }),
      7.6
    );
  }
  assert.equal(httpClient.get.mock.callCount(), 0);
});

test('stablecoin conversion rejects a positive input that rounds to zero', async () => {
  const httpClient = { get: mock.fn() };
  await assert.rejects(
    paygate.convertPaygatePaymentToUsd(
      { coin: 'polygon_usdc', valueCoin: '0.000000001' },
      { httpClient }
    ),
    (error) => (
      error instanceof paygate.PaygateProtocolError
      && error.code === 'PAYGATE_CONVERSION_INVALID'
      && error.statusCode === 502
      && !error.message.includes('0.000000001')
    )
  );
  assert.equal(httpClient.get.mock.callCount(), 0);
});

test('native payouts require the fixed PayGate path and a positive USD price', async () => {
  const calls = [];
  const httpClient = {
    async get(url, config) {
      calls.push({ url, config });
      return { data: { prices: { USD: '0.20' } } };
    }
  };
  assert.equal(
    await paygate.convertPaygatePaymentToUsd(
      { coin: 'polygon_pol', valueCoin: 23 },
      { httpClient }
    ),
    4.6
  );
  assert.equal(calls[0].url, 'https://api.paygate.to/crypto/polygon/pol/info.php');

  const invalidPriceClient = {
    async get() {
      return { data: { prices: { USD: '0' } } };
    }
  };
  await assert.rejects(
    paygate.convertPaygatePaymentToUsd(
      { coin: 'eth', valueCoin: 1 },
      { httpClient: invalidPriceClient }
    ),
    (error) => error.code === 'PAYGATE_NATIVE_PRICE_INVALID'
  );
});

test('native conversion rejects a positive multiplication result that rounds to zero', async () => {
  const httpClient = {
    async get() {
      return { data: { prices: { USD: '0.004' } } };
    }
  };
  await assert.rejects(
    paygate.convertPaygatePaymentToUsd(
      { coin: 'eth', valueCoin: '0.000000001' },
      { httpClient }
    ),
    (error) => (
      error instanceof paygate.PaygateProtocolError
      && error.code === 'PAYGATE_NATIVE_CONVERSION_INVALID'
      && error.statusCode === 502
      && !error.message.includes('0.000000001')
    )
  );
});

test('native payouts reject finite inputs whose USD multiplication overflows', async () => {
  const httpClient = {
    async get() {
      return { data: { prices: { USD: Number.MAX_VALUE } } };
    }
  };
  await assert.rejects(
    paygate.convertPaygatePaymentToUsd(
      { coin: 'eth', valueCoin: Number.MAX_VALUE },
      { httpClient }
    ),
    (error) => error.code === 'PAYGATE_NATIVE_CONVERSION_INVALID'
  );
});

test('unknown and inherited payout identifiers fail before any network call', async () => {
  const httpClient = { get: mock.fn() };
  for (const coin of ['usdc', 'constructor', 'toString', '__proto__']) {
    await assert.rejects(
      paygate.convertPaygatePaymentToUsd({ coin, valueCoin: 7.6 }, { httpClient }),
      (error) => error.code === 'PAYGATE_COIN_UNSUPPORTED'
    );
  }
  assert.equal(httpClient.get.mock.callCount(), 0);
});

test('EUR conversion rejects a value that would be zero at invoice storage scale', async () => {
  const client = paygate.createPaygateClient({
    httpClient: {
      async get() {
        return { data: { status: 'success', value_coin: '0.004' } };
      }
    }
  });

  await assert.rejects(
    client.convertEurToUsd(7),
    (error) => (
      error instanceof paygate.PaygateProtocolError
      && error.code === 'PAYGATE_CONVERT_INVALID'
      && error.statusCode === 502
      && !error.message.includes('0.004')
    )
  );
});

test('PayGate HTTP client normalizes wallet/status tokens and validates upstream payloads', async () => {
  const calls = [];
  const httpClient = {
    async get(url, config) {
      calls.push({ url, config });
      if (url.endsWith('/convert.php')) {
        return { data: { status: 'success', value_coin: '7.60' } };
      }
      if (url.endsWith('/wallet.php')) {
        return { data: buildWalletPayload() };
      }
      return {
        data: {
          status: 'paid',
          coin: 'polygon_usdc',
          value_coin: '7.60',
          txid_out: PAYGATE_FIXTURE.txidOut
        }
      };
    }
  };
  const client = paygate.createPaygateClient({ httpClient, timeoutMs: 3210 });

  assert.equal(await client.convertEurToUsd(7), 7.6);
  assert.deepEqual(
    await client.createWallet({
      settlementWallet: PAYGATE_FIXTURE.settlementWallet,
      callbackUrl: buildCallbackUrl()
    }),
    paygate.parsePaygateWalletResponse(buildWalletPayload(), buildCallbackUrl())
  );
  assert.deepEqual(await client.fetchPaymentStatus(PAYGATE_FIXTURE.ipnTokenEncoded), {
    status: 'paid',
    coin: 'polygon_usdc',
    valueCoin: 7.6,
    txidOut: PAYGATE_FIXTURE.txidOut
  });

  const statusCall = calls.at(-1);
  assert.equal(statusCall.config.params.ipn_token, PAYGATE_FIXTURE.ipnTokenRaw);
  assert.equal(statusCall.config.timeout, 3210);
  assert.equal(
    new URLSearchParams(statusCall.config.params).toString().includes('%252F'),
    false
  );
});

test('status parser accepts only paid or unpaid and requires paid payment fields', () => {
  assert.deepEqual(paygate.parsePaygatePaymentStatus({ status: 'unpaid' }), {
    status: 'unpaid'
  });
  assert.throws(
    () => paygate.parsePaygatePaymentStatus({ status: 'pending' }),
    paygate.PaygateProtocolError
  );
  assert.throws(
    () => paygate.parsePaygatePaymentStatus({ status: 'paid', coin: 'polygon_usdc' }),
    paygate.PaygateProtocolError
  );
});
