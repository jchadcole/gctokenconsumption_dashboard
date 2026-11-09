'use strict';
// Pulls bot / flow usage from Genesys Cloud analytics and converts it to estimated AI Experience tokens.
//
//   POST /api/v2/analytics/bots/aggregates/query   nBotSessions, tBotSession, nBotSessionTurns
//        grouped by conversationId, botId, botProduct, mediaType, languageCode (one query per day)
//   POST /api/v2/analytics/flows/aggregates/query  nFlow per conversation for non-bot flows that embed an AVA
//   GET  /api/v2/analytics/botflows/{id}/sessions  per-session rows for active bot flows, and for Virtual
//        Agents / AVAs nested inside a bot (those are only reported under the calling bot's botId, with
//        botFlowSubType VIRTUAL_AGENT / AGENTIC_VIRTUAL_AGENT)
//
// Token rules:
//   1. Voice bot ........... each call billed in 15 s increments (rounded up); the total is rounded up
//                            to a whole minute and divided by 17. The extra seconds from that last
//                            step are shared across voice rows by their billed seconds, so every
//                            row, chart bar, breakdown and drill-down adds up to the Bots total.
//   2. Digital bot ......... prompt/response turns / 51
//   3. Virtual Agent ....... sessions / 2
//   4. Agentic VA .......... 1.2 tokens per session
//   5. A conversation consumes tokens only for the highest tier it reached (AVA > VA > Bot)
//   6. Token consumption is rounded up to a whole token (TOKEN_ROUNDING sets the level: per type by
//      default). The extra is shared across rows by their tokens, like the voice minute rounding.

const { CATEGORY } = require('./catalog');

// Bot products that are Genesys Architect bot flows and therefore token-metered.
const METERED_BOT_PRODUCTS = new Set(['GenesysBotFlow', 'GenesysDigitalBotFlow']);
// Analytics reports voice as "CALL" for bot sessions and "voice" elsewhere; compare case-insensitively.
const VOICE_MEDIA = new Set(['voice', 'call', 'callback']);
const DIGITAL_MEDIA = new Set(['message', 'messaging', 'chat', 'webchat', 'webmessaging', 'email', 'sms']);
const VOICE_BOT_PRODUCTS = new Set(['GenesysBotFlow']);

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

// ---------- token rules ----------
// Tier order for "highest level of AI used" (rule 5).
const TIER = { [CATEGORY.BOT]: 1, [CATEGORY.VA]: 2, [CATEGORY.AVA]: 3 };
// A row is voice when its flow is a voice bot flow (Architect type "bot"), its bot product is the
// voice bot flow product, or its media type is a voice media type. Digital bot flows are never voice.
// A known digital media type wins over the flow type: an Architect "bot" flow can also serve
// messaging (seen on GenesysSC12, where an AVA-enabled bot flow ran 186 messaging sessions).
function isVoiceRow(r) {
  if (r.flowType === 'digitalbot') return false;
  const media = String(r.mediaType || '').toLowerCase();
  if (DIGITAL_MEDIA.has(media)) return false;
  if (r.flowType === 'bot' || VOICE_BOT_PRODUCTS.has(r.botProduct)) return true;
  return VOICE_MEDIA.has(media);
}

// Rule 1: each voice-bot call is billed in increments (15 s), rounded up.
function billedCallSeconds(durationMs, rates) {
  const inc = rates.voiceBotIncrementSeconds;
  const sec = Math.max(0, durationMs) / 1000;
  return sec > 0 ? Math.ceil(sec / inc - 1e-9) * inc : 0;
}

// Token value of one row's billable usage. Voice-bot tokens here are before the final
// "round the total up to a whole minute" step, which allocateVoiceRounding() applies.
function rowTokens(r, rates) {
  if (!r.metered) return 0;
  if (r.category === CATEGORY.AVA) return r.billableSessions * rates.avaTokensPerSession;            // rule 4
  if (r.category === CATEGORY.VA) return r.billableSessions / rates.virtualAgentSessionsPerToken;     // rule 3
  if (isVoiceRow(r)) return r.billedSeconds / 60 / rates.voiceBotMinutesPerToken;              // rule 1
  return r.billableTurns / rates.digitalBotTurnsPerToken;                                             // rule 2
}

