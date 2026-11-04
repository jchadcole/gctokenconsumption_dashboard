'use strict';
// Pulls bot / flow usage from Genesys Cloud analytics and converts it to estimated AI Experience tokens.
//
//   POST /api/v2/analytics/bots/aggregates/query   nBotSessions, tBotSession, nBotSessionTurns
//        grouped by botId, botProduct, mediaType, languageCode (daily buckets)
//   POST /api/v2/analytics/flows/aggregates/query  nFlow for non-bot flows that embed an AVA
//
// Token rules (Genesys Cloud tokens model):
//   Bot, voice ............ minutes / 17, each call rounded up to 15 s
//   Bot, digital .......... sessions / 51
//   Virtual Agent ......... 0.5 tokens per interaction
//   Agentic Virtual Agent . 1.2 tokens per interaction (any interaction that visits a flow with an AVA block)

const { CATEGORY } = require('./catalog');

// Bot products that are Genesys Architect bot flows and therefore token-metered.
const METERED_BOT_PRODUCTS = new Set(['GenesysBotFlow', 'GenesysDigitalBotFlow']);
const VOICE_MEDIA = new Set(['voice', 'callback']);

// ---------- dates ----------
function tzOffset(dateStr, timeZone) {
  // Returns "+HH:MM" for local midnight of dateStr in timeZone.
  const guess = new Date(`${dateStr}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(guess).reduce((a, p) => ({ ...a, [p.type]: p.value }), {});
  const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  const mins = Math.round((local - guess.getTime()) / 60000);
  const sign = mins >= 0 ? '+' : '-';
  const a = Math.abs(mins);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

const addDays = (d, n) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

// Split [start, end] (inclusive dates) into ISO-8601 intervals of at most maxDays.
function chunkIntervals(start, end, maxDays, timeZone) {
  const out = [];
  let cur = start;
  while (cur <= end) {
    const next = addDays(cur, Math.min(maxDays, daysBetween(cur, end) + 1));
    out.push(`${cur}T00:00:00${tzOffset(cur, timeZone)}/${next}T00:00:00${tzOffset(next, timeZone)}`);
    cur = next;
  }
  return out;
}

function localDate(isoInstant, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(isoInstant));
}

function bucketOf(day, granularity) {
  if (granularity === 'month') return day.slice(0, 7);
  if (granularity === 'week') {
    const d = new Date(`${day}T00:00:00Z`);
    const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
    return addDays(day, -dow);
  }
  return day;
}

// ---------- token math ----------
function tokensFor({ category, mediaType, sessions, durationMs, metered }, rates) {
  if (category === CATEGORY.AVA) return sessions * rates.avaTokensPerInteraction;
  if (category === CATEGORY.VA) return sessions * rates.virtualAgentTokensPerInteraction;
  if (!metered) return 0;
  if (VOICE_MEDIA.has(mediaType)) {
    // Analytics returns total duration, not each call, so per-call rounding is estimated as half an increment per call.
    const seconds = durationMs / 1000 + sessions * (rates.voiceBotRoundSeconds / 2);
    return seconds / 60 / rates.voiceBotMinutesPerToken;
  }
  return sessions / rates.digitalBotSessionsPerToken;
}

function billedMinutes({ mediaType, sessions, durationMs }, rates) {
  if (!VOICE_MEDIA.has(mediaType)) return 0;
  return (durationMs / 1000 + sessions * (rates.voiceBotRoundSeconds / 2)) / 60;
}

const stat = (metrics, name, key) => {
  const m = (metrics || []).find((x) => x.metric === name);
  return m ? Number(m.stats?.[key] || 0) : 0;
};

// ---------- analytics fetch ----------
async function fetchBotAggregates(client, intervals, timeZone) {
  const rows = [];
  for (const interval of intervals) {
    const res = await client.post('/api/v2/analytics/bots/aggregates/query', {
      interval,
      granularity: 'P1D',
      timeZone,
      groupBy: ['botId', 'botProduct', 'mediaType', 'languageCode'],
      metrics: ['nBotSessions', 'tBotSession', 'nBotSessionTurns'],
    });
    for (const r of res.results || []) {
      for (const d of r.data || []) {
        rows.push({
          day: localDate(d.interval.split('/')[0], timeZone),
          flowId: r.group.botId,
          botProduct: r.group.botProduct || null,
          mediaType: r.group.mediaType || 'unknown',
          language: r.group.languageCode || null,
          sessions: stat(d.metrics, 'nBotSessions', 'count') || stat(d.metrics, 'tBotSession', 'count'),
          durationMs: stat(d.metrics, 'tBotSession', 'sum'),
          turns: stat(d.metrics, 'nBotSessionTurns', 'count'),
        });
      }
    }
  }
  return rows;
}

async function fetchFlowEntries(client, intervals, timeZone, flowIds) {
  const rows = [];
  if (!flowIds.length) return rows;
  for (let i = 0; i < flowIds.length; i += 50) {
    const ids = flowIds.slice(i, i + 50);
    for (const interval of intervals) {
      const res = await client.post('/api/v2/analytics/flows/aggregates/query', {
        interval,
        granularity: 'P1D',
        timeZone,
        groupBy: ['flowId', 'mediaType', 'divisionId'],
        metrics: ['nFlow'],
        filter: { type: 'or', predicates: ids.map((id) => ({ type: 'dimension', dimension: 'flowId', operator: 'matches', value: id })) },
      });
      for (const r of res.results || []) {
        for (const d of r.data || []) {
          rows.push({
            day: localDate(d.interval.split('/')[0], timeZone),
            flowId: r.group.flowId,
            botProduct: null,
            mediaType: r.group.mediaType || 'unknown',
            language: null,
            divisionId: r.group.divisionId || null,
            sessions: stat(d.metrics, 'nFlow', 'count'),
            durationMs: 0,
            turns: 0,
          });
        }
      }
    }
  }
  return rows;
}

// ---------- shaping ----------
function enrich(rawRows, catalog, rates) {
  const flows = new Map(catalog.flows.map((f) => [f.id, f]));
  return rawRows.map((r) => {
    const f = flows.get(r.flowId);
    const category = f ? f.category : CATEGORY.BOT;
    const metered = f ? (f.isBotFlow || category !== CATEGORY.BOT) : METERED_BOT_PRODUCTS.has(r.botProduct);
    const row = {
      ...r,
      flowName: f?.name || `${r.botProduct || 'Bot'} · ${r.flowId}`,
      flowType: f?.flowType || null,
      divisionId: f?.divisionId || r.divisionId || null,
      divisionName: f?.divisionName || null,
      category,
      metered,
      avaNames: f?.avas?.map((a) => a.name) || [],
    };
    row.minutes = category === CATEGORY.BOT && metered ? billedMinutes(row, rates) : 0;
    row.tokens = tokensFor(row, rates);
    return row;
  });
}

function applyFilters(rows, f) {
  const has = (arr) => Array.isArray(arr) && arr.length > 0;
  return rows.filter((r) =>
    (!has(f.categories) || f.categories.includes(r.category)) &&
    (!has(f.flowIds) || f.flowIds.includes(r.flowId)) &&
    (!has(f.divisionIds) || f.divisionIds.includes(r.divisionId || '__none__')) &&
    (!has(f.mediaTypes) || f.mediaTypes.includes(r.mediaType)) &&
    (!has(f.languages) || f.languages.includes(r.language || '__none__')) &&
    (!has(f.botProducts) || f.botProducts.includes(r.botProduct || '__none__')) &&
    (f.includeUnmetered || r.metered));
}

function groupSum(rows, keyFn, extra = () => ({})) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, { key: k, sessions: 0, minutes: 0, tokens: 0, turns: 0, ...extra(r) });
    const g = m.get(k);
    g.sessions += r.sessions; g.minutes += r.minutes; g.tokens += r.tokens; g.turns += r.turns;
  }
  return [...m.values()].sort((a, b) => b.tokens - a.tokens);
}

function summarize(rows, granularity, start, end) {
  const cats = [CATEGORY.BOT, CATEGORY.VA, CATEGORY.AVA];
  const totals = Object.fromEntries(cats.map((c) => [c, { sessions: 0, minutes: 0, tokens: 0 }]));
  for (const r of rows) {
    const t = totals[r.category];
    t.sessions += r.sessions; t.minutes += r.minutes; t.tokens += r.tokens;
  }
  // Continuous time axis so gaps show as zero.
  const buckets = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const b = bucketOf(d, granularity);
    if (buckets[buckets.length - 1] !== b) buckets.push(b);
  }
  const series = buckets.map((b) => ({ bucket: b, bot: 0, va: 0, ava: 0 }));
  const idx = new Map(series.map((s, i) => [s.bucket, i]));
  for (const r of rows) {
    const i = idx.get(bucketOf(r.day, granularity));
    if (i !== undefined) series[i][r.category] += r.tokens;
  }
  return {
    totals: { ...totals, all: { tokens: cats.reduce((s, c) => s + totals[c].tokens, 0), sessions: cats.reduce((s, c) => s + totals[c].sessions, 0) } },
    series,
    byFlow: groupSum(rows, (r) => r.flowId, (r) => ({
      flowId: r.flowId, name: r.flowName, category: r.category, flowType: r.flowType,
      divisionName: r.divisionName, avaNames: r.avaNames, metered: r.metered,
    })),
    byDivision: groupSum(rows, (r) => r.divisionId || '__none__', (r) => ({ name: r.divisionName || '(unknown)' })),
    byMediaType: groupSum(rows, (r) => r.mediaType, (r) => ({ name: r.mediaType })),
    byLanguage: groupSum(rows, (r) => r.language || '__none__', (r) => ({ name: r.language || '(none)' })),
    byBotProduct: groupSum(rows, (r) => r.botProduct || '__none__', (r) => ({ name: r.botProduct || '(flow entry)' })),
    byCategoryMedia: groupSum(rows, (r) => `${r.category}|${r.mediaType}`, (r) => ({ category: r.category, name: r.mediaType })),
  };
}

async function getUsage({ client, catalog, config, start, end }) {
  const intervals = chunkIntervals(start, end, config.maxDaysPerQuery, config.timeZone);
  const botRows = await fetchBotAggregates(client, intervals, config.timeZone);
  const avaHostFlowIds = catalog.flows.filter((f) => !f.isBotFlow && f.category === CATEGORY.AVA).map((f) => f.id);
  const flowRows = await fetchFlowEntries(client, intervals, config.timeZone, avaHostFlowIds);
  return enrich([...botRows, ...flowRows], catalog, config.rates);
}

module.exports = {
  getUsage, enrich, applyFilters, summarize, tokensFor, chunkIntervals, tzOffset, bucketOf, addDays,
  METERED_BOT_PRODUCTS,
};
