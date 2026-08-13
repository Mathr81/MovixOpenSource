'use strict';

const PAYGATE_FIXTURE = Object.freeze({
  callbackReference: 'a7c19e204d6b8f319e02ab74c5d6810f3a9b27e46c50d812',
  callbackNonce: 'f18a3c72b509de647a20c1e9d35f8b0642e7a19c8d50bf23',
  legacyPublicId: 'inv_4f71e928c3a65d0b82419fe7',
  settlementWallet: '0x8A7c21D4E5f60718293A4B5c6D7e8F9012a3B4C5',
  temporaryWallet: '0x71A20D9e8f6C4b3A2190eD8c7B6a5F43210E9dCb',
  addressInRaw: 'mV7w0V9mE/3zKj+Q2aBpYg==',
  addressInEncoded: 'mV7w0V9mE%2F3zKj%2BQ2aBpYg%3D%3D',
  ipnTokenRaw: 'Zk4b3Q/8ab+R19X==',
  ipnTokenEncoded: 'Zk4b3Q%2F8ab%2BR19X%3D%3D',
  txidIn: '0x4f9c2a107b6d3e819a20c5f4e8b7310d2c6a9f501e4d8b73a0c5296fd1b8473e',
  txidOut: '0xa12d4f709b3e6c815d20a7f4c8e1390b6a2d5f718e4c3b90d1a6275fb8e0439c'
});

function buildCallbackUrl(overrides = {}) {
  const reference = overrides.reference || PAYGATE_FIXTURE.callbackReference;
  const nonce = overrides.nonce || PAYGATE_FIXTURE.callbackNonce;
  return `https://api.movix.example/api/vip/paygate/callback?reference=${reference}&nonce=${nonce}`;
}

function buildWalletPayload(overrides = {}) {
  return {
    address_in: PAYGATE_FIXTURE.addressInEncoded,
    polygon_address_in: PAYGATE_FIXTURE.temporaryWallet,
    callback_url: buildCallbackUrl(),
    ipn_token: PAYGATE_FIXTURE.ipnTokenEncoded,
    ...overrides
  };
}

function buildCallbackPayload(overrides = {}) {
  return {
    reference: PAYGATE_FIXTURE.callbackReference,
    nonce: PAYGATE_FIXTURE.callbackNonce,
    coin: 'polygon_usdc',
    value_coin: '7.60',
    txid_in: PAYGATE_FIXTURE.txidIn,
    txid_out: PAYGATE_FIXTURE.txidOut,
    address_in: PAYGATE_FIXTURE.temporaryWallet.toLowerCase(),
    value_forwarded_coin: '7.486',
    ...overrides
  };
}

module.exports = {
  PAYGATE_FIXTURE,
  buildCallbackUrl,
  buildWalletPayload,
  buildCallbackPayload
};
