# saxo-mcp

A minimal, **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server for the
[Saxo Bank OpenAPI](https://www.developer.saxo/openapi/learn). It lets an AI assistant answer
questions about your portfolio (accounts, balances, positions, open orders, history) and look up
market data (instrument search, contract details, quotes, historical bars).

It cannot trade. There is no code path that places, modifies or cancels an order, and the HTTP
client refuses to build a request for anything outside Saxo's read endpoints (see
[Read-only guarantees](#read-only-guarantees)).

## Contents

- [Requirements](#requirements)
- [Setup](#setup)
- [Logging in (OAuth PKCE)](#logging-in-oauth-pkce)
- [Running the MCP server](#running-the-mcp-server)
- [Tools](#tools)
- [How the pieces fit together](#how-the-pieces-fit-together)
- [Read-only guarantees](#read-only-guarantees)
- [Security notes](#security-notes)
- [Development](#development)

## Requirements

- Node.js 20 or newer (tested on 22) on Linux, macOS or Windows. ARM64 is fine.
- A Saxo developer account and a registered app at
  <https://www.developer.saxo/openapi/appmanagement>:
  - Grant type: **Authorization Code Grant (PKCE)**.
  - Redirect URL: `http://localhost:8765/callback` (any localhost port works; keep `.env` in sync).
  - Trading permission: **disabled**. This server never needs it.
  - Environment: **Simulation** while developing.

## Setup

```bash
git clone <this repo> && cd saxo-mcp
npm install
cp .env.example .env
chmod 600 .env
```

Edit `.env`:

| Variable             | Meaning                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `SAXO_APP_KEY`       | The AppKey shown for your app in the Saxo developer portal.                                   |
| `SAXO_ENV`           | `sim` (default). `live` is refused unless `SAXO_ALLOW_LIVE=1` is also set.                    |
| `SAXO_REDIRECT_URI`  | Must match the redirect URL registered on the app. Must be `http://localhost:<port>/...`.     |
| `SAXO_TOKEN_FILE`    | Optional. Where tokens are stored. Default `./.saxo-tokens.json`, created with mode `0600`.   |

`.env` and the token file are listed in `.gitignore`.

## Logging in (OAuth PKCE)

The MCP server runs headless over stdio, so login is a separate one-off command:

```bash
npm run login
```

It prints a Saxo login URL (and tries to open it), starts a temporary HTTP server on the redirect
port, waits for Saxo to send the browser back with an authorization code, exchanges the code for
tokens, and writes them to the token file. Tokens are never printed.

Check it worked:

```bash
npm run whoami
```

### Logging in on a headless VPS

The callback goes to `localhost` **on the machine running `npm run login`**. On a VPS with no
browser, forward the port from your laptop and use your laptop's browser:

```bash
# on your laptop
ssh -L 8765:localhost:8765 user@your-vps
# in that SSH session, on the VPS
cd saxo-mcp && SAXO_NO_BROWSER=1 npm run login
```

Copy the printed URL into your laptop browser. After login, Saxo redirects to
`http://localhost:8765/callback`, which the tunnel delivers to the VPS.

### What PKCE is and why it is used

OAuth's authorization-code flow sends the browser to Saxo to log in, and Saxo sends it back to
your app with a short-lived `code`. The app then swaps that code for tokens. In the classic flow
that swap is protected by a client secret. A CLI or desktop app cannot keep a secret (it lives in
a file on disk), so PKCE (RFC 7636) replaces it with a per-login secret that only exists in
memory:

1. Generate a random `code_verifier`.
2. Put `SHA-256(code_verifier)` (base64url) in the login URL as `code_challenge`.
3. When exchanging the code, send the original `code_verifier`. Saxo hashes it and checks it
   matches the challenge it saw in step 2.

An attacker who steals the `code` from the redirect cannot use it because they never saw the
verifier. A random `state` value is also sent and checked on the way back so a forged redirect
cannot be injected into your login attempt.

Saxo specifics worth knowing:

- Only the app key (`client_id`) and the verifier are sent to the token endpoint. No secret.
- Saxo also requires the `code_verifier` on **refresh** requests, so it is stored next to the
  refresh token.
- Every refresh returns a new refresh token and invalidates the old one. The token file is
  rewritten atomically on each refresh.
- Access tokens are short-lived (about 20 minutes); refresh tokens live longer (about an hour).
  As long as the server is used at least once per refresh-token lifetime, it keeps itself logged
  in. After a long idle period the refresh token expires and tools return
  `AUTHENTICATION REQUIRED ... run npm run login`.

## Running the MCP server

```bash
npm run build
node dist/index.js        # speaks MCP over stdin/stdout; logs go to stderr
```

Example client configuration (Claude Desktop / Claude Code style):

```json
{
  "mcpServers": {
    "saxo": {
      "command": "node",
      "args": ["/absolute/path/to/saxo-mcp/dist/index.js"],
      "cwd": "/absolute/path/to/saxo-mcp"
    }
  }
}
```

The server reads `.env` from its working directory, so set `cwd` (or export the variables in the
client's `env` block).

## Tools

All tools are annotated `readOnlyHint: true` and return JSON.

Portfolio (only need your account context):

| Tool                  | What it returns                                                                                 | Saxo endpoint(s)                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `get_account_summary` | User, client entity and the list of accounts with their `AccountKey`s. Call this first.          | `/port/v1/users/me`, `/port/v1/clients/me`, `/port/v1/accounts/me` |
| `get_balances`        | Cash, total value, margin available/used, unrealised P&L, position and order counts.            | `/port/v1/balances`                                               |
| `get_positions`       | Open positions with open/current price, exposure, P&L. `view: "net"` nets per instrument.       | `/port/v1/positions`, `/port/v1/netpositions`                     |
| `get_orders`          | **Lists** open/working orders. Viewing only.                                                    | `/port/v1/orders`                                                 |
| `get_account_history` | Performance summary or day-by-day time series for a `standardPeriod` or date range.             | `/hist/v4/performance/summary`, `/hist/v4/performance/timeseries` |
| `get_transactions`    | `trades` (executed trades), `bookings` (cash movements) or `order_activities` (order audit log). | `/cs/v1/reports/trades/{ClientKey}`, `/cs/v1/reports/bookings/{ClientKey}`, `/cs/v1/audit/orderactivities` |

Market data (need a UIC from `search_instruments`):

| Tool                     | What it returns                                                                  | Saxo endpoint(s)                                                          |
| ------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `search_instruments`     | Instruments matching a name/ticker/ISIN with `Identifier` (UIC) and `AssetType`. | `/ref/v1/instruments`                                                     |
| `get_instrument_details` | Contract specs, tick size, lot sizes, exchange and trading schedule.              | `/ref/v1/instruments/details/{Uic}/{AssetType}`, `/ref/v1/instruments/tradingschedule/{Uic}/{AssetType}` |
| `get_instrument_price`   | Bid, ask, mid, last traded, day high/low, change, market open flag.               | `GET /trade/v1/infoprices` (informational quote, see below)               |
| `get_chart_data`         | OHLC bars; `horizon` in minutes (1 ... 43200), up to 1200 bars, pageable by `time`. | `/chart/v3/charts`                                                      |

Optional parameters shared by the portfolio tools: `accountKey` (defaults to the client's default
account) and `wholeClient: true` (aggregate over all accounts).

## How the pieces fit together

```
src/
  index.ts              stdio entry point
  server.ts             builds the McpServer and registers the tools
  config.ts             .env loading, SIM/LIVE endpoints, LIVE guard
  login.ts              `npm run login` (interactive PKCE flow)
  whoami.ts             `npm run whoami` (auth sanity check)
  auth/
    pkce.ts             verifier / challenge / state generation
    oauth.ts            authorize URL, code exchange, refresh (form POSTs to /token)
    callbackServer.ts   loopback HTTP server that catches the redirect
    tokenStore.ts       0600 JSON token file, atomic writes
    tokenManager.ts     hands out a valid access token, refreshes before expiry
  saxo/
    client.ts           GET-only HTTP client with the read-only path guard and 401 handling
    portfolio.ts        typed wrappers for the portfolio / history / report endpoints
    marketdata.ts       typed wrappers for reference data, quotes and charts
  tools/
    shared.ts           result/error formatting, common zod parameters
    portfolio.ts        the six portfolio tools
    marketdata.ts       the four market data tools
```

Request flow for a tool call: tool handler -> `PortfolioApi`/`MarketDataApi` -> `SaxoClient.get`
-> `TokenManager.getAccessToken` (refresh if within 60 s of expiry) -> `fetch` with
`Authorization: Bearer`. A 401 triggers one forced refresh and retry; a second 401, or a rejected
refresh, becomes an `AUTHENTICATION REQUIRED` tool error that tells the user to run `npm run login`.

## Read-only guarantees

- `SaxoClient` has no method parameter. It can only send `GET`.
- Every path is checked by `assertReadOnlyPath` before a URL is built. Allowed: `/port/`, `/ref/`,
  `/chart/`, `/hist/`, `/cs/v1/reports/`, `/cs/v1/audit/`, `/root/v1/sessions/`, plus the exact
  path `/trade/v1/infoprices` (and `/list`). Everything else under `/trade/` and any
  `subscriptions` path is rejected with `ReadOnlyViolationError`.
- `/trade/v1/infoprices` is Saxo's informational quote endpoint. It is a `GET` that returns
  bid/ask/last and cannot create, change or cancel anything. It is the only REST way to read a
  current quote, which is why `get_instrument_price` uses it. If you would rather not touch the
  `/trade/` service group at all, remove the two entries from `READ_ONLY_EXACT` in
  `src/saxo/client.ts` and the price tool will fail closed; `get_chart_data` with `horizon: 1`
  still gives the latest one-minute bar.
- Register the Saxo app with trading permission disabled so the token itself cannot trade either.
- The test suite asserts that every request made by every tool is a `GET` and that no path other
  than `/trade/v1/infoprices` under `/trade/` is ever requested.

## Security notes

- `.env` and `.saxo-tokens.json` are gitignored. Keep them `chmod 600`.
- Tokens are never logged or printed. Error bodies from the token endpoint are redacted before
  they reach a message.
- All logging goes to stderr; stdout is reserved for the MCP protocol.
- The callback server binds to `127.0.0.1` only and shuts down as soon as the login completes,
  fails or times out (5 minutes).
- `SAXO_ENV=live` is refused unless you also set `SAXO_ALLOW_LIVE=1`. Do not do that until the
  server has been exercised against SIM.

## Development

```bash
npm run dev        # run the server from TypeScript sources
npm run typecheck
npm test           # unit tests + in-process MCP client tests against a fake Saxo
npm run build
```

The tests do not contact Saxo. They cover the PKCE math (RFC 7636 test vector), token storage
permissions, refresh handling, the read-only guard and every tool end to end via an in-memory MCP
transport.
