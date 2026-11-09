'use strict';
const test = require('node:test');
const assert = require('node:assert');
const u = require('../src/usage');
const { classify } = require('../src/catalog');

const rates = { voiceBotMinutesPerToken: 17, voiceBotIncrementSeconds: 15, digitalBotTurnsPerToken: 51, virtualAgentSessionsPerToken: 2, avaTokensPerSession: 1.2, tokenRounding: 'none' };
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

test('voice bot sessions reported with media type CALL are voice: 17 sub-second calls = 17 x 15 s', () => {
  const calls = Array.from({ length: 17 }, (_, i) => row(`call${i}`, 'vbot', { mediaType: 'CALL', durationMs: 800, turns: 1 }));
  const t = total(calls);
  assert.equal(t.bot.digitalTurns, 0);
  assert.equal(t.bot.voiceSeconds, 255);        // 17 x 15 s
  assert.equal(t.bot.voiceMinutesRounded, 5);   // 4.25 min rounded up
  close(t.bot.tokens, 5 / 17);
});

test('a voice bot flow is voice even when analytics media type is unexpected', () => {
  const t = total([row('c1', 'vbot', { mediaType: 'unknown', durationMs: 1000 })]);
  assert.equal(t.bot.voiceSeconds, 15);
  const d = total([row('c2', 'dbot', { mediaType: 'CALL', turns: 51 })]);
  close(d.bot.tokens, 1);
});

test('each flow row counts the conversations that reached it', () => {
  const rows = u.computeRows([
    row('c1', 'vbot', { sessions: 2, durationMs: 500 }), row('c2', 'vbot', { sessions: 2, durationMs: 500 }),
  ], catalog, rates);
  const s = u.summarize(rows, 'day', '2026-11-03', '2026-11-03', rates);
  assert.equal(s.byFlow[0].conversations, 2);
  assert.equal(s.byFlow[0].sessions, 4);
  assert.equal(s.byFlow[0].callMinutes, 0.5); // 2 calls x 15 s
  assert.equal(s.byFlow[0].minutes, 1);       // rounded up to a whole billed minute
});

test('rows, chart and breakdowns carry the minute rounding and add up to the Bots tile', () => {
  // Chad's case: 17 calls x 15 s = 4:15 -> 5 billed minutes -> 5/17 tokens, in every view
  const one = u.computeRows(Array.from({ length: 17 }, (_, i) => row(`c${i}`, 'vbot', { mediaType: 'CALL', durationMs: 800 })), catalog, rates);
  const s1 = u.summarize(one, 'day', '2026-11-03', '2026-11-03', rates);
  close(s1.byFlow[0].tokens, 5 / 17);
  close(s1.series[0].bot, 5 / 17);
  close(s1.byMediaType[0].tokens, 5 / 17);
  close(s1.totals.bot.tokens, 5 / 17);

  // Two voice bots on two days: 90 s + 30 s = 2 min, shared 3:1 by billed seconds
  const rows = u.computeRows([
    row('a1', 'vbot', { durationMs: 90000 }),
    { ...row('b1', 'vbot2', { durationMs: 20000 }), day: '2026-11-04' },
  ], { flows: [...catalog.flows, { id: 'vbot2', name: 'Voice bot 2', category: 'bot', isBotFlow: true, flowType: 'bot', avas: [] }] }, rates);
  const s = u.summarize(rows, 'day', '2026-11-03', '2026-11-04', rates);
  assert.equal(s.totals.bot.voiceMinutesRounded, 2);
  close(s.totals.bot.tokens, 2 / 17);
  close(s.byFlow.find((f) => f.flowId === 'vbot').minutes, 1.5);
  close(s.byFlow.find((f) => f.flowId === 'vbot2').minutes, 0.5);
  for (const tab of ['byFlow', 'byDivision', 'byMediaType', 'byLanguage', 'byBotProduct', 'byCategoryMedia']) {
    close(s[tab].reduce((a, r) => a + r.tokens, 0), s.totals.all.tokens);
  }
  close(s.series.reduce((a, b) => a + b.bot, 0), s.totals.bot.tokens);
  // A drill-down shows the row's share, not a fresh rounding
  const drill = u.summarize(u.applyFilters(rows, { flowIds: ['vbot2'] }), 'day', '2026-11-03', '2026-11-04', rates);
  close(drill.totals.bot.tokens, s.byFlow.find((f) => f.flowId === 'vbot2').tokens);
});

