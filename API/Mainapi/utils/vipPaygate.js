'use strict';

const crypto = require('crypto');
const axios = require('axios');

const PAYGATE_API_BASE = 'https://api.paygate.to';
const PAYGATE_DEFAULT_CHECKOUT_HOST = 'checkout.paygate.to';
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const EVM_TX_RE = /^0x[a-fA-F0-9]{64}$/;

const STABLE_PAYOUT_COINS = new Set([
  'polygon_usdc',
  'polygon_usdt',
  'bep20_usdc',
  'bep20_usdt',
  'erc20_usdc',
  'erc20_usdt'
]);

const NATIVE_PAYOUT_PATHS = Object.freeze({
  polygon_pol: 'polygon/pol',
  eth: 'eth',
  bep20_bnb: 'bep20/bnb'
});

class PaygateProtocolError extends Error {
  constructor(message, code, statusCode = 400, upstreamStatus = null) {
    super(message);
    this.name = 'PaygateProtocolError';
    this.code = code;
    this.statusCode = statusCode;
    this.upstreamStatus = upstreamStatus;
  }
}

function fail(message, code, statusCode = 400, upstreamStatus = null) {
  throw new PaygateProtocolError(message, code, statusCode, upstreamStatus);
}

function readScalarString(value, fieldName) {
  if (typeof value !== 'string') {
    fail(`${fieldName} PayGate invalide`, 'PAYGATE_FIELD_INVALID');
  }
  const normalized = value.trim();
  if (!normalized) {
    fail(`${fieldName} PayGate manquant`, 'PAYGATE_FIELD_INVALID');
  }
  return normalized;
}

function normalizePaygateOpaqueValue(value, fieldName = 'valeur opaque') {
  if (typeof value !== 'string' || !value.trim()) {
    fail(`${fieldName} PayGate invalide`, 'PAYGATE_OPAQUE_VALUE_INVALID');
  }
  const raw = value.trim();
  if (!raw.includes('%')) {
    return raw;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    fail(`${fieldName} PayGate mal encodé`, 'PAYGATE_OPAQUE_VALUE_INVALID');
  }

  if (/%[0-9a-fA-F]{2}/.test(decoded)) {
    fail(`${fieldName} PayGate doublement encodé`, 'PAYGATE_OPAQUE_VALUE_INVALID');
  }

  return decoded;
}

function setOpaqueQueryParam(searchParams, key, value) {
  searchParams.set(key, normalizePaygateOpaqueValue(value, key));
}

function safeComparePaygateNonce(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string') {
    return false;
  }
  const expectedDigest = crypto.createHash('sha256').update(expected, 'utf8').digest();
  const actualDigest = crypto.createHash('sha256').update(actual, 'utf8').digest();
  const equalDigest = crypto.timingSafeEqual(expectedDigest, actualDigest);
  return equalDigest && Buffer.byteLength(expected) === Buffer.byteLength(actual);
}

function readOptionalScalarString(value, fieldName) {
  if (value === undefined || value === null) return null;
  return readScalarString(value, fieldName);
}

function normalizeCallbackBaseUrl(value, { requireHttps = false } = {}) {
  const raw = readScalarString(value, 'callback base URL');
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail('Callback base URL PayGate invalide', 'PAYGATE_CALLBACK_BASE_INVALID');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    fail('Protocole callback PayGate invalide', 'PAYGATE_CALLBACK_BASE_INVALID');
  }
  if (requireHttps && url.protocol !== 'https:') {
    fail('HTTPS requis pour le callback PayGate', 'PAYGATE_CALLBACK_HTTPS_REQUIRED');
  }
  if (
    url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    fail('Callback base URL PayGate non canonique', 'PAYGATE_CALLBACK_BASE_INVALID');
  }

  return url.origin;
}

