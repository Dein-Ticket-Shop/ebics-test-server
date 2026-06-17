# EBICS Test Server

A local EBICS H005 (EBICS 3.0) bank server for testing your EBICS client. Run it,
point your client at it, and exercise key exchange, uploads, and downloads without
touching a real bank.

It ships with a web admin UI so you can manage subscribers, seed demo accounts, and
inspect every request and response.

## Features

- EBICS H005 protocol over a single `/ebics` endpoint
- Key exchange: INI, HIA, HPB, plus key management (HCA, HCS, PUB, SPR)
- Order info downloads: HEV, HPD, HKD, HTD, HAA, HAC
- Generic upload and download: BTU and BTD with BTF service parameters
- Payment processing: parses pain.001 credit transfers
- Statement generation: camt.053 and MT940
- XML signing and schema validation on both requests and responses
- SQLite storage that survives restarts
- Admin UI for subscribers, banking data, and a full protocol log

## Requirements

- Node.js 20 or newer
- pnpm

## Quick start

```bash
pnpm install
pnpm dev
```

The server starts on http://localhost:4150.

- EBICS endpoint: `POST http://localhost:4150/ebics`
- Health check: `GET http://localhost:4150/health`
- Admin API: `http://localhost:4150/api`

### Admin UI

The server serves the admin UI at `/admin` once it is built:

```bash
pnpm build:admin
pnpm dev
```

Then open http://localhost:4150/admin.

To develop the UI with hot reload, run it separately:

```bash
pnpm dev:admin
```

## Connecting a client

Use these defaults when you set up the bank connection in your EBICS client:

| Setting     | Value                          |
| ----------- | ------------------------------ |
| Host ID     | `TESTHOST`                     |
| URL         | `http://localhost:4150/ebics`  |
| EBICS version | H005 (EBICS 3.0)             |

Create a subscriber in the admin UI (or via `POST /api/subscribers`), run INI and HIA
from your client, then activate the subscriber in the admin UI before downloading the
bank keys with HPB.

To skip the activation step during local testing, start the server with
`EBICS_ALLOW_PREACTIVATION=true` so HPB works right after INI and HIA.

## Demo data

Seed a demo bank, persons, accounts, and bookings with one call:

```bash
curl -X POST http://localhost:4150/api/banking/seed/demo
```

You can also trigger it from the admin UI.

## Configuration

All settings are read from the environment:

| Variable                   | Default          | Description                                  |
| -------------------------- | ---------------- | -------------------------------------------- |
| `PORT`                     | `4150`           | HTTP port                                    |
| `EBICS_HOST_ID`            | `TESTHOST`       | EBICS host ID                                |
| `EBICS_DB_PATH`            | `./ebics-test.db`| SQLite file, or `:memory:` for ephemeral runs |
| `EBICS_ALLOW_PREACTIVATION`| `false`          | Allow HPB before the subscriber is activated |
| `EBICS_STRICT_VALIDATION`  | `true`           | Reject uploads with malformed IBAN or BIC (returns `090004`); set `false` to relax |
| `EBICS_LOG_LEVEL`          | `info`           | Log level (`trace`..`fatal`, or `silent`)    |
| `EBICS_QUIET`              | `false`          | Shorthand for `silent` logging               |
| `EBICS_LOG_JSON`           | unset            | Force raw JSON logs (no pretty printing)      |

The server logs one concise line per EBICS exchange, plus highlights when money
moves and when anything fails. Logging uses pino, so set `EBICS_LOG_JSON=1` for
structured output you can ship or grep.

## Tests

```bash
pnpm test
pnpm typecheck
```

## Project layout

```
packages/
  server/    EBICS protocol, banking logic, admin API, SQLite store
  admin-ui/  SvelteKit admin interface
```

## License

MIT