test('rule 6: each type is rounded up to a whole token, shared across its rows', () => {
  const cat = { flows: [...catalog.flows, { id: 'vbot2', name: 'Voice bot 2', category: 'bot', isBotFlow: true, flowType: 'bot', avas: [] }] };
  const raw = [
    row('a1', 'vbot', { durationMs: 90000 }), // 1.5 billed min
    { ...row('b1', 'vbot2', { durationMs: 20000 }), day: '2026-11-04' }, // 0.5 billed min -> 2 min = 2/17
    row('v1', 'va'), // 0.5
    row('x1', 'ava'), // 1.2
  ];
  const r = { ...rates, tokenRounding: 'type' };
  const rows = u.computeRows(raw, cat, r);
  const s = u.summarize(rows, 'day', '2026-11-03', '2026-11-04', r);
  assert.equal(s.totals.bot.tokens, 1);
  assert.equal(s.totals.va.tokens, 1);
  assert.equal(s.totals.ava.tokens, 2);
  assert.equal(s.totals.all.tokens, 4);
  close(s.totals.all.usedTokens, 2 / 17 + 0.5 + 1.2);
  assert.equal(s.byFlow.find((f) => f.flowId === 'vbot').tokens, 1); // the Bots token goes to the bot that used 3/4 of it
  assert.equal(s.byFlow.find((f) => f.flowId === 'vbot2').tokens, 0);
  for (const tab of ['byFlow', 'byDivision', 'byMediaType', 'byLanguage', 'byBotProduct', 'byCategoryMedia']) close(s[tab].reduce((a, x) => a + x.tokens, 0), 4);
  close(s.series.reduce((a, b) => a + b.bot + b.va + b.ava, 0), 4);
  const drill = u.summarize(u.applyFilters(rows, { flowIds: ['vbot2'] }), 'day', '2026-11-03', '2026-11-04', r);
  assert.equal(drill.totals.bot.tokens, 0);

  const total = u.summarize(u.computeRows(raw, cat, { ...rates, tokenRounding: 'total' }), 'day', '2026-11-03', '2026-11-04', rates).totals;
  assert.equal(total.all.tokens, 2); // 1.82 -> 2
  const prod = u.summarize(u.computeRows([...raw, row('d1', 'dbot', { mediaType: 'message', turns: 5 })], cat, { ...rates, tokenRounding: 'product' }), 'day', '2026-11-03', '2026-11-04', rates).totals;
  assert.equal(prod.bot.tokens, 2); // voice 0.12 -> 1, digital 0.1 -> 1
  // a whole number stays as it is
  const exact = u.summarize(u.computeRows([row('v1', 'va'), row('v2', 'va')], catalog, r), 'day', '2026-11-03', '2026-11-03', r).totals;
  assert.equal(exact.va.tokens, 1);
});

test('breakdown rows split usage and tokens into voice and digital', () => {
  const cat = { flows: [...catalog.flows, { id: 'both', name: 'Omni VA', category: 'va', isBotFlow: true, flowType: 'digitalbot', avas: [] }] };
  const rows = u.computeRows([
    row('c1', 'vbot', { mediaType: 'CALL', durationMs: 50000 }),          // voice bot: 1 billed min
    row('d1', 'dbot', { mediaType: 'message', turns: 102 }),             // digital bot: 2 tokens
    row('v1', 'both', { mediaType: 'voice' }), row('v2', 'both', { mediaType: 'message' }), row('v3', 'both', { mediaType: 'message' }),
  ], { flows: cat.flows.map((f) => (f.id === 'both' ? { ...f, flowType: null } : f)) }, rates);
  const s = u.summarize(rows, 'day', '2026-11-03', '2026-11-03', rates);
  const bot = s.byCategory.find((r) => r.category === 'bot');
  close(bot.voiceTokens, 1 / 17); close(bot.digitalTokens, 2);
  assert.equal(bot.voiceMinutes, 1); assert.equal(bot.digitalTurns, 102);
  assert.ok(bot.botVoice && bot.botDigital);
  const va = s.byFlow.find((r) => r.flowId === 'both');
  assert.deepEqual(va.channels, ['voice', 'digital']);
  assert.equal(va.voiceSessions, 1); assert.equal(va.digitalSessions, 2);
  close(va.voiceTokens, 0.5); close(va.digitalTokens, 1);
  assert.equal(va.digitalTurns, 0); assert.ok(!va.botDigital); // turns do not apply to Virtual Agents
  for (const r of [...s.byFlow, ...s.byCategory, ...s.byDivision]) close(r.voiceTokens + r.digitalTokens, r.tokens);
  close(s.totals.va.voiceTokens, 0.5); close(s.totals.va.digitalTokens, 1);
  assert.equal(s.totals.va.digitalBillableSessions, 2);
});