// Rule 5: a conversation consumes tokens only for the highest tier it reached.
// Rows of lower tiers in the same conversation are kept for reporting but bill nothing.
function applyHighestTier(convRows, rates) {
  const top = new Map();
  for (const r of convRows) {
    if (!r.metered) continue;
    const t = TIER[r.category];
    if ((top.get(r.conversationId) || 0) < t) top.set(r.conversationId, t);
  }
  return convRows.map((r) => {
    const billable = r.metered && TIER[r.category] === top.get(r.conversationId);
    const voiceBot = billable && r.category === CATEGORY.BOT && isVoiceRow(r);
    const out = {
      ...r,
      conversations: 1,
      billableSessions: billable ? r.sessions : 0,
      billableTurns: billable ? r.turns : 0,
      absorbedSessions: r.metered && !billable ? r.sessions : 0,
      billedSeconds: voiceBot ? billedCallSeconds(r.durationMs, rates) : 0,
    };
    out.tokens = rowTokens(out, rates);
    return out;
  });
}

// Fallback when per-conversation data is unavailable: no de-duplication across flows, and
// per-call rounding is estimated as half an increment per call.
function applyAggregateRules(rows, rates) {
  return rows.map((r) => {
    const voiceBot = r.metered && r.category === CATEGORY.BOT && isVoiceRow(r);
    const out = {
      ...r,
      billableSessions: r.metered ? r.sessions : 0,
      billableTurns: r.metered ? r.turns : 0,
      absorbedSessions: 0,
      billedSeconds: voiceBot ? r.durationMs / 1000 + r.sessions * (rates.voiceBotIncrementSeconds / 2) : 0,
    };
    out.tokens = rowTokens(out, rates);
    return out;
  });
}

const SUM_FIELDS = ['conversations', 'sessions', 'turns', 'durationMs', 'billedSeconds', 'billableSessions', 'billableTurns', 'absorbedSessions', 'tokens'];

// Drop the conversation dimension once the rules are applied: one row per day / flow / media / language.
function collapse(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = [r.day, r.flowId, r.mediaType, r.language || '', r.botProduct || ''].join('|');
    let g = m.get(k);
    if (!g) {
      g = { ...r };
      delete g.conversationId;
      for (const f of SUM_FIELDS) g[f] = 0;
      m.set(k, g);
    }
    for (const f of SUM_FIELDS) g[f] += r[f] || 0;
  }
  return [...m.values()].map((g) => ({ ...g, callMinutes: g.billedSeconds / 60, minutes: g.billedSeconds / 60 }));
}

const isVoiceBotRow = (r) => r.metered && r.category === CATEGORY.BOT && isVoiceRow(r) && r.billedSeconds > 0;

// Rule 1, last step: the voice-bot total for the date range is rounded up to a whole minute. The extra
// seconds that adds are shared across the voice rows in proportion to their billed seconds, so each
// row's billed minutes and tokens include its share and the rows always add up to the rounded total.
// Filters and drill-downs then show a subset's share of the bill rather than rounding it again.
//   callMinutes ... voice time after per-call 15 s rounding
//   minutes ....... billed voice minutes (callMinutes plus its share of the whole-minute rounding)
function allocateVoiceRounding(rows, rates) {
  const voice = rows.filter(isVoiceBotRow);
  const seconds = voice.reduce((s, r) => s + r.billedSeconds, 0);
  if (!seconds) return rows;
  const factor = (Math.ceil(seconds / 60 - 1e-9) * 60) / seconds;
  return rows.map((r) => {
    if (!isVoiceBotRow(r)) return r;
    const minutes = (r.billedSeconds / 60) * factor;
    return { ...r, minutes, tokens: minutes / rates.voiceBotMinutesPerToken };
  });
}

const stat = (metrics, name, key) => {
  const m = (metrics || []).find((x) => x.metric === name);
  return m ? Number(m.stats?.[key] || 0) : 0;
};

// ---------- analytics fetch ----------
const BOT_METRICS = ['nBotSessions', 'tBotSession', 'nBotSessionTurns'];
const flowPredicates = (ids) => ({ type: 'or', predicates: ids.map((id) => ({ type: 'dimension', dimension: 'flowId', operator: 'matches', value: id })) });