function parseCallbackQueryEntries(rawQuery) {
  if (!rawQuery) return [];

  const entries = [];
  const keys = new Set();
  for (const component of rawQuery.split('&')) {
    const separatorIndex = component.indexOf('=');
    const rawKey = separatorIndex === -1 ? component : component.slice(0, separatorIndex);
    const rawValue = separatorIndex === -1 ? '' : component.slice(separatorIndex + 1);
    let key;
    try {
      key = readScalarString(decodeURIComponent(rawKey), 'clé callback_url');
    } catch (error) {
      if (error instanceof PaygateProtocolError) throw error;
      fail('callback_url PayGate invalide', 'PAYGATE_CALLBACK_URL_INVALID');
    }
    if (keys.has(key)) {
      fail('callback_url PayGate ambiguë', 'PAYGATE_CALLBACK_URL_INVALID');
    }
    keys.add(key);
    entries.push([key, normalizePaygateOpaqueValue(rawValue, `valeur ${key}`)]);
  }
  return entries;
}

function canonicalizeCallbackUrl(value) {
  const raw = readScalarString(value, 'callback_url');
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail('callback_url PayGate invalide', 'PAYGATE_CALLBACK_URL_INVALID');
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    fail('callback_url PayGate invalide', 'PAYGATE_CALLBACK_URL_INVALID');
  }

  const sortedEntries = parseCallbackQueryEntries(url.search.slice(1))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => (
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
    ));
  url.search = sortedEntries
    .map(([key, itemValue]) => `${encodeURIComponent(key)}=${encodeURIComponent(itemValue)}`)
    .join('&');
  return url.toString();
}

function buildPaygateCallbackUrl({ baseUrl, reference, nonce, requireHttps = false }) {
  const normalizedBaseUrl = normalizeCallbackBaseUrl(baseUrl, { requireHttps });
  const normalizedReference = readScalarString(reference, 'reference');
  const normalizedNonce = readScalarString(nonce, 'nonce');
  if (!/^[a-f0-9]{48}$/i.test(normalizedReference)) {
    fail('Référence callback PayGate invalide', 'PAYGATE_CALLBACK_REFERENCE_INVALID');
  }
  if (!/^[a-f0-9]{48}$/i.test(normalizedNonce)) {
    fail('Nonce callback PayGate invalide', 'PAYGATE_CALLBACK_NONCE_INVALID');
  }

  const url = new URL('/api/vip/paygate/callback', normalizedBaseUrl);
  url.searchParams.set('reference', normalizedReference.toLowerCase());
  url.searchParams.set('nonce', normalizedNonce.toLowerCase());
  return url.toString();
}

function normalizeCheckoutHost(value = PAYGATE_DEFAULT_CHECKOUT_HOST) {
  const raw = readScalarString(value, 'domaine checkout')
    .replace(/^https:\/\//i, '');
  if (/[/@?#]/.test(raw)) {
    fail('Domaine checkout PayGate invalide', 'PAYGATE_CHECKOUT_HOST_INVALID');
  }
  let url;
  try {
    url = new URL(`https://${raw}`);
  } catch {
    fail('Domaine checkout PayGate invalide', 'PAYGATE_CHECKOUT_HOST_INVALID');
  }
  return url.host;
}

function buildPaygateCheckoutUrl({
  checkoutAddress,
  amountEur,
  payerEmail,
  branding = {},
  checkoutHost = PAYGATE_DEFAULT_CHECKOUT_HOST
}) {
  const numericAmount = Number(amountEur);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    fail('Montant checkout PayGate invalide', 'PAYGATE_AMOUNT_INVALID');
  }

  const email = readScalarString(payerEmail, 'email');
  const url = new URL(`https://${normalizeCheckoutHost(checkoutHost)}/pay.php`);
  setOpaqueQueryParam(url.searchParams, 'address', checkoutAddress);
  url.searchParams.set('amount', numericAmount.toFixed(2));
  url.searchParams.set('email', email);
  url.searchParams.set('currency', 'EUR');
  for (const key of ['logo', 'background', 'theme', 'button']) {
    if (typeof branding[key] === 'string' && branding[key].trim()) {
      url.searchParams.set(key, branding[key].trim());
    }
  }
  return url.toString();
}

function parsePaygateWalletResponse(payload, expectedCallbackUrl) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('Réponse wallet PayGate invalide', 'PAYGATE_WALLET_RESPONSE_INVALID', 502);
  }

  const checkoutAddress = normalizePaygateOpaqueValue(payload.address_in, 'address_in');
  const temporaryWalletAddress = readScalarString(
    payload.polygon_address_in,
    'polygon_address_in'
  );
  if (!EVM_ADDRESS_RE.test(temporaryWalletAddress)) {
    fail('Adresse temporaire PayGate invalide', 'PAYGATE_WALLET_ADDRESS_INVALID', 502);
  }

  const callbackUrl = canonicalizeCallbackUrl(payload.callback_url);
  const expected = canonicalizeCallbackUrl(expectedCallbackUrl);
  if (callbackUrl !== expected) {
    fail('Callback wallet PayGate incohérent', 'PAYGATE_WALLET_CALLBACK_MISMATCH', 502);
  }

  return {
    checkoutAddress,
    temporaryWalletAddress,
    callbackUrl,
    ipnToken: normalizePaygateOpaqueValue(payload.ipn_token, 'ipn_token')
  };
}

