# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
