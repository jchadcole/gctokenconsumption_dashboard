'use strict';
const test = require('node:test');
const assert = require('node:assert');
const u = require('../src/usage');
const { classify } = require('../src/catalog');

const rates = { voiceBotMinutesPerToken: 17, voiceBotRoundSeconds: 15, digitalBotSessionsPerToken: 51, virtualAgentTokensPerInteraction: 0.5, avaTokensPerInteraction: 1.2 };

test('classification follows highest tier: AVA > VA > Bot', () => {
  assert.equal(classify({ avas: [{ id: 'a' }], virtualAgentEnabled: true }), 'ava');
  assert.equal(classify({ avas: [], virtualAgentEnabled: true }), 'va');
  assert.equal(classify({ avas: [], virtualAgentEnabled: false }), 'bot');
});

test('token rates', () => {
  assert.equal(u.tokensFor({ category: 'ava', sessions: 10 }, rates), 12);
  assert.equal(u.tokensFor({ category: 'va', sessions: 10 }, rates), 5);
  assert.equal(u.tokensFor({ category: 'bot', mediaType: 'message', sessions: 102, metered: true }, rates), 2);
  // 4 calls, 60 s each + 7.5 s rounding allowance each = 270 s = 4.5 min
  assert.ok(Math.abs(u.tokensFor({ category: 'bot', mediaType: 'voice', sessions: 4, durationMs: 240000, metered: true }, rates) - 4.5 / 17) < 1e-9);
  assert.equal(u.tokensFor({ category: 'bot', mediaType: 'voice', sessions: 4, durationMs: 1, metered: false }, rates), 0);
});

test('intervals are chunked and carry time zone offsets', () => {
  const iv = u.chunkIntervals('2026-01-01', '2026-03-05', 31, 'America/New_York');
  assert.equal(iv[0], '2026-01-01T00:00:00-05:00/2026-02-01T00:00:00-05:00');
  assert.equal(iv.at(-1).split('/')[1], '2026-03-06T00:00:00-05:00');
  assert.equal(u.chunkIntervals('2026-07-01', '2026-07-01', 31, 'UTC')[0], '2026-07-01T00:00:00+00:00/2026-07-02T00:00:00+00:00');
});

test('week buckets start Monday', () => {
  assert.equal(u.bucketOf('2026-11-04', 'week'), '2026-11-02');
  assert.equal(u.bucketOf('2026-11-02', 'week'), '2026-11-02');
  assert.equal(u.bucketOf('2026-11-08', 'week'), '2026-11-02');
  assert.equal(u.bucketOf('2026-11-08', 'month'), '2026-11');
});

test('filters and summary', () => {
  const rows = [
    { day: '2026-11-01', flowId: 'a', category: 'bot', mediaType: 'voice', sessions: 2, minutes: 3, tokens: 1, turns: 0, metered: true, divisionId: 'd1' },
    { day: '2026-11-02', flowId: 'b', category: 'ava', mediaType: 'message', sessions: 5, minutes: 0, tokens: 6, turns: 0, metered: true, divisionId: 'd2' },
    { day: '2026-11-02', flowId: 'x', category: 'bot', mediaType: 'voice', sessions: 9, minutes: 0, tokens: 0, turns: 0, metered: false },
  ];
  assert.equal(u.applyFilters(rows, {}).length, 2);
  assert.equal(u.applyFilters(rows, { includeUnmetered: true }).length, 3);
  assert.deepEqual(u.applyFilters(rows, { divisionIds: ['d2'] }).map((r) => r.flowId), ['b']);
  const s = u.summarize(u.applyFilters(rows, {}), 'day', '2026-10-31', '2026-11-02');
  assert.equal(s.totals.all.tokens, 7);
  assert.deepEqual(s.series.map((x) => x.bucket), ['2026-10-31', '2026-11-01', '2026-11-02']);
  assert.equal(s.series[2].ava, 6);
});
