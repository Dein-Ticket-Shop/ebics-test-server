# EBICS H005 Test Server — Tasks

## Phase 1: Project Skeleton + HEV

- [x] Initialize project (package.json, tsconfig.json, vitest.config.ts)
- [x] Install all dependencies
- [x] Download official H005 XSD schemas from ebics.org
- [x] Download H000 (HEV) XSD schema
- [x] Download S002 (signature) XSD schema
- [x] Download xmldsig-core-schema.xsd from W3C
- [x] Set up XSD validator module (`src/protocol/xml-validator.ts`) using libxml2-wasm
- [x] Create Hono server with raw XML body parsing (`src/server.ts`)
- [x] Create XML dispatcher — route by root element name (`src/protocol/dispatcher.ts`)
- [x] Create constants module — namespaces, return codes (`src/protocol/constants.ts`)
- [x] Create return codes enum (`src/protocol/return-codes.ts`)
- [x] Implement HEV handler (`src/handlers/hev.ts`)
- [x] Create XML builder helpers (`src/protocol/xml-builder.ts`)
- [x] Validate HEV response against `ebics_hev.xsd`
- [x] Write test: HEV request → valid XSD-compliant response
- [x] Create entry point (`src/index.ts`)

## Phase 2: Key Exchange

- [x] Bank key pair generation — X002 + E002, 2048-bit RSA (`src/bank/bank-keys.ts`)
- [x] X.509 self-signed cert generation for bank keys (node-forge)
- [x] SQLite store — schema.sql (subscribers, keys, transactions, nonces)
- [x] SQLite store — implementation (`src/store/sqlite-store.ts`)
- [x] Store interface + data models (`src/store/types.ts`)
- [x] Subscriber state machine: NEW → PARTIALLY_INIT → INITIALIZED → READY
- [x] XML parser helpers — xpath + namespace-aware queries (`src/protocol/xml-parser.ts`)
- [x] INI handler — parse SignaturePubKeyOrderData, store A005/A006 key
- [x] HIA handler — parse HIARequestOrderData, store X002 + E002 keys
- [x] Admin API: `POST /admin/host` — configure HostID + generate bank keys
- [x] Admin API: `POST /admin/subscribers` — create subscriber
- [x] Admin API: `GET /admin/subscribers` — list subscribers
- [x] Admin API: `GET /admin/subscribers/:id` — get subscriber state
- [x] Admin API: `POST /admin/subscribers/:id/activate` — activate subscriber
- [x] Admin API: `DELETE /admin/subscribers/:id` — remove subscriber
- [x] AuthSignature verification — manual C14N + RSA-SHA256 (`src/protocol/xml-signature.ts`)
- [x] HPB handler — return bank public keys as HPBResponseOrderData (authenticated)
- [x] XSD validate all incoming key management requests
- [x] XSD validate all outgoing key management responses
- [x] Test: INI request → subscriber state change
- [x] Test: HIA request → subscriber state change
- [x] Test: full INI → HIA → activate → HPB lifecycle
- [x] Test: HPB rejected before activation
- [x] Test: duplicate INI rejected

## Phase 3: Transaction Management + Downloads

- [x] Transaction state machine: INIT → TRANSFER → RECEIPT
- [x] TransactionID generation (16-byte random hex)
- [x] Nonce replay protection — store nonce+timestamp, reject duplicates (±6h)
- [x] Compression helpers — deflate/inflate (`src/protocol/crypto.ts`)
- [x] Crypto helpers — AES-128-CBC encrypt/decrypt (`src/protocol/crypto.ts`)
- [x] Crypto helpers — RSA wrap/unwrap transaction key
- [x] Response encryption pipeline: compress → AES encrypt → base64 (`src/protocol/download-pipeline.ts`)
- [x] Multi-segment download support (1 MB segment limit)
- [x] HPD handler — bank parameters
- [x] HTD handler — subscriber info
- [x] HKD handler — customer info
- [x] HAA handler — available order types / BTFs
- [x] HAC handler — customer protocol (XML)
- [x] BTD handler — generic download with BTF routing
- [x] Admin API: `POST /admin/download-data` — seed downloadable files
- [x] Test: single-segment download flow (init → receipt)
- [x] Test: multi-segment download flow (init → transfer × N → receipt)
- [x] Test: receipt with failure code
- [x] Test: nonce replay rejection
- [x] Test: HPD/HTD/HKD return valid XML

## Phase 4: Uploads

- [x] BTU handler — generic upload with BTF routing
- [x] Order data decryption pipeline: RSA unwrap key → AES-CBC decrypt → inflate (`src/protocol/upload-pipeline.ts`)
- [x] Electronic signature verification — A005 (RSA-PKCS1-SHA256) — parsed but not cryptographically verified (test server)
- [x] Electronic signature verification — A006 (RSA-PSS-SHA256) — parsed but not cryptographically verified (test server)
- [x] UserSignatureData parsing — built in test client, accepted by server
- [x] Multi-segment upload handling
- [x] Admin API: `GET /api/uploaded-orders` — view received uploads
- [x] pain.001 processing — creates bookings from uploaded payment instructions
- [x] Test: single-segment upload (pain.001 via BTU)
- [x] Test: multi-segment upload
- [x] Test: upload decryption + decompression produces original data
- [x] Test: pain.001 upload creates bookings on accounts
- [x] Test: receipt cleans up transaction
- [x] Test: admin API lists uploaded orders

