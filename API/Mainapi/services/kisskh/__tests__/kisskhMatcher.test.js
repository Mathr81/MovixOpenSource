const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

function matcher() {
  return require('../kisskhMatcher');
}

test('normalizes Unicode accents, punctuation and whitespace deterministically', () => {
  const { normalizeTitle } = matcher();
  assert.equal(normalizeTitle('  L\u2019\u00c9t\u00e9:\t\u00c7a!  '), 'l ete ca');
});

test('analyzes compound and abbreviated season title suffixes', () => {
  const { analyzeSeasonTitle } = matcher();
  assert.deepEqual(analyzeSeasonTitle('Swallowed Star Season 2+3+4'), {
    base: 'swallowed star',
    markers: [2, 3, 4],
  });
  assert.deepEqual(analyzeSeasonTitle('Swallowed Star Season 2 & 3'), {
    base: 'swallowed star',
    markers: [2, 3],
  });
  assert.deepEqual(analyzeSeasonTitle('Swallowed Star S2'), {
    base: 'swallowed star',
    markers: [2],
  });
});

test('analyzes catalogue parts, ordinals, roman numerals, numeric suffixes and specials', () => {
  const { analyzeSeasonTitle } = matcher();
  assert.deepEqual(analyzeSeasonTitle('Alice in Borderland 2'), {
    base: 'alice in borderland', markers: [2],
  });
  assert.deepEqual(analyzeSeasonTitle('Love Area Part 2'), {
    base: 'love area', markers: [2],
  });
  assert.deepEqual(analyzeSeasonTitle('Love Area Pt. 2'), {
    base: 'love area', markers: [2],
  });
  assert.deepEqual(analyzeSeasonTitle('Drama 2nd Season'), {
    base: 'drama', markers: [2],
  });
  assert.deepEqual(analyzeSeasonTitle('Drama Season II'), {
    base: 'drama', markers: [2],
  });
  assert.deepEqual(analyzeSeasonTitle('Drama S0'), {
    base: 'drama', markers: [0],
  });
  assert.deepEqual(analyzeSeasonTitle('Drama SP'), {
    base: 'drama', markers: [0],
  });
  assert.deepEqual(analyzeSeasonTitle('Drama OVA'), {
    base: 'drama', markers: [0],
  });
  assert.deepEqual(analyzeSeasonTitle('Raya and the Last Dragon (2021)'), {
    base: 'raya and the last dragon 2021', markers: [],
  });
});

test('counts only positive integer episodes so decimal bonus content never shifts TMDB episodes', () => {
  const { regularEpisodeCount } = matcher();
  const episodes = [1, 2, 3, 4, 5, 6, 7, 7.5].map((number, index) => ({ id: index + 1, number }));
  assert.equal(regularEpisodeCount(episodes), 7);
});

test('selects a continuation segment for absolute single-season episode numbering', () => {
  const { selectEpisodeSegment } = matcher();
  const selected = selectEpisodeSegment([
    { candidate: { id: 1272, title: 'Swallowed Star', episodesCount: 26 }, score: 100 },
    { candidate: { id: 4529, title: 'Swallowed Star Season 2+3+4', episodesCount: 208 }, score: 100 },
  ], {
    seasonNumber: 1,
    seasonCount: 1,
    episodeNumber: 27,
    tmdbSeasons: [{ season_number: 1, episode_count: 210 }],
  });
  assert.equal(selected.ranked.candidate.id, 4529);
  assert.equal(selected.localEpisodeNumber, 1);
});

test('ignores trailing year metadata when ordering absolute episode segments', () => {
  const { selectEpisodeSegment } = matcher();
  const selected = selectEpisodeSegment([
    { candidate: { id: 4529, title: 'Swallowed Star Season 2+3+4 (2026)', episodesCount: 208 }, score: 100 },
    { candidate: { id: 1272, title: 'Swallowed Star', episodesCount: 26 }, score: 100 },
  ], {
    seasonNumber: 1,
    seasonCount: 1,
    episodeNumber: 27,
    tmdbSeasons: [{ season_number: 1, episode_count: 210 }],
  });
  assert.equal(selected.ranked.candidate.id, 4529);
  assert.equal(selected.localEpisodeNumber, 1);
});