function parsePositiveNumber(value, fieldName) {
  if ((typeof value !== 'string' && typeof value !== 'number') || value === '') {
    fail(`${fieldName} PayGate invalide`, 'PAYGATE_AMOUNT_INVALID');
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(`${fieldName} PayGate invalide`, 'PAYGATE_AMOUNT_INVALID');
  }
  return parsed;
}

function normalizePayoutCoin(value) {
  const coin = readScalarString(value, 'coin').toLowerCase();
  if (!STABLE_PAYOUT_COINS.has(coin) && !Object.hasOwn(NATIVE_PAYOUT_PATHS, coin)) {
    fail('Coin PayGate non supporté', 'PAYGATE_COIN_UNSUPPORTED');
  }
  return coin;
}

function parsePaygateCallbackPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('Callback PayGate invalide', 'PAYGATE_CALLBACK_INVALID');
  }

  const reference = readOptionalScalarString(payload.reference, 'reference');
  const publicId = readOptionalScalarString(
    payload.publicId ?? payload.public_id,
    'publicId'
  );
  if ((reference && publicId) || (!reference && !publicId)) {
    fail('Identifiant callback PayGate invalide', 'PAYGATE_CALLBACK_IDENTIFIER_INVALID');
  }
  if (reference && !/^[a-f0-9]{48}$/i.test(reference)) {
    fail('Référence callback PayGate invalide', 'PAYGATE_CALLBACK_REFERENCE_INVALID');
  }
  if (publicId && !/^inv_[a-f0-9]{24}$/i.test(publicId)) {
    fail('publicId callback PayGate invalide', 'PAYGATE_CALLBACK_PUBLIC_ID_INVALID');
  }

  const nonce = readScalarString(payload.nonce, 'nonce');
  if (!/^[a-f0-9]{48}$/i.test(nonce)) {
    fail('Nonce callback PayGate invalide', 'PAYGATE_CALLBACK_NONCE_INVALID');
  }

  const addressIn = readScalarString(payload.address_in, 'address_in');
  const txidIn = readScalarString(payload.txid_in, 'txid_in');
  const txidOut = readScalarString(payload.txid_out, 'txid_out');
  if (!EVM_ADDRESS_RE.test(addressIn)) {
    fail('Adresse callback PayGate invalide', 'PAYGATE_CALLBACK_ADDRESS_INVALID');
  }
  if (!EVM_TX_RE.test(txidIn) || !EVM_TX_RE.test(txidOut)) {
    fail('Transaction callback PayGate invalide', 'PAYGATE_CALLBACK_TX_INVALID');
  }
  const normalizedTxidIn = txidIn.toLowerCase();
  const normalizedTxidOut = txidOut.toLowerCase();
  if (normalizedTxidIn === normalizedTxidOut) {
    fail('Transactions callback PayGate identiques', 'PAYGATE_CALLBACK_TX_DUPLICATE');
  }

  return {
    reference: reference ? reference.toLowerCase() : null,
    publicId: publicId || null,
    nonce: nonce.toLowerCase(),
    coin: normalizePayoutCoin(payload.coin),
    valueCoin: parsePositiveNumber(payload.value_coin, 'value_coin'),
    valueForwardedCoin: parsePositiveNumber(
      payload.value_forwarded_coin,
      'value_forwarded_coin'
    ),
    txidIn: normalizedTxidIn,
    txidOut: normalizedTxidOut,
    addressIn: addressIn.toLowerCase()
  };
}