## Phase 5: Key Management + Error Handling

- [x] PUB handler — replace signature key
- [x] HCA handler — replace auth + encryption keys
- [x] HCS handler — replace all three keys
- [x] SPR handler — suspend subscriber
- [x] Comprehensive EBICS error responses (all spec return codes + report texts from epics reference)
- [x] Test: key rotation via PUB
- [x] Test: key rotation via HCA
- [x] Test: key rotation via HCS
- [x] Test: SPR suspends subscriber
- [x] Test: suspended subscriber rejected for subsequent requests
- [x] Test: unknown HostID → EBICS_INVALID_HOST_ID
- [x] Test: unknown user → EBICS_USER_UNKNOWN

## Simulated Banking Backend

- [x] IBAN generation (ISO 7064 MOD 97-10 check digits)
- [x] Data model — bank_config, persons, accounts, bookings, partner_account_access
- [x] Store implementation — BankingStore interface + SqliteStore methods
- [x] Admin API: bank config, persons CRUD, accounts CRUD, partner access, bookings
- [x] Admin API: statement preview (camt.053 + MT940)
- [x] Admin API: demo seed endpoint
- [x] camt.053 XML generator (ISO 20022 camt.053.001.08)
- [x] MT940 text generator (SWIFT format)
- [x] BTD handler: dynamic generation waterfall (banking → static fallback)
- [x] HAA handler: advertise dynamic BTFs when partner has accounts
- [x] Test: IBAN generation + validation
- [x] Test: admin CRUD (bank/person/account/booking/access)
- [x] Test: statement preview (camt.053 + MT940)
- [x] Test: BTD download camt.053 via EBICS protocol
- [x] Test: BTD download MT940 via EBICS protocol
- [x] Test: static fallback when no accounts linked

## Phase 6: End-to-End

- [ ] Run server, connect with `@kage0x3b/ebics-client`
- [ ] E2E: full key exchange (INI → HIA → activate → HPB)
- [ ] E2E: download flow
- [ ] E2E: upload flow

## Phase 7: SEPA Instant, reports and customer protocol

- [x] EBICS OrderIDs per partner (`A000`…), returned in upload Initialisation/Transfer/Receipt responses and INI/HIA responses
- [x] Schema migrations for existing SQLite files (new `transactions` / `uploaded_orders` columns)
- [x] ZIP container support: BTD payloads are zipped when the request carries `Container containerType="ZIP"` (also camt.053, MT940 and seeded data)
- [x] camt.053 entries carry `AcctSvcrRef` and `TxDtls/Refs` (AcctSvcrRef, EndToEndId, TxId), stable across camt.052/053/054
- [x] BTD STM camt.052 intraday account report (DateRange, default today)
- [x] BTD STM camt.054 debit/credit notifications (without DateRange only bookings not yet delivered)
- [x] BTD REP pain.002 payment status reports, one document per status change
- [x] BTD REP pain.002 with ServiceOption VOP: Verification of Payee reports per pain.001 message
- [x] Delivery tracking: items handed out without DateRange are marked delivered on a positive receipt
- [x] BTU SCI pain.001 (SEPA Instant): payment orders per PmtInf, VoP check, status history ACTC → ACSC
- [x] Verification of Payee: name match against account holders held here, `EBICS_VOP_DEFAULT` for foreign creditors, admin override
- [x] EDS hold (`EBICS_EDS_HOLD=true`): uploads with `requestEDS` wait in the VEU until release / cancel / reject
- [x] HAC event ledger (FILE_UPLOAD, ES_VERIFICATION, VEU_FORWARDING, VEU_VERIFICATION_END, VEU_CANCEL_ORDER, ORDER_HAC_FINAL_POS/NEG) for BTU, INI/HIA (+ activation) and PUB/HCA/HCS
- [x] HAC pain.002.001.03 customer protocol behind `EBICS_HAC_FORMAT=pain.002` (legacy format stays default), DateRange or undelivered events
- [x] German protocol text with `Sammlerreferenz` on ORDER_HAC_FINAL_POS for credit transfers
- [x] HKD/HTD/HAA advertise SCI, EOP camt.053, STM camt.052/camt.054, REP pain.002 (SCI and VOP)
- [x] Admin API: `/api/config/flags`, `/api/payments` (release, cancel, reject, status events, VoP override, report previews), `/api/hac-events`, `/api/hac/report`, `/api/deliveries/reset`, statement preview camt.052/camt.054
- [x] Admin UI: payment orders list and detail, customer protocol page, camt.052/camt.054 statement preview
- [x] Tests: ZIP, order ledger store + migrations, VoP, report generators, payments/reports/HAC integration

### Not yet supported (TODO)

- [ ] PTK (customer protocol as text)
- [ ] EDS admin orders HVZ / HVD / HVT / HVS / HVE (VEU overview, details, sign, cancel via EBICS — only the admin API can release or cancel today)
- [ ] OTH + WebSocket real-time notifications
- [ ] FILE_DOWNLOAD HAC events for downloads
- [ ] Protocol text for pain.008 ORDER_HAC_FINAL_POS
- [ ] Static download data keyed by ServiceOption (`download_data` is unique on service + msg name)
- [ ] VoP confirmation workflow for no-match results (orders are executed regardless of the VoP result)
- [ ] HAC `090003` deny list (subscriber not authorised for HAC)
- [ ] XSD validation of pain.002 / camt payloads
