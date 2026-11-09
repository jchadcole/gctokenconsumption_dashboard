'use strict';
const test = require('node:test');
const assert = require('node:assert');
const u = require('../src/usage');

const rates = { voiceBotMinutesPerToken: 17, voiceBotIncrementSeconds: 15, digitalBotTurnsPerToken: 51, virtualAgentSessionsPerToken: 2, avaTokensPerSession: 1.2, tokenRounding: 'none' };
const config = { timeZone: 'UTC', maxDaysPerQuery: 31, rates };
const catalog = {
  flows: [
    { id: 'jcc', name: 'JCC Voice Bot 2', category: 'bot', isBotFlow: true, flowType: 'bot', avas: [] },
    { id: 'va', name: 'VA flow', category: 'va', isBotFlow: true, flowType: 'bot', virtualAgentEnabled: true, avas: [] },
  ],
};

// Minimal fake of the Genesys client: bot daily aggregate + bot flow sessions endpoint.
function fakeClient({ sessions, aggregate, sessionsError }) {
  return {
    async post(path) {
      if (path.includes('/bots/aggregates/query')) return { results: aggregate };
      return { results: [] };
    },
    async get(path) {
      if (sessionsError) throw Object.assign(new Error('nope'), { status: 400 });
      const flowId = path.split('/')[5];
      return { entities: sessions.filter((s) => s.flow.id === flowId) };
    },
  };
}
const session = (i, flowId, conv, ms, channel = 'Call') => ({
  id: `s${flowId}${i}`, flow: { id: flowId }, conversation: { id: conv }, channel: { name: channel },
  dateCreated: '2026-11-05T15:00:00.000Z', dateCompleted: new Date(Date.parse('2026-11-05T15:00:00.000Z') + ms).toISOString(),
});
const aggRow = (botId, mediaType, sessions, turns) => ({
  group: { botId, botProduct: 'GenesysBotFlow', mediaType },
  data: [{ interval: '2026-11-05T00:00:00.000Z/2026-11-06T00:00:00.000Z', metrics: [
    { metric: 'nBotSessions', stats: { count: sessions } }, { metric: 'nBotSessionTurns', stats: { count: turns } },
  ] }],
});

test("Chad's case: 17 sub-second calls (analytics says 34 sessions) bill 17 x 15 s = 5 min = 5/17 tokens", async () => {
  const sessions = Array.from({ length: 17 }, (_, i) => session(i, 'jcc', `conv${i}`, 800));
  const client = fakeClient({ sessions, aggregate: [aggRow('jcc', 'CALL', 34, 17)] });
  const rows = await u.getUsage({ client, catalog, config, start: '2026-11-05', end: '2026-11-05' });
  assert.equal(rows.warning, null);
  const s = u.summarize(rows, 'day', '2026-11-05', '2026-11-05', rates);
  assert.equal(s.mode, 'conversation');
  assert.equal(s.byFlow[0].conversations, 17);
  assert.equal(s.byFlow[0].sessions, 17);
  assert.equal(s.totals.bot.voiceSeconds, 255);
  assert.equal(s.totals.bot.voiceMinutesRounded, 5);
  assert.ok(Math.abs(s.totals.bot.tokens - 5 / 17) < 1e-9);
});

test('sessions endpoint feeds the highest-tier rule: voice bot then Virtual Agent in one call = 0.5', async () => {
  const sessions = [session(0, 'jcc', 'c1', 40000), session(0, 'va', 'c1', 90000)];
  const client = fakeClient({ sessions, aggregate: [aggRow('jcc', 'CALL', 1, 2), aggRow('va', 'CALL', 1, 3)] });
  const rows = await u.getUsage({ client, catalog, config, start: '2026-11-05', end: '2026-11-05' });
  const t = u.summarize(rows, 'day', '2026-11-05', '2026-11-05', rates).totals;
  assert.equal(t.all.tokens, 0.5);
  assert.equal(t.bot.absorbedSessions, 1);
});

test('if the sessions endpoint is rejected, bots fall back to daily totals with a warning', async () => {
  const client = fakeClient({ sessionsError: true, aggregate: [aggRow('jcc', 'CALL', 4, 4)] });
  const rows = await u.getUsage({ client, catalog, config, start: '2026-11-05', end: '2026-11-05' });
  assert.match(rows.warning, /Bot session details unavailable/);
  assert.equal(u.summarize(rows, 'day', '2026-11-05', '2026-11-05', rates).mode, 'aggregate');
});