test('selects a compound true-season segment with its cumulative local episode', () => {
  const { selectEpisodeSegment } = matcher();
  const selected = selectEpisodeSegment([
    { candidate: { id: 4529, title: 'Swallowed Star Season 2+3+4', episodesCount: 208 }, score: 100 },
  ], {
    seasonNumber: 3,
    seasonCount: 4,
    episodeNumber: 1,
    tmdbSeasons: [
      { season_number: 2, episode_count: 52 },
      { season_number: 3, episode_count: 52 },
      { season_number: 4, episode_count: 52 },
    ],
  });
  assert.equal(selected.ranked.candidate.id, 4529);
  assert.equal(selected.localEpisodeNumber, 53);
});

test('matching uses localized, original and alternative titles', () => {
  const { buildTmdbTitleCandidates, rankKisskhCandidates } = matcher();
  const titles = buildTmdbTitleCandidates({
    localized: { name: 'Proposition commerciale' },
    original: { original_name: 'Sanae Matseon' },
    alternatives: { results: [{ title: 'A Business Proposal' }] },
  });
  const ranked = rankKisskhCandidates(
    { titles, year: 2022, countries: ['KR'] },
    [{ id: 4608, title: 'A Business Proposal', releaseDate: '2022', country: 'Korea' }],
  );
  assert.equal(ranked[0].candidate.id, 4608);
});

test('matching tolerates a leading English article missing from TMDB', () => {
  const { buildTmdbTitleCandidates, rankKisskhCandidates } = matcher();
  const titles = buildTmdbTitleCandidates({
    localized: { name: 'Business Proposal' },
    original: { original_name: 'Business Proposal' },
  });
  const ranked = rankKisskhCandidates(
    { titles, year: '2022-02-28', countries: ['KR'], seasonNumber: 1, seasonCount: 1 },
    [{ id: 4608, title: 'A Business Proposal', releaseDate: '2022', country: 'Korea' }],
  );
  assert.equal(ranked[0]?.candidate.id, 4608);
});

test('matching treats a trailing parenthesized year as KissKH metadata', () => {
  const { buildTmdbTitleCandidates, rankKisskhCandidates } = matcher();
  const titles = buildTmdbTitleCandidates({
    localized: { name: 'Spooky in Love' },
    original: { original_name: 'Spooky in Love' },
  });
  const ranked = rankKisskhCandidates(
    { titles, year: '2026-08-03', countries: ['KR'], seasonNumber: 1, seasonCount: 1 },
    [{ id: 13088, title: 'Spooky in Love (2026)', episodesCount: 7 }],
  );
  assert.equal(ranked[0]?.candidate.id, 13088);
  assert.equal(ranked[0]?.score, 106);
});

test('matching accepts either side of a KissKH dual title and ignores editorial uncut suffixes', () => {
  const { buildTmdbTitleCandidates, rankKisskhCandidates } = matcher();
  const titles = buildTmdbTitleCandidates({
    localized: { name: 'Renegade Immortal' },
    original: { original_name: 'Xian Ni' },
  });
  const dual = rankKisskhCandidates(
    { titles, seasonNumber: 1, seasonCount: 1 },
    [{ id: 8050, title: 'Renegade Immortal - Xian Ni', episodesCount: 152 }],
  );
  assert.equal(dual[0]?.candidate.id, 8050);

  const uncutTitles = buildTmdbTitleCandidates({ localized: { name: 'My Stubborn' } });
  const uncut = rankKisskhCandidates(
    { titles: uncutTitles, seasonNumber: 1, seasonCount: 1 },
    [{ id: 10557, title: 'My Stubborn: Uncut', episodesCount: 12 }],
  );
  assert.equal(uncut[0]?.candidate.id, 10557);
});