test('every breakdown row follows the token rules: billed units -> tokens, then the whole-token share', () => {
  const r6 = { ...rates, tokenRounding: 'type' };
  const cat = { flows: [...catalog.flows, { id: 'omni', name: 'Omni VA', category: 'va', isBotFlow: true, flowType: null, avas: [] }] };
  const raw = [
    ...Array.from({ length: 17 }, (_, i) => row(`c${i}`, 'vbot', { mediaType: 'CALL', durationMs: 800 })),
    row('d1', 'dbot', { mediaType: 'message', turns: 40 }),
    // bot -> VA in one call: the bot session is escalated, the VA bills one session
    row('e1', 'vbot', { mediaType: 'CALL', durationMs: 30000 }), row('e1', 'va', { mediaType: 'CALL' }),
    // VA -> AVA in one digital conversation: VA escalated, AVA bills 1.2
    row('e2', 'omni', { mediaType: 'message' }), row('e2', 'ava', { mediaType: 'message' }),
    row('o1', 'omni', { mediaType: 'voice' }), row('o2', 'omni', { mediaType: 'message' }), row('o3', 'omni', { mediaType: 'message' }),
    row('a1', 'ava', { mediaType: 'voice' }),
  ];
  const s = u.summarize(u.computeRows(raw, cat, r6), 'day', '2026-11-03', '2026-11-03', r6);
  const rule = (g, ch) => (g.category === 'va' ? g[`${ch}Sessions`] / 2 : g.category === 'ava' ? g[`${ch}Sessions`] * 1.2
    : ch === 'voice' ? g.voiceMinutes / 17 : g.digitalTurns / 51);
  for (const g of [...s.byFlow, ...s.byCategory]) {
    for (const ch of ['voice', 'digital']) close(g[`${ch}UsedTokens`], rule(g, ch));
    const t = s.totals[g.category];
    for (const f of ['tokens', 'voiceTokens', 'digitalTokens']) assert.ok(Number.isInteger(g[f]), `${g.key} ${f} = ${g[f]}`);
    assert.ok(Math.abs(g.tokens - g.usedTokens * (t.tokens / t.usedTokens)) < 1, `${g.key} is within one token of its share`);
  }
  // the Type tab matches the tiles channel by channel
  for (const g of s.byCategory) {
    const t = s.totals[g.category];
    close(g.voiceTokens, t.voiceTokens); close(g.digitalTokens, t.digitalTokens); close(g.tokens, t.tokens);
    if (g.category !== 'bot') { assert.equal(g.voiceSessions, t.voiceBillableSessions); assert.equal(g.digitalSessions, t.digitalBillableSessions); }
  }
  const va = s.byFlow.find((g) => g.flowId === 'omni');
  assert.equal(va.digitalSessions, 2); // 3 digital conversations, 1 escalated to AVA
  assert.equal(va.absorbedSessions, 1);
  assert.equal(s.byCategory.find((g) => g.category === 'bot').voiceMinutes, 5); // 17 x 15 s, escalated call not billed
  for (const tab of ['byFlow', 'byCategory', 'byDivision', 'byLanguage', 'byBotProduct']) {
    close(s[tab].reduce((a, g) => a + g.tokens, 0), s.totals.all.tokens);
    close(s[tab].reduce((a, g) => a + g.usedTokens, 0), s.totals.all.usedTokens);
  }
});