function parsePaygatePaymentStatus(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('Statut PayGate invalide', 'PAYGATE_STATUS_INVALID', 502);
  }
  const status = readScalarString(payload.status, 'status').toLowerCase();
  if (status === 'unpaid') {
    return { status: 'unpaid' };
  }
  if (status !== 'paid') {
    fail('Statut PayGate inconnu', 'PAYGATE_STATUS_INVALID', 502);
  }

  const txidOut = readScalarString(payload.txid_out, 'txid_out');
  if (!EVM_TX_RE.test(txidOut)) {
    fail('Transaction statut PayGate invalide', 'PAYGATE_STATUS_TX_INVALID', 502);
  }
  return {
    status: 'paid',
    coin: normalizePayoutCoin(payload.coin),
    valueCoin: parsePositiveNumber(payload.value_coin, 'value_coin'),
    txidOut: txidOut.toLowerCase()
  };
}

function roundUsd(value, decimalPlaces = 8) {
  return Number(Number(value).toFixed(decimalPlaces));
}

function normalizeRoundedUsd(value, {
  code,
  message,
  storageDecimalPlaces = null
}) {
  let numericValue;
  try {
    numericValue = Number(value);
  } catch {
    fail(message, code, 502);
  }
  const roundedValue = roundUsd(numericValue);
  if (!Number.isFinite(roundedValue) || roundedValue <= 0) {
    fail(message, code, 502);
  }
  if (
    storageDecimalPlaces !== null
    && roundUsd(roundedValue, storageDecimalPlaces) <= 0
  ) {
    fail(message, code, 502);
  }
  return roundedValue;
}

function normalizePaygateInvoiceUsd(value) {
  return normalizeRoundedUsd(value, {
    code: 'PAYGATE_CONVERT_INVALID',
    message: 'Conversion PayGate invalide',
    storageDecimalPlaces: 2
  });
}

async function convertPaygatePaymentToUsd(payment, { httpClient = axios, timeoutMs = 15000 } = {}) {
  const coin = normalizePayoutCoin(payment?.coin);
  const valueCoin = parsePositiveNumber(payment?.valueCoin, 'value_coin');
  if (STABLE_PAYOUT_COINS.has(coin)) {
    return normalizeRoundedUsd(valueCoin, {
      code: 'PAYGATE_CONVERSION_INVALID',
      message: 'Conversion PayGate invalide'
    });
  }

  let response;
  try {
    response = await httpClient.get(
      `${PAYGATE_API_BASE}/crypto/${NATIVE_PAYOUT_PATHS[coin]}/info.php`,
      { timeout: timeoutMs }
    );
  } catch (error) {
    fail(
      'Prix natif PayGate indisponible',
      'PAYGATE_NATIVE_PRICE_UNAVAILABLE',
      503,
      error?.response?.status || null
    );
  }

  let usdPrice;
  try {
    usdPrice = parsePositiveNumber(response?.data?.prices?.USD, 'prix USD');
  } catch {
    fail('Prix natif PayGate invalide', 'PAYGATE_NATIVE_PRICE_INVALID', 502);
  }
  const usdValue = valueCoin * usdPrice;
  if (!Number.isFinite(usdValue) || usdValue <= 0) {
    fail('Conversion native PayGate invalide', 'PAYGATE_NATIVE_CONVERSION_INVALID', 502);
  }
  return normalizeRoundedUsd(usdValue, {
    code: 'PAYGATE_NATIVE_CONVERSION_INVALID',
    message: 'Conversion native PayGate invalide'
  });
}

