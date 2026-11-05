# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Refresh** button that re-fetches the flow catalog, usage and billing from Genesys Cloud instead of using the server caches, plus a "Data as of" time in the header.

### Fixed

- Orgs that reject grouping bot aggregates by conversation (seen on GenesysSC12) fell back to daily totals, which turned off the highest-tier rule and estimated the 15 s rounding. Bot usage now comes from the bot flow sessions endpoint, one record per session with its conversation and start/end time. That also fixes calls showing twice the bot sessions.
- The billing section no longer tells you to add a permission when the contracts API returns a non-permission error.
- The Bots tile and the breakdown rows disagreed on voice minutes (5 vs 4), because rows rounded 4.25 for display. Rows now show voice time as minutes:seconds after 15 s rounding (4:15). The tile shows billed minutes after rounding the total up (5), and a note under the table spells out the calculation. Token values under 10 now show two decimals.
- The breakdown has a Conversations column, so calls are counted separately from the bot sessions Genesys reports.
- Voice bot calls were counted as digital turns because Genesys reports their media type as `CALL`. Any voice bot flow (Architect type `bot`) is now billed as voice.

### Changed

- Token calculation follows the USPS token rules: voice bots are billed per call in 15 s increments, with the total rounded up to a whole minute and divided by 17; digital bots by prompt/response turns ÷ 51; Virtual Agents by sessions ÷ 2; AVAs at 1.2 per session.
- Each conversation consumes tokens only for the highest tier it reached (AVA > Virtual Agent > Bot). Usage is now read per conversation, and lower-tier sessions are shown as "Escalated".
- New rate settings: `RATE_VOICE_BOT_INCREMENT_SECONDS`, `RATE_DIGITAL_BOT_TURNS_PER_TOKEN`, `RATE_VIRTUAL_AGENT_SESSIONS_PER_TOKEN`, `RATE_AVA_TOKENS_PER_SESSION`. The old names are still read.

## [1.0.0] - 2026-11-04

### Added

- Web dashboard of Genesys Cloud AI Experience token consumption broken down by Bots, Virtual Agents and Agentic Virtual Agents.
- Estimated tokens per bot / flow from the bot and flow analytics aggregate APIs, using the published token rates (configurable in `.env`).
- Official token charges and token wallet balance from the billing contracts API.
- Drill-down filters: date range, granularity, type, division, bot / flow, media type, language, bot product, non-metered bots. Filter state is kept in the URL.
- Breakdown tables by flow, division, type × media, language and bot product; CSV export.
- OAuth client-credentials client with retry on 429/5xx; chunked analytics queries for long ranges.
- Mock mode (`npm run mock`), unit tests, Dockerfile.
- Versioning: app version from `package.json`, shown in the UI header and served at `/api/version` and in the `X-App-Version` header; `npm run release:*` scripts; CI and tagged GitHub releases.

[Unreleased]: https://github.com/jchadcole/gctokenconsumption_dashboard/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/jchadcole/gctokenconsumption_dashboard/releases/tag/v1.0.0
