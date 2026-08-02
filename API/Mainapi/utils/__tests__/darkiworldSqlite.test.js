// API/Mainapi/utils/__tests__/darkiworldSqlite.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

const MODULE_PATH = path.join(__dirname, '..', 'darkiworldSqlite.js');

// Helper: build a fresh pair of sqlite fixtures (mirror + darkino) on disk,
// and return their paths. We point the resolver at them via env var
// DARKIWORLD_SQLITE_DIR (read in the module).
function seedFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwsqlite-'));
  const mirrorPath = path.join(dir, 'mirror.sqlite');
  const darkinoPath = path.join(dir, 'darkino.sqlite');

  const m = new Database(mirrorPath);
  m.exec(`
    CREATE TABLE links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title_hydracker_id INTEGER NOT NULL,
      hydracker_lien_id INTEGER UNIQUE NOT NULL,
      quality_id INTEGER,
      quality_name TEXT,
      size_bytes INTEGER DEFAULT 0,
      season_number INTEGER,
      episode_label TEXT,
      langs TEXT,
      final_url TEXT,
      created_at DATETIME,
      updated_at DATETIME
    );
    CREATE INDEX idx_links_hydra_lien ON links(hydracker_lien_id);
    CREATE INDEX idx_links_title ON links(title_hydracker_id);
  `);
  m.close();

  const d = new Database(darkinoPath);
  d.exec(`
    CREATE TABLE link_details (
      link_id INTEGER PRIMARY KEY,
      cache_key TEXT,
      lien TEXT,
      id_host INTEGER,
      title_id INTEGER,
      id_user TEXT,
      taille INTEGER,
      numero INTEGER,
      episode INTEGER,
      episode_id INTEGER,
      full_saison INTEGER,
      qualite INTEGER,
      saison INTEGER,
      active INTEGER,
      to_expire INTEGER,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT,
      model_type TEXT
    );
    CREATE INDEX idx_link_details_title ON link_details(title_id);
    CREATE INDEX idx_link_details_title_season_episode ON link_details(title_id, saison, episode);
  `);
  d.close();

  return {
    dir, mirrorPath, darkinoPath,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
  };
}

test('darkiworldSqlite: module loads and opens both DBs without throwing', (t) => {
  const fix = seedFixtures();
  t.after(() => fix.cleanup());
  process.env.DARKIWORLD_SQLITE_DIR = fix.dir;
  delete require.cache[require.resolve(MODULE_PATH)];
  const mod = require(MODULE_PATH);
  // Force lazy open by calling lookupByLienId for a missing id.
  const result = mod.lookupByLienId(999999);
  assert.equal(result, null);
});

test('darkiworldSqlite: missing dir → all lookups return null, no throw', () => {
  process.env.DARKIWORLD_SQLITE_DIR = path.join(os.tmpdir(), 'definitely-not-there-' + Date.now());
  delete require.cache[require.resolve(MODULE_PATH)];
  const mod = require(MODULE_PATH);
  assert.equal(mod.lookupByLienId(1), null);
});

function seedRows({ mirrorPath, darkinoPath }, { mirror = [], darkino = [] }) {
  const m = new Database(mirrorPath);
  const ins = m.prepare(
    'INSERT INTO links (title_hydracker_id, hydracker_lien_id, quality_id, quality_name, ' +
    'size_bytes, season_number, episode_label, langs, final_url, created_at, updated_at) ' +
    'VALUES (@title_hydracker_id, @hydracker_lien_id, @quality_id, @quality_name, ' +
    '@size_bytes, @season_number, @episode_label, @langs, @final_url, @created_at, @updated_at)'
  );
  for (const row of mirror) ins.run({
    quality_id: null, quality_name: null, size_bytes: 0,
    season_number: null, episode_label: null, langs: null,
    created_at: null, updated_at: null,
    ...row
  });
  m.close();

  const d = new Database(darkinoPath);
  const insD = d.prepare(
    'INSERT INTO link_details (link_id, lien, id_host, title_id, taille, qualite, ' +
    'saison, episode, full_saison, active, to_expire, deleted_at, created_at, updated_at) ' +
    'VALUES (@link_id, @lien, @id_host, @title_id, @taille, @qualite, ' +
    '@saison, @episode, @full_saison, @active, @to_expire, @deleted_at, @created_at, @updated_at)'
  );
  for (const row of darkino) insD.run({
    id_host: 1, title_id: 0, taille: 0, qualite: 0,
    saison: null, episode: null, full_saison: 0,
    active: 1, to_expire: 0, deleted_at: null,
    created_at: null, updated_at: null,
    ...row
  });
  d.close();
}

function loadFresh(dir) {
  process.env.DARKIWORLD_SQLITE_DIR = dir;
  delete require.cache[require.resolve(MODULE_PATH)];
  return require(MODULE_PATH);
}

