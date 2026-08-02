// API/Mainapi/utils/__tests__/daddylive.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DADDYLIVE_COUNTRIES,
  detectCountry,
  parseChannelsHtml,
  parsePlayersHtml,
  buildDeterministicPlayers,
  extractM3u8FromPlayerHtml,
  extractIframeSrc,
} = require('../daddylive');

test('DADDYLIVE_COUNTRIES is keyed by ISO codes incl. fr, us, gb, plus buckets', () => {
  assert.equal(DADDYLIVE_COUNTRIES.fr.name, 'France');
  assert.equal(DADDYLIVE_COUNTRIES.us.name, 'USA');
  assert.equal(DADDYLIVE_COUNTRIES.gb.name, 'UK');
  assert.ok(DADDYLIVE_COUNTRIES.other);
  assert.ok(DADDYLIVE_COUNTRIES.arabic);
});

test('detectCountry: explicit country words -> ISO codes', () => {
  assert.equal(detectCountry('Canal+ France'), 'fr');
  assert.equal(detectCountry('ABC USA'), 'us');
  assert.equal(detectCountry('Sky Sports Football UK'), 'gb');
  assert.equal(detectCountry('Rai 1 Italy'), 'it');
  assert.equal(detectCountry('Antena 3 Spain'), 'es');
  assert.equal(detectCountry('Star Sports 1 IN'), 'in');
  assert.equal(detectCountry('Arte DE'), 'de');
  assert.equal(detectCountry('CBC CA'), 'ca');
  assert.equal(detectCountry('Azteca 7 MX'), 'mx');
});

test('detectCountry: disambiguation', () => {
  assert.equal(detectCountry('Movistar Liga de Campeones'), 'es');
  assert.equal(detectCountry('beIN Sports MENA English 1'), 'arabic');
});

test('detectCountry: US-network allowlist (no country token) -> us', () => {
  assert.equal(detectCountry('Cartoon Network'), 'us');
  assert.equal(detectCountry('Discovery Channel'), 'us');
  assert.equal(detectCountry('Nick JR'), 'us');
});

test('detectCountry: unknown -> other', () => {
  assert.equal(detectCountry('Astro SuperSport 1'), 'other');
  assert.equal(detectCountry('Some Random Channel 123'), 'other');
});

test('detectCountry: bosnia / new zealand / colombia', () => {
  assert.equal(detectCountry('BHT 1 Bosnia'), 'ba');
  assert.equal(detectCountry('New Zealand Rugby'), 'nz');
  assert.equal(detectCountry('Win Sports+ Columbia'), 'co');
});

test('parseChannelsHtml: extracts id+name, tags ISO country, drops 18+', () => {
  const html = `
    <div class="grid">
      <a class="card" href="/watch.php?id=51" data-title="abc usa"><div class="card__title">ABC USA</div><div class="">ID: 51</div></a>
      <a class="card" href="/watch.php?id=121" data-title="canal+ france"><div class="card__title">Canal+ France</div><div class="">ID: 121</div></a>
      <a class="card" href="/watch.php?id=501" data-title="18+ (player-01)"><div class="card__title">18+ (Player-01)</div><div class="">ID: 501</div></a>
      <a class="card" href="/watch.php?id=304" data-title="animal planet"><div class="card__title">Animal Planet</div><div class="">ID: 304</div></a>
    </div>`;
  const rows = parseChannelsHtml(html);
  assert.equal(rows.length, 3);
  const abc = rows.find((r) => r.rawId === '51');
  assert.equal(abc.name, 'ABC USA');
  assert.equal(abc.country, 'us');
  assert.equal(rows.find((r) => r.rawId === '121').country, 'fr');
  assert.equal(rows.find((r) => r.rawId === '304').country, 'us');
  assert.equal(rows.find((r) => r.rawId === '501'), undefined);
});

test('parseChannelsHtml: drops 18+ by name even when id is outside 501-520', () => {
  const html = `<div class="grid"><a class="card" href="/watch.php?id=99"><div class="card__title">18+ Adult Channel</div></a></div>`;
  assert.deepEqual(parseChannelsHtml(html), []);
});

