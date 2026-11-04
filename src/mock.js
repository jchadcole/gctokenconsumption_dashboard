'use strict';
// Deterministic sample data so the UI can be explored without Genesys credentials (GENESYS_MOCK=1).
const { classify } = require('./catalog');
const { addDays } = require('./usage');

const DIVS = [
  { id: 'div-retail', name: 'Retail Services' },
  { id: 'div-track', name: 'Tracking & Delivery' },
  { id: 'div-biz', name: 'Business Mail' },
];
const AVAS = [
  { id: 'ava-claims', name: 'Claims Assistant AVA', status: 'Published' },
  { id: 'ava-redelivery', name: 'Redelivery Scheduler AVA', status: 'Published' },
];

// [id, name, flowType, division, virtualAgentEnabled, avaIds, isBotFlow, media, dailyVolume, lang]
const FLOWS = [
  ['f-track-voice', 'Package Tracking Voice Bot', 'bot', 'div-track', false, [], true, 'voice', 900, 'en-us'],
  ['f-track-chat', 'Package Tracking Chat Bot', 'digitalbot', 'div-track', false, [], true, 'message', 1400, 'en-us'],
  ['f-hours-voice', 'Post Office Hours Bot', 'bot', 'div-retail', false, [], true, 'voice', 420, 'en-us'],
  ['f-hours-es', 'Horarios de Oficina Bot', 'bot', 'div-retail', false, [], true, 'voice', 160, 'es-us'],
  ['f-stamps-va', 'Stamps & Supplies Virtual Agent', 'digitalbot', 'div-retail', true, [], true, 'message', 520, 'en-us'],
  ['f-holdmail-va', 'Hold Mail Virtual Agent', 'bot', 'div-retail', true, [], true, 'voice', 310, 'en-us'],
  ['f-po-box-va', 'PO Box Virtual Agent', 'digitalbot', 'div-biz', true, [], true, 'webchat', 180, 'en-us'],
  ['f-claims-ava', 'Claims Intake Bot (AVA)', 'digitalbot', 'div-track', false, ['ava-claims'], true, 'message', 260, 'en-us'],
  ['f-redeliver-in', 'Main Inbound Call Flow', 'inboundcall', 'div-track', false, ['ava-redelivery'], false, 'voice', 340, null],
  ['f-bulk-va', 'Bulk Mail Account Virtual Agent', 'digitalbot', 'div-biz', true, ['ava-claims'], true, 'email', 60, 'en-us'],
];

function rng(seed) {
  let s = 0;
  for (const ch of seed) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function mockCatalog() {
  const divName = Object.fromEntries(DIVS.map((d) => [d.id, d.name]));
  const avaName = Object.fromEntries(AVAS.map((a) => [a.id, a.name]));
  const flows = FLOWS.map(([id, name, flowType, div, va, avaIds, isBotFlow]) => {
    const f = {
      id, name, flowType, divisionId: div, divisionName: divName[div], virtualAgentEnabled: va, published: true,
      avas: avaIds.map((a) => ({ id: a, name: avaName[a] })), isBotFlow,
    };
    return { ...f, category: classify(f) };
  });
  // A third-party bot seen in analytics but not in Architect (not token-metered).
  return { org: { id: 'mock-org', name: 'Sample Org (mock data)' }, flows, avas: AVAS, divisions: DIVS, builtAt: new Date().toISOString() };
}

function mockRawRows(start, end) {
  const rows = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    const weekday = dow === 0 ? 0.45 : dow === 6 ? 0.65 : 1;
    const dayIndex = Math.round((new Date(`${d}T00:00:00Z`) - new Date('2026-01-01T00:00:00Z')) / 86400000);
    const trend = 1 + dayIndex * 0.0012;
    for (const [id, , flowType, , , , isBotFlow, media, vol, lang] of FLOWS) {
      const r = rng(id + d);
      const sessions = Math.max(0, Math.round(vol * weekday * trend * (0.8 + r() * 0.4)));
      const avgSec = media === 'voice' ? 70 + r() * 80 : 0;
      rows.push({
        day: d, flowId: id,
        botProduct: !isBotFlow ? null : flowType === 'bot' ? 'GenesysBotFlow' : 'GenesysDigitalBotFlow',
        mediaType: media, language: lang, sessions,
        durationMs: Math.round(sessions * avgSec * 1000),
        turns: isBotFlow ? Math.round(sessions * (2 + r() * 3)) : 0,
      });
    }
    // Third-party bot via Bot Connector: shows up in analytics, not charged as Genesys tokens.
    const r = rng('lex' + d);
    rows.push({ day: d, flowId: 'lex-faq-bot', botProduct: 'AmazonLex', mediaType: 'voice', language: 'en-us', sessions: Math.round(120 * weekday * (0.8 + r() * 0.4)), durationMs: 0, turns: 0 });
  }
  return rows;
}

const lastDayOfMonth = (d) => { const x = new Date(`${d.slice(0, 7)}-01T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + 1); x.setUTCDate(0); return x.toISOString().slice(0, 10); };

function mockBilling(start, end, estimateTokens) {
  const periodStart = `${end.slice(0, 7)}-01`;
  return {
    contracts: [{ id: 'C-000123', number: 'C-000123', status: 'Active', commercialModel: 'Subscription', dateStart: '2026-01-01', dateEnd: '2028-12-31' }],
    periods: [{
      contractId: 'C-000123', contractNumber: 'C-000123', id: 'bp-mock', dateStart: periodStart, dateEnd: lastDayOfMonth(periodStart), status: 'Open',
      tokenCharges: [
        { name: 'Genesys Cloud Bot Flows - Voice (minutes)', sku: 'SAMPLE', unitOfMeasure: 'Minute', actualQuantity: null, tokens: Math.round(estimateTokens.botVoice), tokenConversionRate: 1 / 17 },
        { name: 'Genesys Cloud Bot Flows - Digital (sessions)', sku: 'SAMPLE', unitOfMeasure: 'Session', actualQuantity: null, tokens: Math.round(estimateTokens.botDigital), tokenConversionRate: 1 / 51 },
        { name: 'Genesys Cloud Virtual Agent', sku: 'SAMPLE', unitOfMeasure: 'Interaction', actualQuantity: null, tokens: Math.round(estimateTokens.va), tokenConversionRate: 0.5 },
        { name: 'Genesys Cloud Agentic Virtual Agent', sku: 'SAMPLE', unitOfMeasure: 'Interaction', actualQuantity: null, tokens: Math.round(estimateTokens.ava), tokenConversionRate: 1.2 },
        { name: 'Agent Copilot', sku: 'SAMPLE', unitOfMeasure: 'Concurrent User', actualQuantity: 40, tokens: 2400, tokenConversionRate: 60 },
      ],
      otherCharges: [],
      totalTokens: 0,
      wallets: [{ name: 'AI Experience Tokens - Prepay', unitOfMeasure: 'Token', startingBalance: 60000, consumption: 0, increase: 350, endingBalance: 0, overage: 0, overageCharge: 0, currency: 'USD' }],
    }],
    errors: [],
    internalOverview: null,
    mock: true,
  };
}

function finalizeMockBilling(b) {
  for (const p of b.periods) {
    p.totalTokens = p.tokenCharges.reduce((s, c) => s + c.tokens, 0);
    const w = p.wallets[0];
    w.consumption = p.totalTokens;
    w.endingBalance = w.startingBalance + w.increase - p.totalTokens;
  }
  return b;
}

module.exports = { mockCatalog, mockRawRows, mockBilling: (...a) => finalizeMockBilling(mockBilling(...a)) };