test('matching parses a season marker independently on either side of a dual anime title', () => {
  const { buildTmdbTitleCandidates, rankKisskhCandidates } = matcher();
  const titles = buildTmdbTitleCandidates({
    localized: { name: "A Record of a Mortal's Journey to Immortality" },
    alternatives: { results: [{ title: 'Fanren Xiu Xian Chuan' }] },
  });
  const ranked = rankKisskhCandidates({
    titles,
    seasonNumber: 5,
    seasonCount: 5,
  }, [{
    id: 13164,
    title: "A Record Of Mortal's Journey To Immortality Season 5 - Fanren Xiu Xian Chuan 5th Season",
    episodesCount: 9,
  }]);
  assert.equal(ranked[0]?.candidate.id, 13164);
});

test('localized equality outranks original and alternative equality', () => {
  const { buildTmdbTitleCandidates, rankKisskhCandidates } = matcher();
  const titles = buildTmdbTitleCandidates({
    localized: { name: 'Titre local' },
    original: { original_name: 'Original title' },
    alternatives: { results: [{ title: 'Other title' }] },
  });
  const ranked = rankKisskhCandidates(
    { titles, year: 2020, countries: [] },
    [
      { id: 2, title: 'Other title' },
      { id: 1, title: 'Titre local' },
      { id: 3, title: 'Original title' },
    ],
  );
  assert.deepEqual(ranked.map((entry) => entry.candidate.id), [1, 3, 2]);
});

test('candidate title construction deduplicates normalized aliases and is bounded', () => {
  const { buildTmdbTitleCandidates, buildSeasonAwareQueries, MAX_TITLE_CANDIDATES, MAX_QUERIES } = matcher();
  const titles = buildTmdbTitleCandidates({
    localized: { name: 'Caf\u00e9' },
    original: { original_name: 'Cafe' },
    alternatives: { results: Array.from({ length: 50 }, (_, index) => ({ title: `Alias ${index}` })) },
  });
  assert.equal(titles.length, MAX_TITLE_CANDIDATES);
  assert.equal(titles.filter((entry) => entry.normalized === 'cafe').length, 1);
  const queries = buildSeasonAwareQueries(titles, 2);
  assert.ok(queries.length <= MAX_QUERIES);
  assert.equal(new Set(queries.map((query) => query.toLowerCase())).size, queries.length);
});

test('season zero queries localized and original variants as Special and Specials', () => {
  const { buildTmdbTitleCandidates, buildSeasonAwareQueries } = matcher();
  const titles = buildTmdbTitleCandidates({
    localized: { name: 'Titre local' },
    original: { original_name: 'Original' },
    alternatives: { results: [{ title: 'Alias' }] },
  });
  assert.deepEqual(buildSeasonAwareQueries(titles, 0), [
    'Titre local Special',
    'Titre local Specials',
    'Original Special',
    'Original Specials',
  ]);
});

test('season one may use an unqualified title', () => {
  const { buildTmdbTitleCandidates, rankKisskhCandidates } = matcher();
  const titles = buildTmdbTitleCandidates({ localized: { name: 'Alchemy of Souls' } });
  const ranked = rankKisskhCandidates(
    { titles, seasonNumber: 1, seasonCount: 2 },
    [{ id: 1, title: 'Alchemy of Souls' }],
  );
  assert.equal(ranked[0].candidate.id, 1);
});

test('later TMDB seasons require an explicit matching season marker', () => {
  const { buildTmdbTitleCandidates, rankKisskhCandidates } = matcher();
  const titles = buildTmdbTitleCandidates({ localized: { name: 'Alchemy of Souls' } });
  const ranked = rankKisskhCandidates(
    { titles, seasonNumber: 2, seasonCount: 2 },
    [
      { id: 1, title: 'Alchemy of Souls' },
      { id: 2, title: 'Alchemy of Souls Season 2' },
    ],
  );
  assert.deepEqual(ranked.map((entry) => entry.candidate.id), [2]);
});