function createPaygateClient({ httpClient = axios, timeoutMs = 15000 } = {}) {
  return {
    async convertEurToUsd(amountEur) {
      const amount = parsePositiveNumber(amountEur, 'montant EUR');
      let response;
      try {
        response = await httpClient.get(`${PAYGATE_API_BASE}/control/convert.php`, {
          params: { value: amount.toFixed(2), from: 'eur' },
          timeout: timeoutMs
        });
      } catch (error) {
        fail(
          'Conversion PayGate indisponible',
          'PAYGATE_CONVERT_UNAVAILABLE',
          503,
          error?.response?.status || null
        );
      }
      if (String(response?.data?.status || '').toLowerCase() !== 'success') {
        fail('Réponse conversion PayGate invalide', 'PAYGATE_CONVERT_INVALID', 502);
      }
      return normalizePaygateInvoiceUsd(
        parsePositiveNumber(response.data.value_coin, 'value_coin')
      );
    },

    async createWallet({ settlementWallet, callbackUrl }) {
      const wallet = readScalarString(settlementWallet, 'settlement wallet');
      if (!EVM_ADDRESS_RE.test(wallet)) {
        fail('Settlement wallet PayGate invalide', 'PAYGATE_SETTLEMENT_WALLET_INVALID', 500);
      }
      let response;
      try {
        response = await httpClient.get(`${PAYGATE_API_BASE}/control/wallet.php`, {
          params: { address: wallet, callback: callbackUrl },
          timeout: timeoutMs
        });
      } catch (error) {
        fail(
          'Création wallet PayGate indisponible',
          'PAYGATE_WALLET_UNAVAILABLE',
          503,
          error?.response?.status || null
        );
      }
      return parsePaygateWalletResponse(response?.data, callbackUrl);
    },

    async fetchPaymentStatus(ipnToken) {
      const normalizedToken = normalizePaygateOpaqueValue(ipnToken, 'ipn_token');
      let response;
      try {
        response = await httpClient.get(`${PAYGATE_API_BASE}/control/payment-status.php`, {
          params: { ipn_token: normalizedToken },
          timeout: timeoutMs
        });
      } catch (error) {
        fail(
          'Statut PayGate indisponible',
          'PAYGATE_STATUS_UNAVAILABLE',
          503,
          error?.response?.status || null
        );
      }
      return parsePaygatePaymentStatus(response?.data);
    },

    convertPaymentToUsd(payment) {
      return convertPaygatePaymentToUsd(payment, { httpClient, timeoutMs });
    }
  };
}

module.exports = {
  PAYGATE_API_BASE,
  PAYGATE_DEFAULT_CHECKOUT_HOST,
  STABLE_PAYOUT_COINS,
  NATIVE_PAYOUT_PATHS,
  EVM_ADDRESS_RE,
  EVM_TX_RE,
  PaygateProtocolError,
  normalizePaygateOpaqueValue,
  setOpaqueQueryParam,
  safeComparePaygateNonce,
  normalizeCallbackBaseUrl,
  canonicalizeCallbackUrl,
  buildPaygateCallbackUrl,
  buildPaygateCheckoutUrl,
  parsePaygateWalletResponse,
  parsePaygateCallbackPayload,
  parsePaygatePaymentStatus,
  normalizePaygateInvoiceUsd,
  convertPaygatePaymentToUsd,
  createPaygateClient
};
