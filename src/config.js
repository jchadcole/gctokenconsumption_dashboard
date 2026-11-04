'use strict';
require('dotenv').config();

const num = (name, def) => {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return n;
};
const bool = (name) => ['1', 'true', 'yes'].includes(String(process.env[name] || '').toLowerCase());

const config = {
  clientId: process.env.GENESYS_CLIENT_ID || '',
  clientSecret: process.env.GENESYS_CLIENT_SECRET || '',
  region: (process.env.GENESYS_REGION || 'mypurecloud.com').replace(/^https?:\/\//, '').replace(/^(api|login)\./, ''),
  mock: bool('GENESYS_MOCK'),
  port: num('PORT', 3000),
  timeZone: process.env.REPORT_TIMEZONE || 'UTC',
  maxDaysPerQuery: num('ANALYTICS_MAX_DAYS', 31),
  catalogCacheMs: num('CATALOG_CACHE_MINUTES', 15) * 60 * 1000,
  enableInternalOverview: bool('ENABLE_INTERNAL_SUBSCRIPTION_OVERVIEW'),
  rates: {
    voiceBotMinutesPerToken: num('RATE_VOICE_BOT_MINUTES_PER_TOKEN', 17),
    voiceBotRoundSeconds: num('RATE_VOICE_BOT_ROUND_SECONDS', 15),
    digitalBotSessionsPerToken: num('RATE_DIGITAL_BOT_SESSIONS_PER_TOKEN', 51),
    virtualAgentTokensPerInteraction: num('RATE_VIRTUAL_AGENT_TOKENS_PER_INTERACTION', 0.5),
    avaTokensPerInteraction: num('RATE_AVA_TOKENS_PER_INTERACTION', 1.2),
  },
};

if (!config.mock && (!config.clientId || !config.clientSecret)) {
  console.warn('[config] GENESYS_CLIENT_ID / GENESYS_CLIENT_SECRET not set. Falling back to mock data (set GENESYS_MOCK=1 to silence this).');
  config.mock = true;
}

module.exports = config;
