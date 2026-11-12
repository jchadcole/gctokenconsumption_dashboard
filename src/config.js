'use strict';
require('dotenv').config();

const num = (name, def) => {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return n;
};
// 1Password secret references (op://vault/item/field) are resolved by `op run`. If one reaches
// the app as-is, the app was started without the 1Password CLI.
const unresolvedRefs = (env = process.env) =>
  ['GENESYS_CLIENT_ID', 'GENESYS_CLIENT_SECRET', 'GENESYS_REGION'].filter((k) => /^op:\/\//.test(String(env[k] || '').trim()));

const bool = (name) => ['1', 'true', 'yes'].includes(String(process.env[name] || '').toLowerCase());

const refs = unresolvedRefs();
if (refs.length) {
  throw new Error(`[config] ${refs.join(', ')} ${refs.length > 1 ? "still hold 1Password references" : "still holds a 1Password reference"} (op://...). `
    + 'Start the app with the 1Password CLI so they are resolved: npm run start:op '
    + '(or op run --env-file=.env -- npm start).');
}

const config = {
  clientId: process.env.GENESYS_CLIENT_ID || '',
  clientSecret: process.env.GENESYS_CLIENT_SECRET || '',
  region: (process.env.GENESYS_REGION || 'mypurecloud.com').replace(/^https?:\/\//, '').replace(/^(api|login)\./, ''),
  mock: bool('GENESYS_MOCK'),
  port: num('PORT', 3000),
  // Days are bucketed in this time zone. Default: the machine's own time zone, so "today" on the
  // dashboard is the same day as on the user's clock (UTC put evening calls in the US on the next day).
  timeZone: process.env.REPORT_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  maxDaysPerQuery: num('ANALYTICS_MAX_DAYS', 31),
  catalogCacheMs: num('CATALOG_CACHE_MINUTES', 15) * 60 * 1000,
  enableInternalOverview: bool('ENABLE_INTERNAL_SUBSCRIPTION_OVERVIEW'),
  rates: {
    // 1. Voice bots: 17 minutes per token, each call billed in 15 s increments, total rounded up to the minute
    voiceBotMinutesPerToken: num('RATE_VOICE_BOT_MINUTES_PER_TOKEN', 17),
    voiceBotIncrementSeconds: num('RATE_VOICE_BOT_INCREMENT_SECONDS', num('RATE_VOICE_BOT_ROUND_SECONDS', 15)),
    // 2. Digital bots: 51 prompt/response turns per token
    digitalBotTurnsPerToken: num('RATE_DIGITAL_BOT_TURNS_PER_TOKEN', num('RATE_DIGITAL_BOT_SESSIONS_PER_TOKEN', 51)),
    // 3. Virtual Agents: 2 sessions per token
    virtualAgentSessionsPerToken: num('RATE_VIRTUAL_AGENT_SESSIONS_PER_TOKEN', 2),
    // 4. Agentic Virtual Agents: 1.2 tokens per session
    avaTokensPerSession: num('RATE_AVA_TOKENS_PER_SESSION', num('RATE_AVA_TOKENS_PER_INTERACTION', 1.2)),
    // 6. Consumption is rounded up to whole tokens: per type (Bot, VA, AVA totals; default), flow, product, total, or none
    tokenRounding: process.env.TOKEN_ROUNDING || 'type',
  },
};

if (!config.mock && (!config.clientId || !config.clientSecret)) {
  console.warn('[config] GENESYS_CLIENT_ID / GENESYS_CLIENT_SECRET not set. Falling back to mock data (set GENESYS_MOCK=1 to silence this).');
  config.mock = true;
}

module.exports = config;
module.exports.unresolvedRefs = unresolvedRefs;