test('later seasons also search the bare primary title for KissKH exact search quirks', () => {
  const { buildTmdbTitleCandidates, buildSeasonAwareQueries } = matcher();
  const titles = buildTmdbTitleCandidates({
    localized: { name: 'From' },
    original: { original_name: 'FROM' },
  });

  assert.deepEqual(buildSeasonAwareQueries(titles, 4), [
    'From',
    'From Season 4',
    'From S4',
  ]);
});

test('an explicit conflicting season marker rejects the candidate', () => {
  const { buildTmdbTitleCandidates, rankKisskhCandidates } = matcher();
  const titles = buildTmdbTitleCandidates({ localized: { name: 'The Glory' } });
  const ranked = rankKisskhCandidates(
    { titles, seasonNumber: 2, seasonCount: 2 },
    [{ id: 1, title: 'The Glory Season 3' }],
  );
  assert.deepEqual(ranked, []);
});

test('matching fails closed when two candidates are within the ambiguity margin', () => {
  const { buildTmdbTitleCandidates, rankKisskhCandidates } = matcher();
  const titles = buildTmdbTitleCandidates({ localized: { name: 'Signal' } });
  const ranked = rankKisskhCandidates(
    { titles, year: 2016, countries: ['KR'] },
    [
      { id: 1, title: 'Signal', releaseDate: '2016', country: 'Korea' },
      { id: 2, title: 'Signal', releaseDate: '2017', country: 'South Korea' },
    ],
  );
  assert.deepEqual(ranked, []);
});

test('catalogue discovery may retain ambiguous candidates only for bounded detail enrichment', () => {
  const { buildTmdbTitleCandidates, rankKisskhCandidates } = matcher();
  const titles = buildTmdbTitleCandidates({ localized: { name: 'Signal' } });
  const candidates = [
    { id: 1, title: 'Signal', episodesCount: 16 },
    { id: 2, title: 'Signal', episodesCount: 16 },
  ];
  assert.deepEqual(rankKisskhCandidates({ titles }, candidates), []);
  assert.deepEqual(
    rankKisskhCandidates({ titles, retainAmbiguous: true }, candidates)
      .map((entry) => entry.candidate.id),
    [1, 2],
  );
});

test('regular episode count is a positive tie-breaker but never rejects a mismatch', () => {
  const { buildTmdbTitleCandidates, rankKisskhCandidates } = matcher();
  const titles = buildTmdbTitleCandidates({ localized: { name: 'Squid Game' } });
  const ranked = rankKisskhCandidates({
    titles,
    seasonNumber: 2,
    seasonCount: 2,
    expectedEpisodeCount: 7,
    retainAmbiguous: true,
  }, [
    { id: 1, title: 'Squid Game Season 2', episodes: Array.from({ length: 8 }, (_, index) => ({ number: index + 1 })) },
    { id: 2, title: 'Squid Game Season 2', episodes: [1, 2, 3, 4, 5, 6, 7, 7.5].map((number) => ({ number })) },
  ]);
  assert.equal(ranked[0].candidate.id, 2);
  assert.equal(ranked.length, 2);
});

test('matching retains complementary compound segments for absolute single-season numbering', () => {
  const { buildTmdbTitleCandidates, rankKisskhCandidates } = matcher();
  const titles = buildTmdbTitleCandidates({ localized: { name: 'Swallowed Star' } });
  const ranked = rankKisskhCandidates(
    { titles, seasonNumber: 1, seasonCount: 1 },
    [
      { id: 1272, title: 'Swallowed Star', episodesCount: 26 },
      { id: 4529, title: 'Swallowed Star Season 2+3+4', episodesCount: 208 },
    ],
  );
  assert.deepEqual(ranked.map((entry) => entry.candidate.id), [1272, 4529]);
});

test('season zero is valid and missing episode is explicit', () => {
  const { selectConfirmedDrama } = matcher();
  assert.throws(
    () => selectConfirmedDrama([{ id: 1, episodes: [{ id: 2, number: 1 }] }], 0, 2),
    (error) => error.code === 'episode_missing',
  );
});