test('rule 6: every figure is a whole number and adds up to the rounded totals', () => {
  assert.deepEqual([...u.apportion([{ k: 'a', w: 0.5 }, { k: 'b', w: 0.3 }, { k: 'c', w: 0.2 }], 2, (x) => x.w, (x) => x.k)].map(([, n]) => n), [1, 1, 0]);
  const r6 = { ...rates, tokenRounding: 'type' };
  const cat = { flows: [...catalog.flows, { id: 'vbot2', name: 'Voice bot 2', category: 'bot', isBotFlow: true, flowType: 'bot', avas: [] }] };
  const days = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'];
  const raw = days.flatMap((day, d) => [
    ...Array.from({ length: 30 + d }, (_, i) => ({ ...row(`v${d}-${i}`, 'va', { mediaType: i % 3 ? 'voice' : 'message', language: i % 2 ? 'en-us' : 'es-us' }), day })),
    ...Array.from({ length: 7 }, (_, i) => ({ ...row(`a${d}-${i}`, 'ava', { mediaType: i % 2 ? 'voice' : 'message' }), day })),
    ...Array.from({ length: 40 }, (_, i) => ({ ...row(`b${d}-${i}`, i % 2 ? 'vbot' : 'vbot2', { mediaType: 'CALL', durationMs: 20000 + i * 1000 }), day })),
    { ...row(`d${d}`, 'dbot', { mediaType: 'message', turns: 37 }), day },
  ]);
  const rows = u.computeRows(raw, cat, r6);
  const s = u.summarize(rows, 'day', days[0], days.at(-1), r6);
  for (const c of ['bot', 'va', 'ava']) assert.equal(s.totals[c].tokens, Math.ceil(s.totals[c].usedTokens - 1e-9));
  for (const tab of ['byFlow', 'byCategory', 'byDivision', 'byLanguage', 'byBotProduct', 'byMediaType']) {
    for (const g of s[tab]) for (const f of ['tokens', 'voiceTokens', 'digitalTokens']) assert.ok(Number.isInteger(g[f]), `${tab} ${g.key} ${f} = ${g[f]}`);
    assert.equal(s[tab].reduce((a, g) => a + g.tokens, 0), s.totals.all.tokens);
  }
  for (const b of s.series) for (const c of ['bot', 'va', 'ava']) assert.ok(Number.isInteger(b[c]));
  assert.equal(s.series.reduce((a, b) => a + b.bot + b.va + b.ava, 0), s.totals.all.tokens);
  // a drill-down shows the same whole number as the row it came from
  for (const g of s.byFlow) assert.equal(u.summarize(u.applyFilters(rows, { flowIds: [g.flowId] }), 'day', days[0], days.at(-1), r6).totals.all.tokens, g.tokens);
  for (const g of s.byLanguage) assert.equal(u.summarize(u.applyFilters(rows, { languages: [g.key] }), 'day', days[0], days.at(-1), r6).totals.all.tokens, g.tokens);

  // per bot / flow: every bot with usage rounds up on its own, and the tiles add those up
  const rf = { ...rates, tokenRounding: 'flow' };
  const f = u.summarize(u.computeRows(raw, cat, rf), 'day', days[0], days.at(-1), rf);
  for (const g of f.byFlow) assert.equal(g.tokens, Math.ceil(g.usedTokens - 1e-9));
  assert.equal(f.totals.all.tokens, f.byFlow.reduce((a, g) => a + g.tokens, 0));
});

test('default rounding: each bot rounds up on its own, so 543 Virtual Agent sessions bill 272', () => {
  const r = { ...rates, tokenRounding: undefined };
  const raw = [
    ...Array.from({ length: 543 }, (_, i) => ({ ...row(`v${i}`, 'va'), day: i % 2 ? '2026-11-03' : '2026-11-04' })),
    ...Array.from({ length: 3 }, (_, i) => row(`a${i}`, 'ava')),
  ];
  const s = u.summarize(u.computeRows(raw, catalog, r), 'day', '2026-11-03', '2026-11-04', r);
  assert.equal(s.byFlow.find((g) => g.flowId === 'va').tokens, 272);
  assert.equal(s.byFlow.find((g) => g.flowId === 'ava').tokens, 4); // 3.6 -> 4
  assert.equal(s.totals.all.tokens, 276);
  assert.equal(s.series.reduce((a, b) => a + b.va, 0), 272);
});

test('a voice "bot" flow that serves messaging counts as digital', () => {
  const t = total([row('m1', 'vbot', { mediaType: 'message', turns: 51 })]);
  assert.equal(t.bot.voiceSeconds, 0);
  assert.equal(t.bot.digitalTurns, 51);
  close(t.bot.tokens, 1);
});

test('a day allotted 0 whole tokens keeps its used tokens in the chart series', () => {
  const cat = { flows: [{ id: 'vbot', name: 'JCC Voice Bot 2', category: 'bot', isBotFlow: true, flowType: 'bot', avas: [] }] };
  const raw = [
    ...Array.from({ length: 17 }, (_, i) => ({ ...row(`a${i}`, 'vbot', { durationMs: 800 }), day: '2026-11-05' })),
    ...Array.from({ length: 60 }, (_, i) => ({ ...row(`b${i}`, 'vbot', { durationMs: 50000 }), day: '2026-11-08' })),
  ];
  const rows = u.computeRows(raw, cat, { ...rates, tokenRounding: 'flow' });
  const s = u.summarize(rows, 'day', '2026-11-05', '2026-11-08', rates);
  const nov5 = s.series.find((x) => x.bucket === '2026-11-05');
  assert.equal(nov5.bot, 0);              // its whole token went to the busier day
  assert.ok(nov5.botUsed > 0.25);         // but its usage is still there for the chart
  assert.equal(s.series.reduce((a, x) => a + x.bot, 0), s.totals.bot.tokens);
});
