'use strict';
const path = require('path');
const express = require('express');
const config = require('./config');
const { GenesysClient } = require('./genesys');
const { buildCatalog, CATEGORY } = require('./catalog');
const usage = require('./usage');
const { getBilling } = require('./billing');
const mock = require('./mock');
const version = require('./version');

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => { res.setHeader('X-App-Version', version.full); next(); });
const client = config.mock ? null : new GenesysClient(config);

let catalogCache = null;
async function getCatalog(force = false) {
  if (!force && catalogCache && Date.now() - catalogCache.at < config.catalogCacheMs) return catalogCache.data;
  const data = config.mock ? mock.mockCatalog() : await buildCatalog(client);
  catalogCache = { at: Date.now(), data };
  return data;
}

// Short-lived cache for raw usage so filter changes do not re-query Genesys.
const usageCache = new Map();
async function getRows(start, end, catalog, { force = false } = {}) {
  const key = `${start}|${end}|${catalog.builtAt}`;
  const hit = usageCache.get(key);
  if (!force && hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.rows;
  const rows = config.mock
    ? usage.computeRows(mock.mockRawRows(start, end), catalog, config.rates)
    : await usage.getUsage({ client, catalog, config, start, end });
  rows.fetchedAt = new Date().toISOString();
  usageCache.set(key, { at: Date.now(), rows });
  if (usageCache.size > 20) usageCache.delete(usageCache.keys().next().value);
  return rows;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const list = (v) => (v === undefined || v === '' ? [] : String(v).split(',').map((s) => s.trim()).filter(Boolean));

function parseQuery(q) {
  const today = new Date().toISOString().slice(0, 10);
  const start = ISO_DATE.test(q.start || '') ? q.start : `${today.slice(0, 7)}-01`;
  const end = ISO_DATE.test(q.end || '') ? q.end : today;
  if (start > end) throw Object.assign(new Error('start must be on or before end'), { status: 400 });
  if (usage.addDays(start, 400) < end) throw Object.assign(new Error('Date range is limited to 400 days'), { status: 400 });
  return {
    start, end,
    granularity: ['day', 'week', 'month'].includes(q.granularity) ? q.granularity : 'day',
    filters: {
      categories: list(q.categories).filter((c) => Object.values(CATEGORY).includes(c)),
      flowIds: list(q.flowIds), divisionIds: list(q.divisionIds), mediaTypes: list(q.mediaTypes),
      languages: list(q.languages), botProducts: list(q.botProducts),
      includeUnmetered: q.includeUnmetered === '1' || q.includeUnmetered === 'true',
    },
  };
}

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error('[api]', e.message);
  res.status(e.status && e.status < 500 ? e.status : 502).json({ error: e.message, path: e.path, details: e.body });
});

app.get('/api/health', (req, res) => res.json({ ok: true, version: version.version, mock: config.mock, region: config.region }));

app.get('/api/version', (req, res) => res.json(version));

app.get('/api/config', (req, res) => res.json({
  version, mock: config.mock, region: config.region, timeZone: config.timeZone, rates: config.rates,
  internalOverviewEnabled: config.enableInternalOverview,
}));

app.get('/api/catalog', wrap(async (req, res) => {
  res.json(await getCatalog(req.query.refresh === '1'));
}));

app.get('/api/usage', wrap(async (req, res) => {
  const q = parseQuery(req.query);
  // refresh=1 (the Refresh button) re-reads the catalog and usage from Genesys instead of the caches.
  const force = req.query.refresh === '1';
  const catalog = await getCatalog(force);
  const all = await getRows(q.start, q.end, catalog, { force });
  const rows = usage.applyFilters(all, q.filters);
  const summary = usage.summarize(rows, q.granularity, q.start, q.end, config.rates);
  // Values present in the unfiltered data, used to populate the drill-down filter controls.
  const uniq = (fn) => [...new Set(all.map(fn).filter(Boolean))].sort();
  res.json({
    query: q,
    summary,
    filterOptions: {
      mediaTypes: uniq((r) => r.mediaType),
      languages: uniq((r) => r.language),
      botProducts: uniq((r) => r.botProduct),
      unmeteredFlows: [...new Set(all.filter((r) => !r.metered).map((r) => r.flowName))],
    },
    warning: all.warning || null,
    rowCount: rows.length,
    generatedAt: new Date().toISOString(),
    dataFetchedAt: all.fetchedAt || null,
  });
}));

app.get('/api/usage.csv', wrap(async (req, res) => {
  const q = parseQuery(req.query);
  const catalog = await getCatalog();
  const rows = usage.applyFilters(await getRows(q.start, q.end, catalog), q.filters);
  const cols = ['day', 'category', 'flowName', 'flowId', 'flowType', 'divisionName', 'mediaType', 'language', 'botProduct', 'sessions', 'billableSessions', 'absorbedSessions', 'turns', 'billableTurns', 'durationMs', 'billedSeconds', 'callMinutes', 'minutes', 'tokens', 'metered', 'avaNames', 'mode'];
  const esc = (v) => {
    const s = Array.isArray(v) ? v.join('; ') : v === null || v === undefined ? '' : typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="genesys-tokens-${q.start}_${q.end}.csv"`);
  res.send([cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'));
}));

app.get('/api/billing', wrap(async (req, res) => {
  const q = parseQuery(req.query);
  if (config.mock) {
    const catalog = await getCatalog();
    const rows = usage.applyFilters(await getRows(`${q.end.slice(0, 7)}-01`, q.end, catalog), {});
    const t = usage.summarize(rows, 'month', `${q.end.slice(0, 7)}-01`, q.end, config.rates).totals;
    return res.json(mock.mockBilling(q.start, q.end, {
      botVoice: t.bot.voiceTokens, botDigital: t.bot.digitalTokens, va: t.va.tokens, ava: t.ava.tokens,
    }));
  }
  res.json(await getBilling(client, { start: q.start, end: q.end, includeInternal: config.enableInternalOverview }));
}));

app.use(express.static(path.join(__dirname, '..', 'public')));

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`Genesys token dashboard v${version.full} on http://localhost:${config.port} (${config.mock ? 'MOCK data' : `region ${config.region}`})`);
  });
}

module.exports = app;