function botRow(group, data, day) {
  return {
    day,
    conversationId: group.conversationId || null,
    flowId: group.botId,
    botProduct: group.botProduct || null,
    mediaType: group.mediaType || 'unknown',
    language: group.languageCode || null,
    sessions: stat(data.metrics, 'nBotSessions', 'count') || stat(data.metrics, 'tBotSession', 'count'),
    durationMs: stat(data.metrics, 'tBotSession', 'sum'),
    turns: stat(data.metrics, 'nBotSessionTurns', 'count'),
  };
}
function flowRow(group, data, day) {
  return {
    day,
    conversationId: group.conversationId || null,
    flowId: group.flowId,
    botProduct: null,
    mediaType: group.mediaType || 'unknown',
    language: null,
    divisionId: group.divisionId || null,
    sessions: stat(data.metrics, 'nFlow', 'count'),
    durationMs: 0,
    turns: 0,
  };
}

// One row per bot session, from the bot flow sessions endpoint. Each session carries its
// conversation id and start/end times, which gives exact per-call durations and lets the
// highest-tier rule see every bot a conversation used.
//   GET /api/v2/analytics/botflows/{botFlowId}/sessions?interval=..&pageSize=250&after=..
const CHANNEL_MEDIA = { call: 'voice', chat: 'chat', messaging: 'message' };
async function fetchBotFlowSessions(client, botFlowIds, start, end, timeZone, maxDays, { concurrency = 4 } = {}) {
  const rows = [];
  const failed = [];
  const intervals = chunkIntervals(start, end, maxDays, timeZone);
  const queue = [...botFlowIds];
  const worker = async () => {
    while (queue.length) {
      const flowId = queue.shift();
      try {
        rows.push(...await fetchOneFlowSessions(client, flowId, intervals, start, end, timeZone));
      } catch (e) {
        failed.push({ flowId, error: e });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, botFlowIds.length) }, worker));
  return { rows, failed };
}

async function fetchOneFlowSessions(client, flowId, intervals, start, end, timeZone) {
  const rows = [];
  {
    for (const interval of intervals) {
      let after;
      for (let page = 0; page < 400; page++) {
        const res = await client.get(`/api/v2/analytics/botflows/${encodeURIComponent(flowId)}/sessions`, { interval, pageSize: 250, after });
        for (const ses of res.entities || []) {
          if (!ses.dateCreated) continue;
          const day = localDate(ses.dateCreated, timeZone);
          if (day < start || day > end) continue;
          const created = Date.parse(ses.dateCreated);
          const completed = ses.dateCompleted ? Date.parse(ses.dateCompleted) : created;
          const channel = String(ses.channel?.name || '').toLowerCase();
          rows.push({
            day,
            conversationId: ses.conversation?.id || `session:${ses.id}`,
            sessionId: ses.id,
            flowId: ses.flow?.id || flowId,
            botProduct: null,
            mediaType: CHANNEL_MEDIA[channel] || channel || 'unknown',
            language: ses.language || ses.endLanguage || null,
            sessions: 1,
            durationMs: Math.max(0, completed - created),
            turns: 0,
          });
        }
        after = res.nextUri ? new URL(res.nextUri, 'https://x').searchParams.get('after') : null;
        if (!after || !(res.entities || []).length) break;
      }
    }
  }
  return rows;
}

// The sessions endpoint has no turn counts, so each flow-day's turns (from the daily bot aggregate)
// are spread evenly over that flow-day's sessions. Aggregate rows with no matching sessions are kept
// as daily totals so nothing is dropped.
function allocateTurns(sessionRows, aggRows) {
  const key = (r) => `${r.flowId}|${r.day}`;
  const count = new Map();
  for (const r of sessionRows) count.set(key(r), (count.get(key(r)) || 0) + 1);
  const agg = new Map();
  for (const r of aggRows) {
    const g = agg.get(key(r)) || { turns: 0, botProduct: r.botProduct };
    g.turns += r.turns;
    agg.set(key(r), g);
  }
  const out = sessionRows.map((r) => {
    const g = agg.get(key(r));
    return { ...r, turns: g ? g.turns / count.get(key(r)) : 0, botProduct: r.botProduct || g?.botProduct || null };
  });
  const leftovers = aggRows.filter((r) => !count.has(key(r))).map((r) => ({ ...r, conversationId: null }));
  return [...out, ...leftovers];
}