test('turns from the daily aggregate are spread over that flow-day\'s sessions', () => {
  const out = u.allocateTurns(
    [{ flowId: 'd', day: '2026-11-05', conversationId: 'a' }, { flowId: 'd', day: '2026-11-05', conversationId: 'b' }],
    [{ flowId: 'd', day: '2026-11-05', turns: 10, botProduct: 'GenesysDigitalBotFlow' }, { flowId: 'd', day: '2026-11-04', turns: 3 }],
  );
  assert.deepEqual(out.map((r) => r.turns), [5, 5, 3]);
  assert.equal(out[2].conversationId, null);
});

test('only bot flows with activity are queried, and one failing flow does not hide the others', async () => {
  const cat = { flows: [...catalog.flows, { id: 'idle', name: 'Idle bot', category: 'bot', isBotFlow: true, flowType: 'bot', avas: [] }] };
  const asked = [];
  const client = {
    async post(path) { return path.includes('/bots/') ? { results: [aggRow('jcc', 'CALL', 2, 2), aggRow('va', 'CALL', 1, 1)] } : { results: [] }; },
    async get(path) {
      const flowId = path.split('/')[5];
      asked.push(flowId);
      if (flowId === 'va') throw Object.assign(new Error('boom'), { status: 500 });
      return { entities: [session(0, 'jcc', 'c1', 1000), session(1, 'jcc', 'c2', 1000)] };
    },
  };
  const rows = await u.getUsage({ client, catalog: cat, config, start: '2026-11-05', end: '2026-11-05' });
  assert.ok(!asked.includes('idle'));
  assert.match(rows.warning, /VA flow/);
  const s = u.summarize(rows, 'day', '2026-11-05', '2026-11-05', rates);
  assert.equal(s.byFlow.find((f) => f.flowId === 'jcc').conversations, 2);
  assert.equal(s.totals.va.sessions, 1);
});

// Chad's 2026-11-09 calls: JCC Voice Bot 2 hands the call to JCC Virtual Agent inside its own session.
// Analytics reports only the bot's id (botFlowSubType VIRTUAL_AGENT); the Virtual Agent's sessions are
// only on its own sessions endpoint.
function nestedClient({ subType = 'VIRTUAL_AGENT' } = {}) {
  const asked = [];
  const sessions = [
    session(0, 'jcc', 'c1', 14929), session(0, 'va', 'c1', 14263),
    session(1, 'jcc', 'c2', 10520), session(1, 'va', 'c2', 9746),
  ];
  return {
    asked,
    async post(path, body) {
      if (!path.includes('/bots/aggregates/query')) return { results: [] };
      if (body.groupBy.includes('botFlowSubType')) {
        return { results: subType ? [{ group: { botId: 'jcc', botFlowSubType: subType }, data: [{ metrics: [] }] }] : [] };
      }
      return { results: [aggRow('jcc', 'CALL', 2, 4)] };
    },
    async get(path) {
      const flowId = path.split('/')[5];
      asked.push(flowId);
      return { entities: sessions.filter((s) => s.flow.id === flowId) };
    },
  };
}

test('a Virtual Agent nested inside a voice bot is found and bills the calls as Virtual Agent', async () => {
  const client = nestedClient();
  const rows = await u.getUsage({ client, catalog, config, start: '2026-11-05', end: '2026-11-05' });
  assert.ok(client.asked.includes('va'));
  const s = u.summarize(rows, 'day', '2026-11-05', '2026-11-05', rates);
  assert.equal(s.totals.va.sessions, 2);
  assert.equal(s.totals.va.billableSessions, 2);
  assert.equal(s.totals.va.tokens, 1);
  assert.equal(s.totals.va.voiceTokens, 1);
  assert.equal(s.totals.bot.tokens, 0);
  assert.equal(s.totals.bot.absorbedSessions, 2);
  const va = s.byFlow.find((f) => f.flowId === 'va');
  assert.equal(va.name, 'VA flow');
  assert.equal(va.voiceSessions, 2); // billed calls (renamed from voiceConversations)
});

test('nested Virtual Agent tokens round up to a whole token per type', async () => {
  const rows = await u.getUsage({ client: nestedClient(), catalog, config: { ...config, rates: { ...rates, tokenRounding: 'type' } }, start: '2026-11-05', end: '2026-11-05' });
  const t = u.summarize(rows, 'day', '2026-11-05', '2026-11-05', rates).totals;
  assert.equal(t.va.tokens, 1);
  assert.equal(t.all.tokens, 1);
});

test('without a VA/AVA subtype on a plain bot, idle Virtual Agent flows are not queried', async () => {
  const client = nestedClient({ subType: null });
  await u.getUsage({ client, catalog, config, start: '2026-11-05', end: '2026-11-05' });
  assert.deepEqual(client.asked, ['jcc']);
});
