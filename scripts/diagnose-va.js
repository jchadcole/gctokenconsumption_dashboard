'use strict';
// Diagnostic: shows how Genesys reports recent bot / Virtual Agent usage, so missing VA sessions can be traced.
//   op run --env-file=.env.tpl -- node scripts/diagnose-va.js [nameFilter] [hoursBack]
// Prints flow metadata, bot aggregates, bot flow sessions and conversation flow segments. No secrets are printed.
require('dotenv').config();
const { GenesysClient } = require('../src/genesys');

const nameFilter = (process.argv[2] || 'JCC').toLowerCase();
const hours = Number(process.argv[3] || 24);
const client = new GenesysClient({
  clientId: process.env.GENESYS_CLIENT_ID, clientSecret: process.env.GENESYS_CLIENT_SECRET,
  region: process.env.GENESYS_REGION || 'mypurecloud.com',
});
const end = new Date(Date.now() + 5 * 60000);
const start = new Date(Date.now() - hours * 3600000);
const interval = `${start.toISOString()}/${end.toISOString()}`;
const out = (label, v) => console.log(`\n===== ${label} =====\n${JSON.stringify(v, null, 2)}`);
const safe = async (label, fn) => { try { out(label, await fn()); } catch (e) { out(`${label} FAILED`, { message: e.message, status: e.status, body: e.body }); } };

(async () => {
  console.log(`interval ${interval}, name filter "${nameFilter}"`);
  const flows = await client.getAllPages('/api/v2/flows', { type: ['bot', 'digitalbot'], deleted: false });
  const mine = flows.filter((f) => f.name.toLowerCase().includes(nameFilter));
  out('bot flows matching name (raw fields)', mine.map((f) => ({
    id: f.id, name: f.name, type: f.type, virtualAgentEnabled: f.virtualAgentEnabled,
    publishedVersionVA: f.publishedVersion?.virtualAgentEnabled, published: !!f.publishedVersion, keys: Object.keys(f),
  })));
  await safe('flows?virtualAgentEnabled=true', async () => (await client.getAllPages('/api/v2/flows', { type: ['bot', 'digitalbot'], virtualAgentEnabled: true }))
    .map((f) => ({ id: f.id, name: f.name, type: f.type, virtualAgentEnabled: f.virtualAgentEnabled })));
  await safe('all flow types matching name', async () => (await client.getAllPages('/api/v2/flows', { name: `*${nameFilter}*` }))
    .map((f) => ({ id: f.id, name: f.name, type: f.type, virtualAgentEnabled: f.virtualAgentEnabled })));
  await safe('textbots/bots/search', async () => (await client.get('/api/v2/textbots/bots/search', { pageSize: 100 })).entities
    ?.filter((b) => String(b.name || '').toLowerCase().includes(nameFilter)));

  await safe('bot aggregates', async () => (await client.post('/api/v2/analytics/bots/aggregates/query', {
    interval, groupBy: ['botId', 'botProduct', 'botFlowType', 'botFlowSubType', 'mediaType'],
    metrics: ['nBotSessions', 'tBotSession', 'nBotSessionTurns'],
  })).results?.map((r) => ({ group: r.group, metrics: r.data?.flatMap((d) => d.metrics) })));

  const convIds = new Set();
  for (const f of mine) {
    await safe(`sessions for ${f.name}`, async () => {
      const res = await client.get(`/api/v2/analytics/botflows/${f.id}/sessions`, { interval, pageSize: 50 });
      (res.entities || []).forEach((s) => s.conversation?.id && convIds.add(s.conversation.id));
      return (res.entities || []).map((s) => ({ id: s.id, conv: s.conversation?.id, channel: s.channel, created: s.dateCreated, completed: s.dateCompleted, flow: s.flow }));
    });
  }

  await safe('flow aggregates by flowType/subType', async () => (await client.post('/api/v2/analytics/flows/aggregates/query', {
    interval, groupBy: ['flowId', 'flowType', 'flowSubType', 'mediaType'], metrics: ['nFlow'],
  })).results?.filter((r) => ['BOT', 'DIGITALBOT', 'bot', 'digitalbot'].includes(r.group.flowType) || r.group.flowSubType).map((r) => ({ group: r.group, metrics: r.data?.flatMap((d) => d.metrics) })));

  for (const id of [...convIds].slice(0, 5)) {
    await safe(`conversation ${id} flow segments`, async () => {
      const c = await client.get(`/api/v2/analytics/conversations/${id}/details`);
      return c.participants?.map((p) => ({
        purpose: p.purpose, name: p.participantName,
        sessions: p.sessions?.map((s) => ({ mediaType: s.mediaType, flow: s.flow, segments: s.segments?.map((g) => `${g.segmentType} ${g.segmentStart}..${g.segmentEnd || ''}`) })),
      }));
    });
  }
})().catch((e) => { console.error(e.message, e.body || ''); process.exit(1); });