// Per-conversation entries into non-bot flows that contain an AVA block, one query per day.
async function fetchFlowConversationRows(client, start, end, timeZone, flowIds) {
  const rows = [];
  if (!flowIds.length) return rows;
  for (let day = start; day <= end; day = addDays(day, 1)) {
    const next = addDays(day, 1);
    const interval = `${day}T00:00:00${tzOffset(day, timeZone)}/${next}T00:00:00${tzOffset(next, timeZone)}`;
    for (let i = 0; i < flowIds.length; i += 50) {
      const res = await client.post('/api/v2/analytics/flows/aggregates/query', {
        interval, timeZone, groupBy: ['conversationId', 'flowId', 'mediaType', 'divisionId'], metrics: ['nFlow'],
        filter: flowPredicates(flowIds.slice(i, i + 50)),
      });
      for (const r of res.results || []) for (const d of r.data || []) rows.push(flowRow(r.group, d, day));
    }
  }
  return rows;
}

// Daily totals without the conversation dimension (fallback).
async function fetchAggregateRows(client, intervals, timeZone, avaHostFlowIds) {
  const rows = [];
  for (const interval of intervals) {
    const res = await client.post('/api/v2/analytics/bots/aggregates/query', {
      interval, granularity: 'P1D', timeZone, groupBy: ['botId', 'botProduct', 'mediaType', 'languageCode'], metrics: BOT_METRICS,
    });
    for (const r of res.results || []) for (const d of r.data || []) rows.push(botRow(r.group, d, localDate(d.interval.split('/')[0], timeZone)));
    for (let i = 0; i < avaHostFlowIds.length; i += 50) {
      const f = await client.post('/api/v2/analytics/flows/aggregates/query', {
        interval, granularity: 'P1D', timeZone, groupBy: ['flowId', 'mediaType', 'divisionId'], metrics: ['nFlow'],
        filter: flowPredicates(avaHostFlowIds.slice(i, i + 50)),
      });
      for (const r of f.results || []) for (const d of r.data || []) rows.push(flowRow(r.group, d, localDate(d.interval.split('/')[0], timeZone)));
    }
  }
  return rows;
}

// A Virtual Agent or AVA that a bot flow calls (nested inside the bot's session) never appears in the
// bot or flow aggregates under its own id: its usage is reported under the calling bot's botId with
// botFlowSubType VIRTUAL_AGENT / AGENTIC_VIRTUAL_AGENT. Its own sessions are only visible from
// /analytics/botflows/{id}/sessions. This returns, per botId, the AI subtypes the aggregates report.
const AI_SUBTYPES = { VIRTUAL_AGENT: CATEGORY.VA, AGENTIC_VIRTUAL_AGENT: CATEGORY.AVA };
async function fetchBotSubTypes(client, intervals, timeZone) {
  const out = new Map();
  for (const interval of intervals) {
    const res = await client.post('/api/v2/analytics/bots/aggregates/query', {
      interval, timeZone, groupBy: ['botId', 'botFlowSubType'], metrics: BOT_METRICS,
    });
    for (const r of res.results || []) {
      const cat = AI_SUBTYPES[String(r.group?.botFlowSubType || '').toUpperCase()];
      if (!cat || !r.group.botId) continue;
      if (!out.has(r.group.botId)) out.set(r.group.botId, new Set());
      out.get(r.group.botId).add(cat);
    }
  }
  return out;
}

// Bot flows whose analytics show Virtual Agent / AVA usage above their own category, i.e. bots that
// handed the call to a nested Virtual Agent or AVA.
function hostsOfNestedAi(subTypes, catalog) {
  const flows = new Map(catalog.flows.map((f) => [f.id, f]));
  return [...subTypes.entries()]
    .filter(([id, cats]) => [...cats].some((c) => TIER[c] > TIER[flows.get(id)?.category || CATEGORY.BOT]))
    .map(([id]) => id);
}

