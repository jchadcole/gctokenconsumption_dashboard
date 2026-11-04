# Genesys Cloud token consumption dashboard

A small Node.js web app that pulls Genesys Cloud usage through the Platform API and shows AI Experience token consumption broken down by **Bots**, **Virtual Agents** and **Agentic Virtual Agents (AVAs)**, with drill-down filters.

![screenshot](docs/screenshot.png)

## What it shows

- **Totals** for the date range: estimated tokens overall and for each type, with sessions, interactions and voice minutes.
- **Tokens over time**, stacked by type, grouped by day, week or month.
- **Breakdown tables** by bot / flow, division, type × media, language and bot product. Click a row to drill down.
- **Billed tokens from your contract**: the official, org-level token charges and token wallet balance from the Genesys billing API. Use this to check the estimate against the invoice.
- **CSV export** of the filtered daily rows.

Filters: date range (presets or custom), granularity, type (Bot / VA / AVA), division, bot or flow, media type, language, bot product, and an option to include third-party bots that are not charged Genesys tokens. Filter state lives in the URL, so a drill-down view can be bookmarked or shared.

## Why "estimated"

Genesys Cloud does not publish an API that splits token usage by bot. The billing API gives official totals per product for the whole org, and the analytics APIs give usage per bot. This app joins the two:

| Type | How it is identified | Token rate (default) |
|---|---|---|
| Bot | Architect bot / digital bot flow with no Virtual Agent and no AVA | Voice: 17 minutes per token, each call rounded up to 15 s. Digital: 51 sessions per token |
| Virtual Agent | Bot flow with `virtualAgentEnabled = true` | 0.5 tokens per interaction |
| Agentic Virtual Agent | Any flow that contains an AVA block (found through Architect dependency tracking) | 1.2 tokens per interaction |

Rates come from the [Genesys Cloud tokens model](https://help.genesys.cloud/articles/genesys-cloud-tokens-model/) and the [AI resource consumption billing scenarios](https://help.genesys.cloud/articles/virtual-agent-and-agentic-virtual-agent-billing-scenarios/). Override them in `.env` if your contract differs.

Known limits of the estimate:

- Genesys bills an interaction once at the highest tier it touched. Analytics aggregates count each flow separately, so an interaction that passes through two token-consuming flows (for example an inbound flow with an AVA block that then calls a VA bot flow) is counted twice.
- Voice rounding to 15 s is applied per call by Genesys. Analytics only returns total duration, so the app adds half an increment per call.
- Bot aggregates have no queue or division dimension. Division comes from the flow's division. Queue is not available for bot usage.

## Genesys Cloud APIs used

| Purpose | Endpoint |
|---|---|
| OAuth (client credentials) | `POST https://login.{region}/oauth/token` |
| Bot and digital bot flows, VA flag, division | `GET /api/v2/flows?type=bot&type=digitalbot` |
| Agentic Virtual Agents | `GET /api/v2/agentic/virtualagents` |
| Flows that embed each AVA | `GET /api/v2/architect/dependencytracking/consumingresources?objectType=AGENTICVIRTUALAGENT` |
| Division names | `GET /api/v2/authorization/divisions`, `GET /api/v2/flows/divisionviews` |
| Bot sessions, duration, turns by bot, product, media, language | `POST /api/v2/analytics/bots/aggregates/query` |
| Entries into non-bot flows that contain an AVA | `POST /api/v2/analytics/flows/aggregates/query` |
| Official token charges and wallet | `GET /api/v2/billing/contracts`, `GET /api/v2/billing/contracts/{id}/billingperiods/{periodId}` |
| Optional, unsupported | `GET /api/v2/billing/subscriptionoverview` (the internal endpoint the Admin UI uses; off by default) |

## Setup

1. In Genesys Cloud Admin, create an **OAuth client** with grant type **Client Credentials**, and give it a role with view permissions for:
   - Architect: flows and dependency tracking
   - Analytics: bot aggregates and flow aggregates
   - AI Studio / Agentic Virtual Agents: view
   - Authorization: divisions (view)
   - Billing: contracts (view), for the "Billed tokens" section
   If a permission is missing, the API returns 403 and the dashboard shows the message, which names the missing permission. Sections that fail still let the rest of the page load.
2. Copy `.env.example` to `.env` and fill in `GENESYS_CLIENT_ID`, `GENESYS_CLIENT_SECRET` and `GENESYS_REGION` (for example `mypurecloud.com`, `usw2.pure.cloud`, `use2.us-gov-pure.cloud` for FedRAMP orgs). Never commit `.env`.
3. Install and run (Node 18 or later):

   ```bash
   npm install
   npm start          # http://localhost:3000
   ```

To try the UI without credentials, run `npm run mock`. It serves generated sample data and labels the page "Sample data".

Docker:

```bash
docker build -t genesys-token-dashboard .
docker run --env-file .env -p 3000:3000 genesys-token-dashboard
```

## Configuration

All settings are environment variables; see `.env.example`. The useful ones beyond credentials:

- `REPORT_TIMEZONE`: IANA time zone used for daily buckets (default `UTC`).
- `ANALYTICS_MAX_DAYS`: long ranges are split into chunks of this many days per analytics query (default 31).
- `CATALOG_CACHE_MINUTES`: how long the flow / AVA catalog is cached (default 15). The "Refresh catalog" button forces a reload.
- `RATE_*`: token rates.
- `ENABLE_INTERNAL_SUBSCRIPTION_OVERVIEW=1`: also call the undocumented subscription overview endpoint and show its raw response.

## Project layout

```
src/server.js     Express app and JSON/CSV endpoints
src/genesys.js    OAuth client-credentials client with retry on 429/5xx and pagination
src/catalog.js    Flow / VA / AVA discovery and classification
src/usage.js      Analytics queries, token math, filtering and summaries
src/billing.js    Contract billing periods, token charges and wallets
src/mock.js       Sample data for mock mode
public/           Web UI (plain HTML, CSS and JS, no build step)
test/             Unit tests (npm test)
```

## Local API

- `GET /api/usage?start=YYYY-MM-DD&end=YYYY-MM-DD&granularity=day|week|month&categories=bot,va,ava&flowIds=&divisionIds=&mediaTypes=&languages=&botProducts=&includeUnmetered=1`
- `GET /api/usage.csv?...` same parameters
- `GET /api/billing?start=&end=`
- `GET /api/catalog[?refresh=1]`
- `GET /api/config`, `GET /api/health`

The server keeps the OAuth secret; the browser only talks to these local endpoints. There is no login on the dashboard itself, so run it on a trusted network or put it behind your own SSO / reverse proxy.
