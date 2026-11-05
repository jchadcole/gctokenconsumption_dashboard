'use strict';
const test = require('node:test');
const assert = require('node:assert');
const u = require('../src/usage');
const { classify } = require('../src/catalog');

const rates = { voiceBotMinutesPerToken: 17, voiceBotIncrementSeconds: 15, digitalBotTurnsPerToken: 51, virtualAgentSessionsPerToken: 2, avaTokensPerSession: 1.2 };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

const catalog = {
  flows: [
    { id: 'vbot', name: 'Voice bot', category: 'bot', isBotFlow: true, flowType: 'bot', avas: [] },
    { id: 'dbot', name: 'Digital bot', category: 'bot', isBotFlow: true, flowType: 'digitalbot', avas: [] },
    { id: 'va', name: 'Virtual Agent', category: 'va', isBotFlow: true, flowType: 'bot', virtualAgentEnabled: true, avas: [] },
    { id: 'ava', name: 'AVA flow', category: 'ava', isBotFlow: false, flowType: 'inboundcall', avas: [{ id: 'a', name: 'A' }] },
  ],
};
const row = (conversationId, flowId, extra = {}) => ({ day: '2026-11-03', conversationId, flowId, mediaType: 'voice', language: 'en-us', botProduct: null, sessions: 1, durationMs: 0, turns: 0, ...extra });
const total = (raw) => u.summarize(u.computeRows(raw, catalog, rates), 'day', '2026-11-03', '2026-11-03', rates).totals;

test('classification follows highest tier: AVA > VA > Bot', () => {
  assert.equal(classify({ avas: [{ id: 'a' }], virtualAgentEnabled: true }), 'ava');
  assert.equal(classify({ avas: [], virtualAgentEnabled: true }), 'va');
  assert.equal(classify({ avas: [], virtualAgentEnabled: false }), 'bot');
});

test('rule 1: each voice-bot call is billed in 15 s increments, rounded up', () => {
  assert.equal(u.billedCallSeconds(0, rates), 0);
  assert.equal(u.billedCallSeconds(1, rates), 15);
  assert.equal(u.billedCallSeconds(15000, rates), 15);
  assert.equal(u.billedCallSeconds(15001, rates), 30);
  assert.equal(u.billedCallSeconds(61000, rates), 75);
});

test('rule 1: voice-bot seconds are totaled, rounded up to a whole minute, then divided by 17', () => {
  // 20 s -> 30 s, 50 s -> 60 s; total 90 s -> 2 minutes -> 2/17 tokens
  const t = total([row('c1', 'vbot', { durationMs: 20000 }), row('c2', 'vbot', { durationMs: 50000 })]);
  assert.equal(t.bot.voiceSeconds, 90);
  assert.equal(t.bot.voiceMinutesRounded, 2);
  close(t.bot.tokens, 2 / 17);
  // exactly 17 minutes of billed time = 1 token
  const calls = Array.from({ length: 17 }, (_, i) => row(`m${i}`, 'vbot', { durationMs: 60000 }));
  close(total(calls).bot.tokens, 1);
});

test('rule 2: digital bots consume one token per 51 prompt/response turns', () => {
  const t = total([row('d1', 'dbot', { mediaType: 'message', turns: 60 }), row('d2', 'dbot', { mediaType: 'message', turns: 42 })]);
  assert.equal(t.bot.digitalTurns, 102);
  close(t.bot.tokens, 2);
});

test('rule 3: Virtual Agents consume one token per 2 sessions, whatever their length', () => {
  const raw = Array.from({ length: 10 }, (_, i) => row(`v${i}`, 'va', { durationMs: 1000 * i * 100 }));
  close(total(raw).va.tokens, 5);
});

test('rule 4: AVAs consume 1.2 tokens per session', () => {
  close(total([row('a1', 'ava'), row('a2', 'ava'), row('a3', 'ava', { mediaType: 'message' })]).ava.tokens, 3.6);
});