// ---------- shaping ----------
function enrich(rawRows, catalog) {
  const flows = new Map(catalog.flows.map((f) => [f.id, f]));
  return rawRows.map((r) => {
    const f = flows.get(r.flowId);
    const category = f ? f.category : CATEGORY.BOT;
    return {
      ...r,
      flowName: f?.name || `${r.botProduct || 'Bot'} · ${r.flowId}`,
      flowType: f?.flowType || null,
      divisionId: f?.divisionId || r.divisionId || null,
      divisionName: f?.divisionName || null,
      category,
      metered: f ? (f.isBotFlow || category !== CATEGORY.BOT) : METERED_BOT_PRODUCTS.has(r.botProduct),
      avaNames: f?.avas?.map((a) => a.name) || [],
    };
  });
}

// Rule 6: token consumption is rounded up to whole tokens. The rounding level is
//   flow ...... each bot / flow's total is rounded up on its own, and the tiles add those up (default)
//   type ...... Bot, Virtual Agent and AVA totals are each rounded up
//   product ... voice bot, digital bot, Virtual Agent and AVA are each rounded up
//   total ..... only the all-types total is rounded up
//   none ...... no token rounding (rows keep fractional tokens)
// Every figure the dashboard shows is a whole number that adds up to the rounded totals. The whole
// tokens of each group are handed out in two steps with the largest remainder method:
//   1. group total (rounded up) -> each bot / flow, in proportion to the tokens it used
//   2. each bot / flow's whole tokens -> its rows (day, channel, language, ...), the same way
// So a bot's tokens never depend on which tab or filter is showing, every tab, chart bar and
// drill-down is a whole number, and they all add up to the tiles. usedTokens keeps the value
// before rounding (the rule applied to the row's billed units).
const ROUNDING_GROUP = {
  type: (r) => r.category,
  product: (r) => (r.category === CATEGORY.BOT ? (isVoiceRow(r) ? 'bot-voice' : 'bot-digital') : r.category),
  total: () => 'all',
  flow: (r) => r.flowId,
};

// Split a whole number `total` over items in proportion to weight(item), as whole numbers that add
// up to `total` (largest remainder; ties go to the larger weight, then to the key, so it is stable).
function apportion(items, total, weight, key) {
  const sum = items.reduce((s, it) => s + weight(it), 0);
  if (!items.length) return new Map();
  if (!(sum > 0)) return new Map(items.map((it, i) => [key(it), i === 0 ? total : 0]));
  const shares = items.map((it) => {
    const exact = (total * weight(it)) / sum;
    const base = Math.floor(exact + 1e-9);
    return { k: key(it), w: weight(it), base, frac: exact - base };
  });
  let left = total - shares.reduce((s, x) => s + x.base, 0);
  const order = [...shares].sort((a, b) => b.frac - a.frac || b.w - a.w || String(a.k).localeCompare(String(b.k)));
  for (let i = 0; left > 0 && order.length; i = (i + 1) % order.length, left--) order[i].base += 1;
  return new Map(shares.map((x) => [x.k, x.base]));
}

function allocateTokenRounding(rows, rates) {
  const groupOf = ROUNDING_GROUP[rates.tokenRounding || 'flow'];
  const out = rows.map((r, i) => ({ ...r, usedTokens: r.tokens, _i: i }));
  if (!groupOf) return out.map(({ _i, ...r }) => r);
  const billed = out.filter((r) => r.metered && r.tokens > 0);
  const byGroup = new Map();
  for (const r of billed) {
    const g = groupOf(r);
    if (!byGroup.has(g)) byGroup.set(g, new Map());
    const flows = byGroup.get(g);
    if (!flows.has(r.flowId)) flows.set(r.flowId, []);
    flows.get(r.flowId).push(r);
  }
  const whole = new Map(); // row index -> whole tokens
  for (const flows of byGroup.values()) {
    const list = [...flows.entries()].map(([flowId, rs]) => ({ flowId, rs, used: rs.reduce((s, r) => s + r.tokens, 0) }));
    const total = Math.ceil(list.reduce((s, f) => s + f.used, 0) - 1e-9);
    const perFlow = apportion(list, total, (f) => f.used, (f) => f.flowId);
    for (const f of list) {
      const perRow = apportion(f.rs, perFlow.get(f.flowId), (r) => r.tokens, (r) => r._i);
      for (const [i, n] of perRow) whole.set(i, n);
    }
  }
  return out.map(({ _i, ...r }) => (whole.has(_i) ? { ...r, tokens: whole.get(_i) } : r));
}

