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
- [x] Electronic signature verification — A005 (RSA-PKCS1-SHA256), verified since Phase 9
- [x] Electronic signature verification — A006 (RSA-PSS-SHA256), verified since Phase 9
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
- [x] Held uploads: uploads with `requestEDS` wait in the VEU until release / cancel / reject (originally `EBICS_EDS_HOLD=true`, replaced by signature classes in Phase 9)
- [x] HAC event ledger (FILE_UPLOAD, ES_VERIFICATION, VEU_FORWARDING, VEU_VERIFICATION_END, VEU_CANCEL_ORDER, ORDER_HAC_FINAL_POS/NEG) for BTU, INI/HIA (+ activation) and PUB/HCA/HCS
- [x] HAC pain.002.001.03 customer protocol behind `EBICS_HAC_FORMAT=pain.002` (legacy format stays default), DateRange or undelivered events
- [x] German protocol text with `Sammlerreferenz` on ORDER_HAC_FINAL_POS for credit transfers
- [x] HKD/HTD/HAA advertise SCI, EOP camt.053, STM camt.052/camt.054, REP pain.002 (SCI and VOP)
- [x] Admin API: `/api/config/flags`, `/api/payments` (release, cancel, reject, status events, VoP override, report previews), `/api/hac-events`, `/api/hac/report`, `/api/deliveries/reset`, statement preview camt.052/camt.054
- [x] Admin UI: payment orders list and detail, customer protocol page, camt.052/camt.054 statement preview
- [x] Tests: ZIP, order ledger store + migrations, VoP, report generators, payments/reports/HAC integration

## Phase 8: VEU, PTK, real-time notifications and payload validation

- [x] VEU orders HVZ, HVD, HVT, HVE, HVS: held orders need further signatures (see Phase 9 for the rules), duplicate HVE by the same user → `091306`, HVS cancels; bank-side `/api/veu/orders` and admin UI page "VEU"
- [x] VoP confirmation (`EBICS_VOP_CONFIRMATION=true`): credit transfers whose VoP group result is not RCVC wait for an HVE signature (the uploader may confirm) or an admin release
- [x] PTK customer protocol as ISO-8859-1 text rendered from the HAC event ledger, delivered once without DateRange; admin preview `GET /api/ptk/report`
- [x] Protocol downloads per subscriber (`PATCH /api/subscribers/:partnerId/:userId` `{ protocolDownloadsAllowed }`, toggle on the subscriber page): HAC/PTK → `090003` when off, and HKD/HTD drop them from the user's permissions
- [x] FILE_DOWNLOAD HAC events (`EBICS_HAC_DOWNLOAD_EVENTS=true`): every download except HAC/PTK gets its own OrderID and the BTF attributes
- [x] Protocol text for pain.008 ORDER_HAC_FINAL_POS (`L A S T S C H R I F T E N` with `Sammlerreferenz`)
- [x] Download data keyed by ServiceOption (exact option wins over an entry without one, old tables rebuilt on startup), `DELETE /api/download-data/:id`, admin UI page "Download Data"
- [x] Real-time notifications (DK Anlage 2 V1.0): BTD OTH/DE/wssparam, WebSocket `/realtime`, batched EBICS-HAA and INFO messages, one-time tokens with `EBICS_WSS_ONE_TIME_TOKEN=true`; `/api/realtime/*` and admin UI page "Real-time"
- [x] XSD validation of generated camt.052/053/054.001.08 and pain.002.001.03/.10 payloads against `schemas/ISO20022` (violations logged as server bugs), camt.053 statement Id fits Max35Text

## Phase 9: Signature classes