test('parseChannelsHtml: empty / garbage html -> []', () => {
  assert.deepEqual(parseChannelsHtml(''), []);
  assert.deepEqual(parseChannelsHtml('<div>nope</div>'), []);
});

test('parsePlayersHtml: reads #playerBtns data-url + title', () => {
  const html = `
    <div class="btn-group" id="playerBtns">
      <button class="btn player-btn is-active" data-url="https://dlhd.pk/stream/stream-51.php" title="PLAYER 1">Player 1</button>
      <button class="btn player-btn" data-url="https://dlhd.pk/cast/stream-51.php" title="PLAYER 2">Player 2</button>
    </div>`;
  const players = parsePlayersHtml(html);
  assert.equal(players.length, 2);
  assert.equal(players[0].dataUrl, 'https://dlhd.pk/stream/stream-51.php');
  assert.equal(players[0].title, 'Player 1');
  assert.equal(players[1].title, 'Player 2');
});

test('parsePlayersHtml: no buttons / null -> []', () => {
  assert.deepEqual(parsePlayersHtml('<div>x</div>'), []);
  assert.deepEqual(parsePlayersHtml(null), []);
});

test('buildDeterministicPlayers: 6 absolute dlhd urls, titles Player 1..6', () => {
  const players = buildDeterministicPlayers('51');
  assert.equal(players.length, 6);
  assert.equal(players[0].dataUrl, 'https://dlhd.pk/stream/stream-51.php');
  assert.equal(players[5].dataUrl, 'https://dlhd.pk/player/stream-51.php');
  players.forEach((p, i) => assert.equal(p.title, `Player ${i + 1}`));
});

test('extractM3u8FromPlayerHtml: decodes the Clappr window.atob source', () => {
  const b64 = 'aHR0cHM6Ly92b21vcy5waGFudGVtbGlzLnRvcC9wcmVtaXVtNTEvaW5kZXgubTN1OD9tZDV2MT0wMHE0QlpkTW9HS2c2cC05WGFxUl9BJm1kNXYyPUl6MF9UMU5wck9HWThlejZFazZBbUEmZXhwaXJlcz0xNzgwMTYzMjcw';
  const html = `<script>var player = new Clappr.Player({ source: window.atob('${b64}'), mute: true });</script>`;
  const url = extractM3u8FromPlayerHtml(html);
  assert.equal(url, 'https://vomos.phantemlis.top/premium51/index.m3u8?md5v1=00q4BZdMoGKg6p-9XaqR_A&md5v2=Iz0_T1NprOGY8ez6Ek6AmA&expires=1780163270');
});

test('extractM3u8FromPlayerHtml: fallback scans loose base64 for an m3u8 url', () => {
  const b64 = Buffer.from('https://host.example/live/index.m3u8?x=1', 'utf8').toString('base64');
  const html = `<script>const s = "${b64}"; doThing(s);</script>`;
  assert.equal(extractM3u8FromPlayerHtml(html), 'https://host.example/live/index.m3u8?x=1');
});

test('extractM3u8FromPlayerHtml: no m3u8 -> null', () => {
  assert.equal(extractM3u8FromPlayerHtml('<script>var a = window.atob("aGVsbG8=");</script>'), null);
  assert.equal(extractM3u8FromPlayerHtml(''), null);
});

test('extractIframeSrc: returns first iframe src, absolutized, else null', () => {
  assert.equal(
    extractIframeSrc('<div><iframe src="https://donis.example/premiumtv/daddy3.php?id=51"></iframe></div>'),
    'https://donis.example/premiumtv/daddy3.php?id=51',
  );
  assert.equal(
    extractIframeSrc('<iframe src="/embed/x.php"></iframe>', 'https://dlhd.pk/stream/stream-51.php'),
    'https://dlhd.pk/embed/x.php',
  );
  assert.equal(extractIframeSrc('<div>no iframe here</div>'), null);
  assert.equal(extractIframeSrc(''), null);
});