// raw rows -> rows with tokens. Rows that carry a conversationId get the per-conversation rules
// (exact per-call rounding, highest tier only); rows without one are billed as daily totals.
function computeRows(rawRows, catalog, rates) {
  const enriched = enrich(rawRows, catalog);
  const conv = enriched.filter((r) => r.conversationId);
  const daily = enriched.filter((r) => !r.conversationId);
  return allocateTokenRounding(allocateVoiceRounding([
    ...collapse(applyHighestTier(conv, rates)).map((r) => ({ ...r, mode: 'conversation' })),
    ...collapse(applyAggregateRules(daily, rates)).map((r) => ({ ...r, mode: 'aggregate', conversations: null })),
  ], rates), rates);
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

const GROUP_FIELDS = ['conversations', 'sessions', 'turns', 'callMinutes', 'minutes', 'usedTokens', 'tokens', 'absorbedSessions', 'billableSessions', 'billableTurns'];
// Each group also splits its usage by channel, because a bot, Virtual Agent or AVA can be voice,
// digital or both:
//   voiceSessions / digitalSessions ... billed sessions: the calls / digital conversations billed at
//                                       this row's tier (escalated ones are in absorbedSessions)
//   voiceMinutes ...... billed voice-bot minutes        digitalTurns ... billed digital-bot turns
//   voiceTokens / digitalTokens ... tokens per channel; they add up to tokens
//   voiceUsedTokens / digitalUsedTokens ... the same before the whole-token round-up (rule 6), so
//                                           each equals the rule applied to the row's billed units
// botVoice / botDigital say whether bot usage of that channel is present, so turns and minutes
// can be left blank where they do not apply (Virtual Agents and AVAs bill per session).
const CHANNEL_FIELDS = ['voiceSessions', 'voiceMinutes', 'voiceTokens', 'voiceUsedTokens', 'digitalSessions', 'digitalTurns', 'digitalTokens', 'digitalUsedTokens'];
const channelOf = (r) => (isVoiceRow(r) ? 'voice' : 'digital');
function groupSum(rows, keyFn, extra = () => ({})) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, { key: k, ...Object.fromEntries([...GROUP_FIELDS, ...CHANNEL_FIELDS].map((f) => [f, 0])), channels: [], botVoice: false, botDigital: false, ...extra(r) });
    const g = m.get(k);
    for (const f of GROUP_FIELDS) g[f] += r[f] || 0;
    const ch = channelOf(r);
    if (!g.channels.includes(ch)) g.channels.push(ch);
    g[`${ch}Sessions`] += r.billableSessions || 0;
    g[`${ch}Tokens`] += r.tokens || 0;
    g[`${ch}UsedTokens`] += r.usedTokens ?? r.tokens ?? 0;
    if (r.category === CATEGORY.BOT) {
      if (ch === 'voice') { g.voiceMinutes += r.minutes || 0; g.botVoice = true; } else { g.digitalTurns += r.billableTurns || 0; g.botDigital = true; }
    }
  }
  return [...m.values()].map((g) => ({ ...g, channels: g.channels.sort().reverse() })).sort((a, b) => b.tokens - a.tokens);
}