test('lookupByLienId: mirror hit returns mirror row', (t) => {
  const fix = seedFixtures();
  t.after(() => fix.cleanup());
  seedRows(fix, {
    mirror: [{
      title_hydracker_id: 100, hydracker_lien_id: 5001,
      quality_name: 'HDTV 1080p', size_bytes: 1234567,
      langs: 'TrueFrench',
      final_url: 'https://1fichier.com/?abc',
      created_at: '2026-04-01', updated_at: '2026-04-29'
    }]
  });
  const mod = loadFresh(fix.dir);
  const row = mod.lookupByLienId(5001);
  assert.equal(row.source, 'mirror');
  assert.equal(row.lien, 'https://1fichier.com/?abc');
  assert.equal(row.quality, 'HDTV 1080p');
  assert.equal(row.langs, 'TrueFrench');
  assert.equal(row.taille, 1234567);
});

test('lookupByLienId: mirror darkibox → falls through to darkino', (t) => {
  const fix = seedFixtures();
  t.after(() => fix.cleanup());
  seedRows(fix, {
    mirror: [{
      title_hydracker_id: 100, hydracker_lien_id: 5002,
      final_url: 'https://darkibox.com/abc.html'
    }],
    darkino: [{
      link_id: 5002, title_id: 100,
      lien: 'https://nitroflare.com/view/XYZ/file.mkv',
      taille: 2000000, qualite: 720, active: 1
    }]
  });
  const mod = loadFresh(fix.dir);
  const row = mod.lookupByLienId(5002);
  assert.equal(row.source, 'darkino');
  assert.equal(row.lien, 'https://nitroflare.com/view/XYZ/file.mkv');
});

test('lookupByLienId: both darkibox → null', (t) => {
  const fix = seedFixtures();
  t.after(() => fix.cleanup());
  seedRows(fix, {
    mirror: [{ title_hydracker_id: 100, hydracker_lien_id: 5003,
               final_url: 'https://darkibox.com/x.html' }],
    darkino: [{ link_id: 5003, title_id: 100,
                lien: 'https://darkibox.com/y.html', active: 1 }]
  });
  const mod = loadFresh(fix.dir);
  assert.equal(mod.lookupByLienId(5003), null);
});

test('lookupByLienId: inactive darkino row is skipped', (t) => {
  const fix = seedFixtures();
  t.after(() => fix.cleanup());
  seedRows(fix, {
    darkino: [{ link_id: 5004, title_id: 100,
                lien: 'https://1fichier.com/?dead', active: 0 }]
  });
  const mod = loadFresh(fix.dir);
  assert.equal(mod.lookupByLienId(5004), null);
});

test('lookupByLienId: both miss → null', (t) => {
  const fix = seedFixtures();
  t.after(() => fix.cleanup());
  const mod = loadFresh(fix.dir);
  assert.equal(mod.lookupByLienId(99999), null);
});

test('listByTitle movie: merges mirror + darkino dedup by lien_id, filters darkibox', (t) => {
  const fix = seedFixtures();
  t.after(() => fix.cleanup());
  seedRows(fix, {
    mirror: [
      { title_hydracker_id: 200, hydracker_lien_id: 10,
        final_url: 'https://1fichier.com/?A', quality_name: 'WEB 1080p',
        langs: 'TrueFrench', size_bytes: 1000 },
      { title_hydracker_id: 200, hydracker_lien_id: 11,
        final_url: 'https://1fichier.com/?B', quality_name: 'WEB 720p',
        langs: 'English', size_bytes: 2000 }
    ],
    darkino: [
      // dedup target — same lien_id as mirror[0], should be dropped
      { link_id: 10, title_id: 200, lien: 'https://nitroflare.com/?Adup' },
      // new id, non-darkibox
      { link_id: 12, title_id: 200, lien: 'https://rapidgator.net/?C', taille: 3000 },
      // darkibox row, must be filtered
      { link_id: 13, title_id: 200, lien: 'https://darkibox.com/x.html' },
      // another title, must be filtered
      { link_id: 14, title_id: 999, lien: 'https://1fichier.com/?other' }
    ]
  });
  const mod = loadFresh(fix.dir);
  const list = mod.listByTitle({ type: 'movie', titleId: 200 });
  const byId = Object.fromEntries(list.map(r => [r.id, r]));
  assert.equal(list.length, 3);
  assert.equal(byId[10].source, 'mirror');
  assert.equal(byId[10].provider, 'darkiworld');
  assert.equal(byId[10].quality, 'WEB 1080p');
  assert.equal(byId[11].source, 'mirror');
  assert.equal(byId[12].source, 'darkino');
  assert.equal(byId[13], undefined);
  assert.equal(byId[14], undefined);
});

test('listByTitle movie: empty title → empty array', (t) => {
  const fix = seedFixtures();
  t.after(() => fix.cleanup());
  const mod = loadFresh(fix.dir);
  assert.deepEqual(mod.listByTitle({ type: 'movie', titleId: 12345 }), []);
});

