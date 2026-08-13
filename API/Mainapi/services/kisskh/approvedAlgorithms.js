const BUNDLE_SHA256 = '85b3dba9a8bf81abd48cbdd7d6d44e33a418c57830acac7f53f2c0211660d501';

const approvedKkeyV1 = Object.freeze({
  algorithmVersion: 'kkey-v1',
  bundleSha256: BUNDLE_SHA256,
  moduleSha256: 'cffbf97c8caa4e2663dc800c50fb19a7459d4f74bfa215789160371b996aad27',
  keyHex: '4f6bdaa39e2f8cb07f5e722d9edef314',
  ivHex: '01504af356e619cf2e42bba68c3f70f9',
  fixedMarker: 'mg3c3b04ba',
  appVersion: '2.8.10',
  platformVersion: 4830201,
  environmentFields: Object.freeze(['kisskh', 'kisskh', 'kisskh', 'kisskh', 'kisskh', 'kisskh']),
  contexts: Object.freeze({
    episode: Object.freeze({
      contextId: '62f176f3bb1b5b8e70e39932ad34a0c7',
      expectedLength: 256,
    }),
    sub: Object.freeze({
      contextId: 'VgV52sWhwvBSf8BsM3BRY9weWiiCbtGp',
      expectedLength: 256,
    }),
  }),
  subtitleCiphers: Object.freeze({
    a1: Object.freeze({
      keyBase64: 'ODA1NjQ4MzY0NjMyODc2Mw==',
      ivBase64: 'Njg1MjYxMjM3MDE4NTI3Mw==',
    }),
    a3: Object.freeze({
      keyBase64: 'c1dPRFhYMDRRUlRrSGRsWg==',
      ivBase64: 'OHB3aGFwSmVDNGhyUzloTw==',
    }),
  }),
});

const APPROVED_ALGORITHMS = new Map([[BUNDLE_SHA256, approvedKkeyV1]]);

module.exports = { APPROVED_ALGORITHMS };