test('rule 5: bot that escalates to a Virtual Agent costs only the VA session (0.5)', () => {
  const t = total([row('c1', 'vbot', { durationMs: 300000 }), row('c1', 'va')]);
  close(t.all.tokens, 0.5);
  assert.equal(t.bot.tokens, 0);
  assert.equal(t.bot.absorbedSessions, 1);
});

test('rule 5: bot -> Virtual Agent -> AVA in one call costs only the AVA session (1.2)', () => {
  const t = total([row('c1', 'vbot', { durationMs: 90000 }), row('c1', 'va'), row('c1', 'ava')]);
  close(t.all.tokens, 1.2);
  assert.equal(t.all.absorbedSessions, 2);
  assert.equal(t.va.tokens, 0);
});

test('rule 5 applies per conversation, not across conversations', () => {
  // c1 bot only (60 s -> 1 min), c2 bot+VA (VA only), c3 digital bot + AVA (AVA only)
  const t = total([
    row('c1', 'vbot', { durationMs: 60000 }),
    row('c2', 'vbot', { durationMs: 60000 }), row('c2', 'va'),
    row('c3', 'dbot', { mediaType: 'message', turns: 51 }), row('c3', 'ava', { mediaType: 'message' }),
  ]);
  close(t.bot.tokens, 1 / 17);
  close(t.va.tokens, 0.5);
  close(t.ava.tokens, 1.2);
  close(t.all.tokens, 1 / 17 + 0.5 + 1.2);
});

test('non-metered third-party bots never set the tier or consume tokens', () => {
  const rows = u.computeRows([row('c1', 'lex', { botProduct: 'AmazonLex', durationMs: 60000 })], catalog, rates);
  assert.equal(rows[0].metered, false);
  assert.equal(rows[0].tokens, 0);
});

test('without conversation ids the rules fall back to daily totals', () => {
  const rows = u.computeRows([row(null, 'vbot', { sessions: 4, durationMs: 240000 }), row(null, 'va', { sessions: 2 })], catalog, rates);
  assert.ok(rows.every((r) => r.mode === 'aggregate'));
  const t = u.summarize(rows, 'day', '2026-11-03', '2026-11-03', rates).totals;
  // 240 s + 4 x 7.5 s = 270 s -> 5 min
  assert.equal(t.bot.voiceMinutesRounded, 5);
  close(t.va.tokens, 1);
});

test('intervals are chunked and carry time zone offsets', () => {
  const iv = u.chunkIntervals('2026-01-01', '2026-03-05', 31, 'America/New_York');
  assert.equal(iv[0], '2026-01-01T00:00:00-05:00/2026-02-01T00:00:00-05:00');
  assert.equal(iv.at(-1).split('/')[1], '2026-03-06T00:00:00-05:00');
  assert.equal(u.chunkIntervals('2026-07-01', '2026-07-01', 31, 'UTC')[0], '2026-07-01T00:00:00+00:00/2026-07-02T00:00:00+00:00');
});

test('week buckets start Monday', () => {
  assert.equal(u.bucketOf('2026-11-04', 'week'), '2026-11-02');
  assert.equal(u.bucketOf('2026-11-08', 'week'), '2026-11-02');
  assert.equal(u.bucketOf('2026-11-08', 'month'), '2026-11');
});

test('filters and time series', () => {
  const rows = u.computeRows([
    { ...row('c1', 'vbot', { durationMs: 60000 }), day: '2026-11-01' },
    { ...row('c2', 'ava'), day: '2026-11-02' },
    { ...row('c3', 'lex', { botProduct: 'AmazonLex' }), day: '2026-11-02' },
  ], catalog, rates);
  assert.equal(u.applyFilters(rows, {}).length, 2);
  assert.equal(u.applyFilters(rows, { includeUnmetered: true }).length, 3);
  assert.deepEqual(u.applyFilters(rows, { categories: ['ava'] }).map((r) => r.flowId), ['ava']);
  const s = u.summarize(u.applyFilters(rows, {}), 'day', '2026-10-31', '2026-11-02', rates);
  assert.deepEqual(s.series.map((x) => x.bucket), ['2026-10-31', '2026-11-01', '2026-11-02']);
  close(s.series[2].ava, 1.2);
  assert.equal(s.mode, 'conversation');
});
