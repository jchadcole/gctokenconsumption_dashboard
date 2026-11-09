# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Genesys Cloud credentials can come from 1Password. `.env.tpl` holds `op://` secret references and `npm run start:op` starts the app through `op run`, which resolves them. `.env` still works as before. The app stops with a clear message if it is started without `op run` while a credential holds an `op://` reference.
- **Refresh** button that re-fetches the flow catalog, usage and billing from Genesys Cloud instead of using the server caches, plus a "Data as of" time in the header.
- Token consumption is rounded up to a whole token for the date range, by default for each type (Bots, Virtual Agents, AVAs). The extra is shared across rows by their tokens, so the tiles show whole tokens and the chart, every breakdown tab and drill-downs add up to them. Each tile also shows the tokens before rounding up. `TOKEN_ROUNDING` sets the level: `type`, `product`, `total` or `none`. The CSV has a `usedTokens` column.

### Fixed

- Every token figure is a whole number, rounded up. Each bot or flow's tokens for the date range are rounded up on their own (for example 543 Virtual Agent sessions ÷ 2 = 271.5, billed as 272), and the tiles add the bots up. The whole tokens are then handed to each bot's days, channels and languages with the largest remainder method, so tabs, chart bars and drill-downs show whole numbers that add up to the tiles. The tiles no longer show a fractional "before rounding up" value (hover a breakdown token cell for it), and the chart's gridlines are whole numbers. `TOKEN_ROUNDING` now defaults to `flow`; `type`, `product`, `total` and `none` still work.
- Breakdown rows now follow the token rules shown in the app. The Calls and Conversations columns counted every session that reached a row, including ones escalated to a higher tier, so a Virtual Agent row could show 1,973 sessions next to tokens for 1,818. They are now **Billed calls** and **Billed sessions** (escalated ones stay under Escalated) and match the tiles. The Type column shows each row's rule (for example `sessions ÷ 2`), and hovering a token cell shows its value by the rules and its share of the whole-token round-up. A new test checks every Bot / flow and Type row against the rules and the tiles.
- Every figure now includes the 15 s and whole-minute voice rounding, so the tiles, the chart, the breakdown rows on every tab and drill-downs agree (for example 4:15 of calls is 5 billed minutes = 0.29 tokens everywhere, where the breakdown row used to show 0.25). The whole-minute rounding is applied once to the range total and shared across voice bots by their billed seconds. The breakdown's Voice time column is now **Billed voice min**, the footnote under the table is gone, and the chart's y-axis no longer repeats labels for small values.
- The dashboard could sit loading with no data after the per-session change. It read sessions for every bot flow in the org one at a time. It now reads only the bot flows with activity in the range, four at a time. A failing flow falls back to daily totals instead of blocking the page, and the terminal logs each load.
- Orgs that reject grouping bot aggregates by conversation (seen on GenesysSC12) fell back to daily totals, which turned off the highest-tier rule and estimated the 15 s rounding. Bot usage now comes from the bot flow sessions endpoint, one record per session with its conversation and start/end time. That also fixes calls showing twice the bot sessions.
- The billing section no longer tells you to add a permission when the contracts API returns a non-permission error.
- The Bots tile and the breakdown rows disagreed on voice minutes (5 vs 4), because rows rounded 4.25 for display. Rows now show voice time as minutes:seconds after 15 s rounding (4:15). The tile shows billed minutes after rounding the total up (5), and a note under the table spells out the calculation. Token values under 10 now show two decimals.
- The breakdown has a Conversations column, so calls are counted separately from the bot sessions Genesys reports.
- Voice bot calls were counted as digital turns because Genesys reports their media type as `CALL`. Any voice bot flow (Architect type `bot`) is now billed as voice.

### Changed

- The Breakdown panel shows voice and digital side by side for every bot, Virtual Agent and AVA: a **Voice** group (calls, billed bot minutes, tokens) and a **Digital** group (conversations, billed bot turns, tokens), then escalated sessions and total tokens. Turns appear only for digital bots and minutes only for voice bots, since Virtual Agents and AVAs bill per session; channels a row never used show "–". The Bot sessions column is gone, and the Type × media tab is replaced by a **Type** tab. Each type tile splits its tokens into voice and digital.
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
