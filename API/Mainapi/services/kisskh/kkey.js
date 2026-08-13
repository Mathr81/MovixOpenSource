const crypto = require('node:crypto');

const APPROVED_FIXED_MARKER = 'mg3c3b04ba';

function jsHashCode(value) {
  const input = String(value);
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(index);
  }
  return hash;
}

function canonicalPayload({ episodeId, contextId, fixedMarker, appVersion, platformVersion, environmentFields }) {
  if (fixedMarker !== APPROVED_FIXED_MARKER) {
    throw new TypeError('fixedMarker kkey invalide');
  }
  if (!Array.isArray(environmentFields) || environmentFields.length !== 6) {
    throw new TypeError('environmentFields invalides');
  }
  if (environmentFields.some((field) => typeof field !== 'string')) {
    throw new TypeError('environmentFields invalides');
  }
  const normalize = (part) => part == null ? '' : String(part);
  const truncate48 = (part) => String(part || '').substr(0, 48);
  const fields = [
    '',
    episodeId,
    null,
    fixedMarker,
    appVersion,
    contextId,
    platformVersion,
    truncate48(environmentFields[0]),
    truncate48(String(environmentFields[1]).toLowerCase()),
    truncate48(environmentFields[2]),
    environmentFields[3],
    environmentFields[4],
    environmentFields[5],
    '00',
    '',
  ];
  const seed = fields.map(normalize).join('|');
  fields.splice(1, 0, jsHashCode(seed));
  return fields.map(normalize).join('|');
}

function decodeAes128Hex(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/i.test(value)) {
    throw new TypeError(`${label} AES-128 invalide`);
  }
  return Buffer.from(value, 'hex');
}

function computeKkey({ context, episodeId, algorithm }) {
  if (!Number.isSafeInteger(episodeId) || episodeId <= 0) throw new TypeError('episodeId invalide');
  if (!['episode', 'sub'].includes(context)) throw new TypeError('context invalide');
  const key = decodeAes128Hex(algorithm?.keyHex, 'key');
  const iv = decodeAes128Hex(algorithm?.ivHex, 'iv');
  const contextSpec = algorithm?.contexts?.[context];
  if (!contextSpec || typeof contextSpec.contextId !== 'string' || !contextSpec.contextId) {
    throw new TypeError('contexte kkey absent');
  }
  if (!Number.isSafeInteger(contextSpec.expectedLength) || contextSpec.expectedLength <= 0) {
    throw new TypeError('longueur kkey invalide');
  }
  if (typeof algorithm.appVersion !== 'string' || !algorithm.appVersion
      || !Number.isSafeInteger(algorithm.platformVersion) || algorithm.platformVersion <= 0) {
    throw new TypeError('version kkey invalide');
  }
  const payload = canonicalPayload({
    episodeId,
    contextId: contextSpec.contextId,
    fixedMarker: algorithm.fixedMarker,
    appVersion: algorithm.appVersion,
    platformVersion: algorithm.platformVersion,
    environmentFields: algorithm.environmentFields,
  });
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(true);
  const output = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]).toString('hex').toUpperCase();
  if (!/^[0-9A-F]+$/.test(output) || output.length !== contextSpec.expectedLength) {
    throw new TypeError('sortie kkey invalide');
  }
  return output;
}

module.exports = { canonicalPayload, computeKkey, jsHashCode };