test('listByTitle tv: filters by season+episode, surfaces full_saison rows', (t) => {
  const fix = seedFixtures();
  t.after(() => fix.cleanup());
  seedRows(fix, {
    mirror: [
      { title_hydracker_id: 300, hydracker_lien_id: 20,
        season_number: 1, episode_label: '1',
        final_url: 'https://1fichier.com/?s1e1' },
      { title_hydracker_id: 300, hydracker_lien_id: 21,
        season_number: 1, episode_label: '2',
        final_url: 'https://1fichier.com/?s1e2' }
    ],
    darkino: [
      // s1e1 in darkino — dedup with mirror
      { link_id: 20, title_id: 300, lien: 'https://nitro/?dup',
        saison: 1, episode: 1 },
      // full season pack — should surface for any episode in s1
      { link_id: 22, title_id: 300, lien: 'https://1fichier.com/?s1pack',
        saison: 1, episode: null, full_saison: 1 },
      // s1e3 — not requested
      { link_id: 23, title_id: 300, lien: 'https://1fichier.com/?s1e3',
        saison: 1, episode: 3, full_saison: 0 }
    ]
  });
  const mod = loadFresh(fix.dir);
  const list = mod.listByTitle({ type: 'tv', titleId: 300, season: 1, episode: 1 });
  const ids = list.map(r => r.id).sort((a,b) => a-b);
  // expect 20 (mirror s1e1) + 22 (full_saison) — 21 is s1e2, 23 is s1e3
  assert.deepEqual(ids, [20, 22]);
  const full = list.find(r => r.id === 22);
  assert.equal(full.full_saison, 1);
});

test('listByTitle tv: missing season+episode → empty', (t) => {
  const fix = seedFixtures();
  t.after(() => fix.cleanup());
  const mod = loadFresh(fix.dir);
  assert.deepEqual(mod.listByTitle({ type: 'tv', titleId: 300 }), []);
});

function fakeDeps(initialCache = {}) {
  const cache = new Map(Object.entries(initialCache));
  return {
    cacheDir: '/fake',
    generateCacheKey: (k) => k,
    getFromCacheNoExpiration: async (_dir, key) => cache.get(key) || null,
    saveToCache: async (_dir, key, payload) => { cache.set(key, payload); },
    _cache: cache
  };
}

test('decodeLink: cache hit non-darkibox returns payload as-is', async (t) => {
  const fix = seedFixtures();
  t.after(() => fix.cleanup());
  const mod = loadFresh(fix.dir);
  const deps = fakeDeps({
    darkiworld_decode_v2_5001: {
      success: true, id: '5001', provider: 'direct',
      embed_url: { lien: 'https://1fichier.com/?cached' }
    }
  });
  const res = await mod.decodeLink(5001, deps);
  assert.equal(res.payload.embed_url.lien, 'https://1fichier.com/?cached');
});

test('decodeLink: cache hit darkibox → sqlite swap + rewrite cache', async (t) => {
  const fix = seedFixtures();
  t.after(() => fix.cleanup());
  seedRows(fix, {
    mirror: [{ title_hydracker_id: 100, hydracker_lien_id: 5002,
               final_url: 'https://1fichier.com/?fresh',
               size_bytes: 999, quality_name: '720p', langs: 'TrueFrench' }]
  });
  const mod = loadFresh(fix.dir);
  const deps = fakeDeps({
    darkiworld_decode_v2_5002: {
      success: true, id: '5002', provider: 'direct',
      embed_url: { lien: 'https://darkibox.com/legacy.html' }
    }
  });
  const res = await mod.decodeLink(5002, deps);
  assert.equal(res.payload.embed_url.lien, 'https://1fichier.com/?fresh');
  // cache rewritten
  assert.equal(deps._cache.get('darkiworld_decode_v2_5002').embed_url.lien,
               'https://1fichier.com/?fresh');
});

test('decodeLink: cache miss + sqlite miss → failed marker', async (t) => {
  const fix = seedFixtures();
  t.after(() => fix.cleanup());
  const mod = loadFresh(fix.dir);
  const deps = fakeDeps();
  const res = await mod.decodeLink(99999, deps);
  assert.equal(res.failed.error, 'Lien indisponible');
  assert.equal(res.failed.debug, 'sqlite_miss');
  assert.equal(deps._cache.get('darkiworld_decode_v2_99999').failed, true);
});

test('decodeLink: cache hit failed marker (active) returns failed', async (t) => {
  const fix = seedFixtures();
  t.after(() => fix.cleanup());
  const mod = loadFresh(fix.dir);
  const deps = fakeDeps({
    darkiworld_decode_v2_5005: {
      failed: true, failedAt: Date.now(), id: '5005',
      error: 'Lien indisponible', debug: ''
    }
  });
  const res = await mod.decodeLink(5005, deps);
  assert.equal(res.failed?.error, 'Lien indisponible');
});
