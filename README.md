# EBICS Test Server

A local EBICS H005 (EBICS 3.0) bank server for testing your EBICS client. Run it,
point your client at it, and exercise key exchange, uploads, and downloads without
touching a real bank.

It ships with a web admin UI so you can manage subscribers, seed demo accounts, and
inspect every request and response.

## Features

- EBICS H005 protocol over a single `/ebics` endpoint
- Key exchange: INI, HIA, HPB, plus key management (HCA, HCS, PUB, SPR)
- Order info downloads: HEV, HPD, HKD, HTD, HAA, HAC, PTK
- Generic upload and download: BTU and BTD with BTF service parameters
- Payment processing: parses pain.001 credit transfers and pain.008 direct debits
- SEPA Instant uploads (BTU SCI pain.001) as payment orders with Verification of Payee and a payment status history
- Signature classes per subscriber (E, A, B, T): uploads by a user whose class does not authorise the order alone wait in the VEU when they request a distributed signature (otherwise `090003`), until users with class E, A or B sign or an admin releases, cancels or rejects them. Class T is a technical user that can only submit orders
- VEU order types HVU, HVZ (both with ServiceFilter), HVD, HVT (complete order data or single order details with fetchLimit/fetchOffset), HVE and HVS to list, inspect, sign and cancel held orders
- Electronic signatures (A005, A006) of uploads, HVE, HVS, PUB, HCA and HCS are verified against the registered signature keys; refused EUs return `091111`, `091120`, `091301`, `091304`, `091305` or `091306` with the matching HAC reason code
- Technical subscribers (`SystemID`, EBICS 3.0.2 chapter 3.7): requests are authenticated with the technical subscriber's key and responses encrypted for it; its own electronic signatures count as transport signatures
- Minimum number of bank-technical signatures per customer and BTF service (1 or 2, EBICS 3.0.2 chapter 11.2.3), reported as `NumSigRequired` in HKD/HTD
- Optional VoP confirmation: credit transfers without a full payee match (RCVC) wait for an HVE signature or an admin release
- EBICS OrderIDs on uploads and INI/HIA, echoed in every response of the transaction
- Statement generation: camt.053 and MT940
- Reports: camt.052 intraday reports, camt.054 notifications, pain.002 payment status reports and pain.002 Verification of Payee reports
- ZIP containers for BTD downloads when the client requests `Container containerType="ZIP"`
- Delivery tracking: downloads without a DateRange return only data not yet fetched, confirmed by a positive receipt
- HAC customer protocol in pain.002.001.03 format (opt-in), fed by an event ledger of the bank-side order lifecycle, with German protocol text for credit transfers and direct debits
- PTK customer protocol as ISO-8859-1 text, rendered from the same event ledger
- Optional `FILE_DOWNLOAD` events in the customer protocol, and protocol downloads (HAC and PTK) switchable per subscriber in the admin API/UI (`090003` when off)
- Seeded download data per service, message name and ServiceOption
- Real-time notifications (DK Anlage 2 V1.0): BTD OTH/DE/wssparam returns a token, the `/realtime` WebSocket pushes EBICS-HAA messages for new bookings, payment status, payment orders and HAC events to connected clients
- XML signing and schema validation on both requests and responses
- XSD validation of generated camt.052/053/054 and pain.002 payloads; violations are logged as server bugs and the download still goes out
- SQLite storage that survives restarts
- Admin UI for subscribers, banking data, payment orders, the VEU, real-time connections, seeded download data, and a full protocol log

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
- Real-time notifications: `ws://localhost:4150/realtime` (HTTP Basic `PARTNERID_USERID:TOKEN`, token from BTD OTH/DE/wssparam)

### Admin UI

The server serves the admin UI at `/admin` once it is built:

```bash
pnpm build:admin
pnpm dev
```

Then open http://localhost:4150/admin.

The subscriber page sets the signature class and switches protocol downloads (HAC, PTK) on or off for that
subscriber (`PATCH /api/subscribers/:partnerId/:userId` with `{ "signatureClass": "T" }` or
`{ "protocolDownloadsAllowed": false }`; `POST /api/subscribers` accepts both too). New subscribers have class E,
so their uploads execute immediately. Signature classes follow EBICS 3.0.2 chapter 11.2.3:

| Class | Meaning | Upload with `requestEDS` | Upload with SignatureFlag, no `requestEDS` | HVE/HVS |
| ----- | ------- | ------------------------ | ------------------------------------------ | ------- |
| `E`   | single signature | executed | executed | allowed |
| `A`   | first signature | waits in the VEU for another E, A or B signature | `090003` | allowed |
| `B`   | second signature | waits in the VEU for another E or A signature | `090003` | allowed |
| `T`   | transport signature (technical user) | waits in the VEU for signatures of other users | `090003` | `090003` |

Uploads without SignatureFlag are authorised outside EBICS and executed; their signature counts as `T`. The test
server assumes every customer has agreed to the VEU and to authorisation outside EBICS; without such agreements a
bank answers `091007` or `090003` (EBICS 3.0.2 chapter 3.14). HVU and HVZ list only the orders the requesting user
may sign, so class `T` users get `090005`, and HVD/HVT answer `091007` for them (chapters 8.3.1 to 8.3.3).
Next to subscribers and banking data, the UI has pages for payment orders, the customer protocol, the
VEU (sign or cancel held orders as a chosen user), Real-time (open connections, tokens, test messages)
and Download Data (seed files per service, message name and ServiceOption). Host Config lists every
environment flag with its description, default, allowed values and current value. The descriptions live
as data in `ENV_FLAGS` in `packages/server/src/config/feature-flags.ts` and are served by
`GET /api/config/env-flags`.

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
| `EBICS_HAC_FORMAT`         | `legacy`         | HAC order data format; `pain.002` returns the pain.002.001.03 customer protocol real banks send |
| `EBICS_VOP_DEFAULT`        | `RCVC`           | VoP result for creditors not held at this bank (`RCVC`, `RVMC`, `RVNM`, `RVNA`) |
| `EBICS_VOP_CONFIRMATION`   | `false`          | Hold credit transfers whose VoP group result is not `RCVC` until an HVE signature or an admin release |
| `EBICS_HAC_DOWNLOAD_EVENTS`| `false`          | Add a `FILE_DOWNLOAD` event to the customer protocol for every download except HAC and PTK |
| `EBICS_WSS_ONE_TIME_TOKEN` | `false`          | wssparam tokens open one WebSocket connection (`OTT` `Y`); by default a token can reconnect for one hour |
| `EBICS_WSS_REPLAY`         | `false`          | Keep real-time messages for a customer without an open connection while a token of the customer is valid, and send them when a client connects (`TIMESTAMP` = first delivery attempt) |
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