test('episode numbers are exact and never cumulative or coerced', () => {
  const { selectConfirmedDrama } = matcher();
  const selected = selectConfirmedDrama([
    { id: 1, title: 'Drama Season 2', episodes: [{ id: 20, number: 1 }, { id: 21, number: 2 }] },
  ], 2, 2);
  assert.equal(selected.episode.id, 21);
  assert.throws(
    () => selectConfirmedDrama([{ id: 1, episodes: [{ id: 20, number: '2' }] }], 1, 2),
    (error) => error.code === 'episode_missing',
  );
});

test('multi-season unqualified result with duplicate episode numbers fails closed', () => {
  const { selectConfirmedDrama } = matcher();
  assert.throws(
    () => selectConfirmedDrama([{
      id: 1,
      title: 'Unqualified Drama',
      episodes: [{ id: 20, number: 2 }],
      tmdbSeasons: [
        { seasonNumber: 1, episodes: [{ episodeNumber: 2 }] },
        { seasonNumber: 2, episodes: [{ episodeNumber: 2 }] },
      ],
    }], 2, 2),
    (error) => error.code === 'not_found',
  );
});

test('TMDB alternative titles use the exact cache key, endpoint and details TTL', async () => {
  const redisWrites = [];
  const axiosCalls = [];
  const redisDouble = {
    status: 'ready',
    async get(key) {
      assert.equal(key, 'tmdb:alternative_titles:tv:154825');
      return null;
    },
    async set(...args) { redisWrites.push(args); return 'OK'; },
  };
  const axiosDouble = {
    async get(url, options) {
      axiosCalls.push([url, options]);
      return { data: { id: 154825, results: [{ title: 'Business Proposal' }] } };
    },
  };
  const originalLoad = Module._load;
  const tmdbPath = path.resolve(__dirname, '../../../utils/tmdbCache.js');
  delete require.cache[tmdbPath];
  Module._load = function load(request, parent, isMain) {
    if (request === 'axios') return axiosDouble;
    if (request === '../config/redis' && parent?.filename === tmdbPath) return { redis: redisDouble };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const { fetchTmdbAlternativeTitles, TTL_DETAILS } = require(tmdbPath);
    const result = await fetchTmdbAlternativeTitles('https://api.themoviedb.org/3', 'test-key', 154825);
    assert.equal(result.results[0].title, 'Business Proposal');
    assert.deepEqual(axiosCalls, [[
      'https://api.themoviedb.org/3/tv/154825/alternative_titles',
      { params: { api_key: 'test-key' }, timeout: 10_000 },
    ]]);
    assert.deepEqual(redisWrites, [[
      'tmdb:alternative_titles:tv:154825',
      JSON.stringify(result),
      'EX',
      TTL_DETAILS,
    ]]);
  } finally {
    Module._load = originalLoad;
    delete require.cache[tmdbPath];
  }
});

test('TMDB alternative titles return the cached payload without HTTP', async () => {
  const cached = { id: 154825, results: [{ title: 'Cached alias' }] };
  const redisDouble = {
    status: 'ready',
    async get() { return JSON.stringify(cached); },
    async set() { throw new Error('cache write should not run'); },
  };
  const axiosDouble = { async get() { throw new Error('HTTP should not run'); } };
  const originalLoad = Module._load;
  const tmdbPath = path.resolve(__dirname, '../../../utils/tmdbCache.js');
  delete require.cache[tmdbPath];
  Module._load = function load(request, parent, isMain) {
    if (request === 'axios') return axiosDouble;
    if (request === '../config/redis' && parent?.filename === tmdbPath) return { redis: redisDouble };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const { fetchTmdbAlternativeTitles } = require(tmdbPath);
    assert.deepEqual(await fetchTmdbAlternativeTitles('https://api.test', 'key', 154825), cached);
  } finally {
    Module._load = originalLoad;
    delete require.cache[tmdbPath];
  }
});
