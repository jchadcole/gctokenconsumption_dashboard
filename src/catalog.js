'use strict';
// Builds the catalog of token-consuming flows and classifies each as Bot, Virtual Agent or Agentic Virtual Agent.
//
//   Bot flows / digital bot flows ......... GET /api/v2/flows?type=bot,digitalbot
//   Virtual Agent ......................... flow.virtualAgentEnabled === true
//   Agentic Virtual Agents ................ GET /api/v2/agentic/virtualagents
//   Flows that embed an AVA ............... GET /api/v2/architect/dependencytracking/consumingresources
//                                           ?id={avaId}&objectType=AGENTICVIRTUALAGENT
//
// Genesys bills one interaction at the highest tier it touched (AVA > VA > Bot), so a flow that
// contains an AVA block is classified AVA even if it is also VA-enabled.

const CATEGORY = { BOT: 'bot', VA: 'va', AVA: 'ava' };

// Dependency-tracking types -> analytics flow types
const DEP_TYPE_TO_FLOW_TYPE = {
  BOTFLOW: 'bot', DIGITALBOTFLOW: 'digitalbot', INBOUNDCALLFLOW: 'inboundcall', INBOUNDCHATFLOW: 'inboundchat',
  INBOUNDEMAILFLOW: 'inboundemail', INBOUNDSHORTMESSAGEFLOW: 'inboundshortmessage', INQUEUECALLFLOW: 'inqueuecall',
  INQUEUESHORTMESSAGEFLOW: 'inqueueshortmessage', COMMONMODULEFLOW: 'commonmodule', OUTBOUNDCALLFLOW: 'outboundcall',
  SECURECALLFLOW: 'securecall', WORKFLOW: 'workflow', VOICEFLOW: 'voice',
};

function classify(flow) {
  if (flow.avas && flow.avas.length) return CATEGORY.AVA;
  if (flow.virtualAgentEnabled) return CATEGORY.VA;
  return CATEGORY.BOT;
}

async function buildCatalog(client) {
  const [flows, avas, divisions, org] = await Promise.all([
    client.getAllPages('/api/v2/flows', { type: ['bot', 'digitalbot'], deleted: false }),
    client.getAllPages('/api/v2/agentic/virtualagents').catch((e) => {
      console.warn('[catalog] Could not list agentic virtual agents:', e.message);
      return [];
    }),
    client.getAllPages('/api/v2/authorization/divisions').catch(() => []),
    client.get('/api/v2/organizations/me').catch(() => null),
  ]);

  const divisionName = Object.fromEntries(divisions.map((d) => [d.id, d.name]));
  const byId = new Map();
  for (const f of flows) {
    byId.set(f.id, {
      id: f.id,
      name: f.name,
      flowType: String(f.type || '').toLowerCase(),
      divisionId: f.division?.id || null,
      divisionName: f.division?.name || divisionName[f.division?.id] || null,
      virtualAgentEnabled: !!(f.virtualAgentEnabled ?? f.publishedVersion?.virtualAgentEnabled),
      published: !!f.publishedVersion,
      avas: [],
      isBotFlow: true,
    });
  }

  // Map each AVA to the flows that call it.
  for (const ava of avas) {
    let consumers = [];
    try {
      consumers = await client.getAllPages('/api/v2/architect/dependencytracking/consumingresources', {
        id: ava.id, objectType: 'AGENTICVIRTUALAGENT', flowFilter: 'published',
      });
    } catch (e) {
      console.warn(`[catalog] Dependency lookup failed for AVA ${ava.name}:`, e.message);
    }
    for (const c of consumers) {
      if (!byId.has(c.id)) {
        byId.set(c.id, {
          id: c.id,
          name: c.name,
          flowType: DEP_TYPE_TO_FLOW_TYPE[c.type] || String(c.type || '').toLowerCase(),
          divisionId: null,
          divisionName: null,
          virtualAgentEnabled: false,
          published: true,
          avas: [],
          isBotFlow: false,
        });
      }
      byId.get(c.id).avas.push({ id: ava.id, name: ava.name });
    }
  }

  // Fill in divisions for non-bot flows that embed an AVA.
  const missing = [...byId.values()].filter((f) => !f.divisionId).map((f) => f.id);
  for (let i = 0; i < missing.length; i += 50) {
    const ids = missing.slice(i, i + 50);
    try {
      const res = await client.get('/api/v2/flows/divisionviews', { id: ids, pageSize: 100 });
      for (const v of res.entities || []) {
        const f = byId.get(v.id);
        if (f) { f.divisionId = v.division?.id || null; f.divisionName = v.division?.name || divisionName[v.division?.id] || null; }
      }
    } catch { /* division is optional */ }
  }

  const entries = [...byId.values()].map((f) => ({ ...f, category: classify(f) }));
  return {
    org: org ? { id: org.id, name: org.name } : null,
    flows: entries,
    avas: avas.map((a) => ({ id: a.id, name: a.name, status: a.status })),
    divisions: divisions.map((d) => ({ id: d.id, name: d.name })),
    builtAt: new Date().toISOString(),
  };
}

module.exports = { buildCatalog, classify, CATEGORY };