- [x] Signature class per subscriber (`E`, `A`, `B`, `T`, default `E`): `PATCH /api/subscribers/:partnerId/:userId` / `POST /api/subscribers` `signatureClass` and a select on the subscriber page; replaces `EBICS_EDS_HOLD`
- [x] Uploads (EBICS 3.0.2 chapter 11.2.3, SignatureFlag documentation in the H005 schema): no SignatureFlag → executed, signature counts as `T`; class authorises alone (`E`) → executed; otherwise `requestEDS` → VEU, without `requestEDS` → `090003` ("Authorization failed", chapter 3.14) with HAC `DS19`
- [x] VEU release when the signatures of distinct users authorise the order: one `E`, or two with at least one `E` or `A`; `T` never counts; HVE/HVS by `T` → `090003`
- [x] HVZ/HVD `SignerInfo/Permission@AuthorisationLevel` = the signer's class, `readyToBeSigned` and `NumSigRequired` follow the rules; HKD/HTD permissions of upload order types carry the user's class, `T` users have no HVE/HVS permission
- [x] Protocol downloads (HAC, PTK) per subscriber instead of `EBICS_HAC_DENY_PARTNERS`

## Phase 10: VEU overview

- [x] HVU (EBICS 3.0.2 chapter 8.3.1): Service, OrderID, OrderDataSize, SigningInfo, SignerInfo and OriginatorInfo of every order waiting for signatures
- [x] ServiceFilter in HVUOrderParams and HVZOrderParams: every given element must match, an order is listed when it matches one filter (chapter 8.3.6)
- [x] HVU/HVZ list only orders the subscriber may sign (none for class `T` → `090005`); HVD/HVT by class `T` → `091007` EBICS_DISTRIBUTED_SIGNATURE_AUTHORISATION_FAILED (chapters 8.3.2, 8.3.3)
- [x] HVZ `TotalAmount@isCredit="true"` for credit transfers (chapter 8.3.1.4)
- [x] HVT with `completeOrderData="false"` (chapter 8.3.3): HVTResponseOrderData with NumOrderInfos and one OrderInfo per CdtTrfTxInf (MsgName, Originator/Recipient AccountInfo with IBAN, BIC if in the file and name, ExecutionDate, Amount `isCredit="true"`, Purpose description), `fetchLimit` (0 = all) and `fetchOffset`; an offset at or beyond the number of single orders → `091112`
- [x] E002 AES padding per ANSI X9.23 / ISO 10126-2 (chapter 11.3.2.1) for every encrypted download including HPB: zeros and a last byte with the padding length (1-16); received order data is unpadded by that length byte, which also covers PKCS#7
- [x] Electronic signatures verified (EBICS 3.0.2 chapters 5.3 and 14.1, `src/banking/electronic-signatures.ts`): UserSignatureData must decrypt, inflate and conform to ebics_signature_S002.xsd (`091111` with DS09, DS08, TD03); every OrderSignatureData belongs to the customer of the request (`091120` DS0G), names a known subscriber (`091304` DS14) in state READY (`091305` DS0C suspended, DS27 not activated) with a registered signature key of the same version (`091301` DS0E, DS16), appears once per user (`091306` DS26) and carries a valid A005/A006 signature over the order data without CR, LF and Ctrl-Z (`091301` DS0B). Refused uploads record `ES_VERIFICATION` with that reason code
- [x] Uploads and HVE may carry EUs of several users, which authorise together (e.g. A + B); a class T uploader may submit the EUs of other users. HVE/HVS sign the order data waiting in the VEU; nothing is recorded when one EU fails
- [x] PUB, HCA and HCS need exactly one EU of the subscriber whose keys change (chapter 4.6.1), verified with the signature key registered so far. Interpretations where the spec names no reason code: an EU of another or an additional user → `091301` DS0G; an EU of another customer → DS0G

### Not yet supported (TODO)

- [ ] SPR: verify the EU over the order data (a single space); SPR is accepted without signature check
- [ ] VEU signatures (HVE/HVS) by users of other customers; EUs must belong to the customer of the request (`091120`)
- [ ] Replay of real-time messages for clients that were not connected
- [ ] Technical subscribers with `SystemID` submitting on behalf of other users
- [ ] Signature permissions limited to accounts, amounts or BTF, and orders that need two bank-technical signatures (minimum 2)
- [ ] VEU for direct debits (pain.008 uploads are executed even when signatures are missing and `requestEDS` is set)
- [ ] Customers without VEU agreement (`091007`) or without authorisation outside EBICS (`090003`), chapter 3.14; every customer is assumed to have both