function summarize(rows, granularity, start, end, rates) {
  const cats = [CATEGORY.BOT, CATEGORY.VA, CATEGORY.AVA];
  const totals = Object.fromEntries(cats.map((c) => [c, { sessions: 0, billableSessions: 0, turns: 0, callMinutes: 0, minutes: 0, usedTokens: 0, tokens: 0, absorbedSessions: 0 }]));
  let voiceSeconds = 0; let voiceMinutes = 0; let voiceTokens = 0; let digitalTurns = 0; let digitalTokens = 0;
  for (const r of rows) {
    const t = totals[r.category];
    t.sessions += r.sessions; t.billableSessions += r.billableSessions; t.turns += r.turns;
    const ch = channelOf(r);
    t[`${ch}Tokens`] = (t[`${ch}Tokens`] || 0) + r.tokens;
    t[`${ch}BillableSessions`] = (t[`${ch}BillableSessions`] || 0) + r.billableSessions;
    t.callMinutes += r.callMinutes || 0; t.minutes += r.minutes; t.usedTokens += r.usedTokens ?? r.tokens; t.tokens += r.tokens; t.absorbedSessions += r.absorbedSessions;
    if (r.category === CATEGORY.BOT && r.metered) {
      if (isVoiceRow(r)) { voiceSeconds += r.billedSeconds; voiceMinutes += r.minutes; voiceTokens += r.tokens; } else { digitalTurns += r.billableTurns; digitalTokens += r.tokens; }
    }
  }
  // Every figure is a sum of row values, which already carry the rounding (allocateVoiceRounding),
  // so tiles, chart and breakdowns agree. Trim float noise so 4.999999 shows as 5.
  const tidy = (v) => Math.round(v * 1e9) / 1e9;
  for (const c of cats) { totals[c].tokens = tidy(totals[c].tokens); totals[c].usedTokens = tidy(totals[c].usedTokens); }
  for (const c of cats) for (const ch of ['voice', 'digital']) { totals[c][`${ch}Tokens`] = tidy(totals[c][`${ch}Tokens`] || 0); totals[c][`${ch}BillableSessions`] = totals[c][`${ch}BillableSessions`] || 0; }
  totals.bot.voiceSeconds = voiceSeconds;
  totals.bot.voiceMinutesRounded = tidy(voiceMinutes);
  totals.bot.voiceTokens = rates ? tidy(voiceTokens) : null;
  totals.bot.digitalTurns = digitalTurns;
  totals.bot.digitalTokens = rates ? tidy(digitalTokens) : null;

  // Continuous time axis so gaps show as zero.
  const buckets = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const b = bucketOf(d, granularity);
    if (buckets[buckets.length - 1] !== b) buckets.push(b);
  }
  // Each bucket carries the whole tokens it was allotted (bot / va / ava, which add up to the tiles)
  // and the tokens used before the round-up (botUsed / vaUsed / avaUsed). A bot's whole tokens are
  // handed to its busiest days, so a quieter day can be allotted 0 tokens while still having usage;
  // the chart uses the *Used values to keep that day visible.
  const series = buckets.map((b) => ({ bucket: b, bot: 0, va: 0, ava: 0, botUsed: 0, vaUsed: 0, avaUsed: 0 }));
  const idx = new Map(series.map((s, i) => [s.bucket, i]));
  for (const r of rows) {
    const i = idx.get(bucketOf(r.day, granularity));
    if (i === undefined) continue;
    series[i][r.category] += r.tokens;
    series[i][`${r.category}Used`] += r.usedTokens ?? r.tokens;
  }
  for (const s of series) for (const c of cats) s[`${c}Used`] = tidy(s[`${c}Used`]);
  const modes = [...new Set(rows.filter((r) => r.metered).map((r) => r.mode).filter(Boolean))];
  return {
    totals: {
      ...totals,
      all: {
        tokens: tidy(cats.reduce((s, c) => s + totals[c].tokens, 0)),
        usedTokens: tidy(cats.reduce((s, c) => s + totals[c].usedTokens, 0)),
        sessions: cats.reduce((s, c) => s + totals[c].sessions, 0),
        absorbedSessions: cats.reduce((s, c) => s + totals[c].absorbedSessions, 0),
      },
    },
    mode: modes.length === 1 ? modes[0] : modes.length ? 'mixed' : null,
    series,
    byCategory: groupSum(rows, (r) => r.category, (r) => ({ category: r.category })),
    byFlow: groupSum(rows, (r) => r.flowId, (r) => ({
      flowId: r.flowId, name: r.flowName, category: r.category, flowType: r.flowType, mode: r.mode,
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
  console.log(`[usage] reading ${start}..${end} from Genesys Cloud`);
  const tz = config.timeZone;
  const intervals = chunkIntervals(start, end, config.maxDaysPerQuery, tz);
  const botFlowIds = catalog.flows.filter((f) => f.isBotFlow).map((f) => f.id);
  const botFlowSet = new Set(botFlowIds);
  const avaHostFlowIds = catalog.flows.filter((f) => !f.isBotFlow && f.category === CATEGORY.AVA).map((f) => f.id);
  const warnings = [];
  const isClientError = (e) => e.status >= 400 && e.status < 500 && e.status !== 401;

  // Daily bot totals: turn counts, bot products, and third-party bots that are not Architect flows.
  const daily = (await fetchAggregateRows(client, intervals, tz, [])).map((r) => ({ ...r, conversationId: null }));

  // Only bot flows with activity in the range need their sessions read.
  const active = [...new Set(daily.filter((r) => botFlowSet.has(r.flowId) && r.sessions > 0).map((r) => r.flowId))];
  const { rows: sessions, failed } = await fetchBotFlowSessions(client, active, start, end, tz, config.maxDaysPerQuery);
  if (failed.length) {
    const names = new Map(catalog.flows.map((f) => [f.id, f.name]));
    warnings.push(`Bot session details unavailable for ${failed.map((f) => names.get(f.flowId) || f.flowId).join(', ')} (${failed[0].error.message}). Those bots are shown as daily totals, so per-call rounding is estimated and the highest-tier rule is not applied to them.`);
  }

  // Nested Virtual Agents / AVAs: when a bot reports VA or AVA usage it is not classified as, read the
  // sessions of every Virtual Agent and AVA bot flow that the aggregates did not already show as active.
  // Their sessions share the calling bot's conversation id, so the highest-tier rule bills the call
  // once, as the Virtual Agent / AVA, and the calling bot's session is shown as absorbed.
  let hosts = [];
  try {
    hosts = hostsOfNestedAi(await fetchBotSubTypes(client, intervals, tz), catalog);
  } catch (e) {
    if (!isClientError(e)) throw e;
    console.warn('[usage] bot subtype aggregate unavailable:', e.message);
  }
  if (hosts.length) {
    const activeSet = new Set(active);
    const candidates = catalog.flows.filter((f) => f.isBotFlow && f.category !== CATEGORY.BOT && !activeSet.has(f.id)).map((f) => f.id);
    const nested = await fetchBotFlowSessions(client, candidates, start, end, tz, config.maxDaysPerQuery, { concurrency: 8 });
    sessions.push(...nested.rows);
    if (nested.failed.length) {
      warnings.push(`Session details could not be read for ${nested.failed.length} Virtual Agent / AVA flow(s) (${nested.failed[0].error.message}), so Virtual Agents called from inside a bot may be missing.`);
    }
    console.log(`[usage] ${hosts.length} bot flow(s) called a nested Virtual Agent / AVA; checked ${candidates.length} VA/AVA flows, ${nested.rows.length} nested sessions found`);
  }
  const raw = [...allocateTurns(sessions, daily.filter((r) => botFlowSet.has(r.flowId))), ...daily.filter((r) => !botFlowSet.has(r.flowId))];

  try {
    raw.push(...await fetchFlowConversationRows(client, start, end, tz, avaHostFlowIds));
  } catch (e) {
    if (!isClientError(e)) throw e;
    warnings.push(`Per-conversation data for flows with an AVA is unavailable (${e.message}). Those AVA sessions are billed from daily totals, without the highest-tier rule.`);
    raw.push(...(await fetchAggregateRows(client, intervals, tz, avaHostFlowIds)).filter((r) => !r.botProduct && avaHostFlowIds.includes(r.flowId)).map((r) => ({ ...r, conversationId: null })));
  }
  console.log(`[usage] ${start}..${end}: ${active.length} active bot flows, ${sessions.length} bot sessions read`);
  warnings.forEach((w) => console.warn('[usage]', w));
  const rows = computeRows(raw, catalog, config.rates);
  rows.warning = warnings.join(' ') || null;
  return rows;
}

module.exports = {
  getUsage, computeRows, fetchBotFlowSessions, allocateTurns, enrich, applyHighestTier, applyAggregateRules, collapse, billedCallSeconds, rowTokens,
  allocateVoiceRounding, allocateTokenRounding, apportion, fetchBotSubTypes, hostsOfNestedAi, applyFilters, summarize, chunkIntervals, tzOffset, bucketOf, addDays, METERED_BOT_PRODUCTS,
};
