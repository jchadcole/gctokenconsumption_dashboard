'use strict';
const test = require('node:test');
const assert = require('node:assert');
const u = require('../src/usage');

const rates = { voiceBotMinutesPerToken: 17, voiceBotIncrementSeconds: 15, digitalBotTurnsPerToken: 51, virtualAgentSessionsPerToken: 2, avaTokensPerSession: 1.2 };
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
