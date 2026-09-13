# HAC (Customer Acknowledgement / Kundenprotokoll) — Implementation Plan

Status: IMPLEMENTED (2026-09-12) behind `EBICS_HAC_FORMAT=pain.002`. The legacy `<HACResponseOrderData>`
stays the default HAC output; the event ledger is recorded in both modes. Original goal: replace the
made-up format with the pain.002.001.03-format report that BIL, Spuerkeess and Sparkasse actually send,
so the luxfit `HacProcessingService` (and any other client) can be tested end-to-end: upload → OrderID →
lifecycle events → FINAL_POS / FINAL_NEG.

Deviations from the plan below (updated 2026-09-13):

- `FILE_DOWNLOAD` events only with `EBICS_HAC_DOWNLOAD_EVENTS=true`. Every download except HAC and PTK
  then gets its own OrderID and carries the BTF attributes of the request.
- No dialect or language flags: one German, Sparkasse-style attribute set. `Scope` and `ContainerType`
  appear only when an event carries them.
- `090003` is a per-subscriber setting instead of a flag: `protocolDownloadsAllowed` on the subscriber
  (admin API `PATCH /api/subscribers/:partnerId/:userId`, toggle on the subscriber page) covers HAC and
  PTK, and HKD/HTD leave both out of that user's permissions.
- Admin routes are `GET/POST /api/hac-events`, `GET /api/hac/report?partnerId=` and
  `POST /api/payments/:id/release|cancel|reject` instead of `/api/uploaded-orders/:id/hac/final`.
  `GET /api/ptk/report?partnerId=` previews the text protocol.
- Held uploads additionally produce `VEU_FORWARDING`, `VEU_VERIFICATION_END` and `VEU_CANCEL_ORDER`
  events. Orders are held when they request EDS and the uploader's signature class does not authorise them
  alone (class A, B or T), or when `EBICS_VOP_CONFIRMATION=true` and the VoP group result is not RCVC.
- Uploads with SignatureFlag but without `requestEDS` whose signature class does not authorise the order are
  refused with `090003` (EBICS 3.0.2 chapter 3.14): `FILE_UPLOAD`, `ES_VERIFICATION` with `DS19` and `ORDER_HAC_FINAL_NEG`.
- Uploads, PUB, HCA and HCS whose electronic signatures fail verification produce `FILE_UPLOAD`,
  `ES_VERIFICATION` with the reason of the failed check (`DS0B` incorrect, `DS0C` signer blocked, `DS0E` no public
  key, `DS0G` signer not authorised or of another customer, `DS14` unknown user, `DS16` wrong key version, `DS26`
  same user twice, `DS27` not activated, `DS08`/`DS09`/`TD03` undecodable signature data) and `ORDER_HAC_FINAL_NEG`.
- VEU signatures (HVE) produce `ES_UPLOAD` and one `ES_VERIFICATION` per signer under the HVE's own OrderID, with the BTU
  order as reference. An HVE or HVS whose EUs fail verification only returns the error code. Cancellations (HVS, or the bank-side `/api/veu/orders` API) produce
  `VEU_CANCEL_ORDER` under the HVS OrderID.
- PTK renders the same ledger as ISO-8859-1 text. Without a DateRange it returns only entries not yet
  fetched via PTK.

## 1. What real banks send (observed in luxfit prod, 5 active configs, 851 HAC pulls)

Source: `ebics_order_ack.rawInfo` (Sparkasse Oldenburg cfg 5, BIL Belval cfg 6) + luxfit fixture
`hacBankReport()` in `apps/backend/src/direct-debit/test/bank-document-fixtures.ts`.

### Envelope

```xml
<?xml version="1.0" encoding="UTF-8" ?>
<Document xsi:schemaLocation="urn:iso:std:iso:20022:tech:xsd:pain.002.001.03 pain.002.001.03.xsd"
          xmlns="urn:iso:std:iso:20022:tech:xsd:pain.002.001.03"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<CstmrPmtStsRpt>
  <GrpHdr>
    <MsgId>8l6H5FfDYaABAADN2yoH0EGyCgQA</MsgId>      <!-- random per pull -->
    <CreDtTm>2026-09-02T11:15:15.215Z</CreDtTm>       <!-- FETCH time, not event time -->
    <InitgPty><Id><OrgId><Othr><Id>BILLLULLXXX</Id></Othr></OrgId></Id></InitgPty>  <!-- bank BIC -->
  </GrpHdr>
  <OrgnlGrpInfAndSts><OrgnlMsgId>EBICS</OrgnlMsgId><OrgnlMsgNmId>EBICS</OrgnlMsgNmId></OrgnlGrpInfAndSts>
  <!-- one OrgnlPmtInfAndSts per bank-server EVENT, chronological -->
  ...
</CstmrPmtStsRpt>
</Document>
```

### Event block

```xml
<OrgnlPmtInfAndSts>
  <OrgnlPmtInfId>ES_VERIFICATION</OrgnlPmtInfId>            <!-- the ACTION -->
  <StsRsnInf>
    <Orgtr>
      <Nm>LUX BELVAL SARL</Nm>                                <!-- partner/customer name -->
      <Id><OrgId>
        <Othr><Id>E20057172</Id><SchmeNm><Prtry>PartnerID</Prtry></SchmeNm></Othr>
        <Othr><Id>BTU</Id><SchmeNm><Prtry>AdminOrderType</Prtry></SchmeNm></Othr>
        <Othr><Id>SDD</Id><SchmeNm><Prtry>ServiceName</Prtry></SchmeNm></Othr>
        <Othr><Id>COR</Id><SchmeNm><Prtry>ServiceOption</Prtry></SchmeNm></Othr>
        <Othr><Id>pain.008</Id><SchmeNm><Prtry>MsgName</Prtry></SchmeNm></Othr>
        <Othr><Id>N002</Id><SchmeNm><Prtry>OrderID</Prtry></SchmeNm></Othr>
        <Othr><Id>Z8184882</Id><SchmeNm><Prtry>UserID</Prtry></SchmeNm></Othr>
        <Othr><Id>2026-08-28T15:11:55.242Z</Id><SchmeNm><Prtry>TimeStamp</Prtry></SchmeNm></Othr>
      </OrgId></Id>
    </Orgtr>
    <Rsn><Cd>DS01</Cd></Rsn>                                  <!-- optional -->
    <AddtlInf>line 1</AddtlInf>                               <!-- 0..n, one element per line -->
  </StsRsnInf>
</OrgnlPmtInfAndSts>
```

### Observed action → attributes → reason matrix

| Action                | Rsn/Cd | UserID attr | AddtlInf                                                        | luxfit verdict |
| --------------------- | ------ | ----------- | --------------------------------------------------------------- | -------------- |
| `FILE_UPLOAD`         | `TS01` | yes         | none                                                            | pending        |
| `ES_VERIFICATION` ok  | `DS01` | yes         | none                                                            | pending        |
| `ES_VERIFICATION` bad | `TD03` | yes         | `Datei ist in ihrem Aufbau fehlerhaft` (Sparkasse)              | pending        |
| `ORDER_HAC_FINAL_POS` | —      | BIL yes / Sparkasse **no** | multi-line bank protocol text (see below), none for INI/HIA | final_positive |
| `ORDER_HAC_FINAL_NEG` | —      | **no**      | parser error text, e.g. `Unexpected element 'Document' at` + `""` | final_negative |

Per-bank attribute sets on the `Othr` list:

- **BIL (LU)**: PartnerID, AdminOrderType, ServiceName, ServiceOption, MsgName, OrderID, UserID, TimeStamp.
- **Sparkasse (DE, F81-ELKO)**: PartnerID, AdminOrderType, ServiceName, **Scope (`DE`)**, ServiceOption,
  **ContainerType (`XML`)**, MsgName, OrderID, UserID, TimeStamp.
- **INI / HIA** (key mgmt, BIL): PartnerID, AdminOrderType (`INI`/`HIA`), OrderID, UserID, TimeStamp — no
  ServiceName/MsgName.
- Spuerkeess: emits the literal OrderID `ZZZZ` for some events (luxfit tolerates by upload-row match).

### FINAL_POS protocol text (`AddtlInf`, one element per line)

BIL (French):

```
====================================================================
P R É L È V E M E N T S
ID fichier                   : LUX-95-6-1787929913973
Date/Heure                   : 28.08.2026
Nombre d'opérations          : 1
Somme de contrôle du fichier : 0,01
--------------------------------------------------------------------
Référence collecteur         : LUX-95-6-1787929913973-FRST
Somme de contrôle collecteur : 0,01
Code banque                  : BILLLULLXXX
Numéro de compte national    :
Numéro IBAN                  : LU770022000001916990
Devise du compte             :
Données du donneur d'ordre   : Lux Belval S.a r.l
Date d'échéance              : 31.08.2026
Nombre d'opérations          : 1
Devise de l'ordre            : EUR
Somme des montants           : 0,01
====================================================================
```

Sparkasse (German):

```
============================================================
L A S T S C H R I F T E N
Datei-ID   : LUX-98-5-1788360856434
Datum/Zeit : 02.09.2026/14:54:16.442Z
------------------------------------------------------------
Sammlerreferenz          : LUX-98-5-1788360856434-FRST
Bank-Code                : SLZODE22XXX
Kontonummer              : DE13280501000094445905
Auftraggeberdaten        : 2Grow - Fitness + Health GmbH
Anzahl der Zahlungssaetze: 1
Summe der Betraege (EUR) : 0,01
Faelligkeitsdatum        : 03.09.2026
============================================================
```

`ID fichier`/`Datei-ID` = pain.008 `GrpHdr/MsgId`; `Référence collecteur`/`Sammlerreferenz` =
`PmtInf/PmtInfId`; sums = `CtrlSum`; due date = `ReqdColltnDt`. All derivable from the uploaded file.

### Timing observed

- FILE_UPLOAD → ES_VERIFICATION → FINAL_*: same second to ~15 s for SDD.
- INI/HIA: FILE_UPLOAD at upload; FINAL_POS only ~1 day later, when the bank activated the keys.
- `GrpHdr/CreDtTm` is the pull time; the per-event `TimeStamp` attr is the idempotency key clients use.
- Report is cumulative per subscriber (whole history within `DateRange`), includes downloads and
  other users' orders. Clients re-pull hourly with overlapping windows → entries must be stable
  (same TimeStamp every time).
- Business return codes seen on HAC: `000000`, and `090003` EBICS_AUTHORISATION_ORDER_TYPE_FAILED when
  the subscriber isn't authorised for HAC. Empty window → `090005` EBICS_NO_DOWNLOAD_DATA_AVAILABLE
  (BTD behaviour; not directly observed for HAC but the dispatcher already does this on `null`).

## 2. Gaps in the test server

1. **No OrderID on uploads.** `buildEbicsResponse` never sets `header/mutable/OrderID`; real banks return
   a 4-char OrderID (`[A-Z][A-Z0-9]{3}`, e.g. `N000`, `M002`, sequential per partner) on the upload
   *Initialisation* response. luxfit stores it in `ebics_transaction_log.orderId` and joins HAC on it —
   without it, every HAC entry is "foreign" and dropped.
2. **No event ledger.** `activity_log` records one row per HTTP request (`ebics_request`), not
   bank-side order lifecycle steps, and has no OrderID / timestamps per step.
3. **`handleHac` output format is fictional.**
4. **No `DateRange` parsing** for HAC (`StandardOrderParams/DateRange/Start|End`, dates `YYYY-MM-DD`).
5. **No way to inject a negative outcome** (FINAL_NEG, TD03) from the admin API/UI.

## 3. Design

### 3.1 OrderID allocation

- `store.nextOrderId(partnerId)`: per-partner counter → `A000`…`A999`, `B000`… (letter + 3 alnum). Persist
  in a new `order_id_counters(partner_id PK, next INTEGER)` table.
- Assign in `handleUploadInit` (dispatcher ~L370-400) and keep it on the `transactions` row
  (`order_id TEXT`) so the final segment handler can pass it on to `uploaded_orders.order_id`.
- Emit `<OrderID>` in the upload Initialisation **and** Transfer responses (banks repeat it; keep
  `buildEbicsResponse({ orderId })` optional so downloads stay unchanged).
- INI/HIA: allocate too (banks do) and emit via the existing `buildKeyManagementResponse(..., orderId)`.

### 3.2 `hac_events` table

```sql
CREATE TABLE IF NOT EXISTS hac_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    partner_id TEXT NOT NULL,
    user_id TEXT,                 -- NULL for FINAL_* (banks omit UserID there)
    order_id TEXT NOT NULL,
    action TEXT NOT NULL,         -- FILE_UPLOAD | ES_VERIFICATION | ORDER_HAC_FINAL_POS | ORDER_HAC_FINAL_NEG | …
    admin_order_type TEXT NOT NULL,  -- BTU | BTD | INI | HIA | HPB | HTD …
    service_name TEXT, service_option TEXT, scope TEXT, container_type TEXT, msg_name TEXT,
    reason_code TEXT,             -- TS01 | DS01 | TD03 | …
    additional_info TEXT,         -- JSON string[] (one AddtlInf per line)
    event_at TEXT NOT NULL,       -- ISO ms UTC; stable across pulls
    uploaded_order_id INTEGER REFERENCES uploaded_orders(id)
);
CREATE INDEX idx_hac_events_partner_time ON hac_events(partner_id, event_at, id);
```

`store.appendHacEvent(...)`, `store.listHacEvents(partnerId, {from?, to?})`,
`store.listHacEventsForOrder(orderId)`.

### 3.3 Event producers (bank lifecycle simulation)

| Trigger                                            | Events appended                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| INI / HIA accepted                                 | `FILE_UPLOAD` TS01                                                                                     |
| admin `activate` subscriber                        | `ORDER_HAC_FINAL_POS` for INI + HIA order ids (mirrors BIL: 1 day later in prod)                        |
| BTU last segment, handler returns `EBICS_OK`       | `FILE_UPLOAD` TS01 → `ES_VERIFICATION` DS01 → `ORDER_HAC_FINAL_POS` + protocol text (from parsed pain)   |
| BTU last segment, handler returns business error   | `FILE_UPLOAD` TS01 → `ES_VERIFICATION` TD03 + info → `ORDER_HAC_FINAL_NEG` + error text                   |
| BTD / HTD / HAC / HKD downloads                    | `FILE_DOWNLOAD` (optional, keeps the "report includes downloads" realism; feature-flag)                  |
| admin override (see 3.6)                           | arbitrary action/reason/info, or delayed FINAL_* to test "still pending" paths                          |

Config knobs (feature-flags.ts): `EBICS_HAC_AUTO_FINAL` (default `true`) — when `false`, uploads stop
at ES_VERIFICATION and the admin decides (simulates VEU / manual bank release). `EBICS_HAC_LANGUAGE`
(`de`|`fr`, default `de`) picks the protocol-text template. `EBICS_HAC_DIALECT` (`bil`|`sparkasse`,
default `bil`) picks the attribute set (Scope/ContainerType only for `sparkasse`).

### 3.4 `handleHac` rewrite

- Parse `StandardOrderParams/DateRange/Start|End` (optional). Filter `event_at` by day range in UTC.
- Restrict to the requesting **partner** (bank reports are per customer, include all users of the partner).
- Empty → return `null` → dispatcher answers `090005`.
- Render pain.002.001.03 per §1 with xmlbuilder2: fresh random `MsgId` (base64url 28 chars), `CreDtTm` =
  now, `InitgPty` = `bank_config.bic`, static `EBICS` group block, then events ascending by `(event_at, id)`.
- `Orgtr/Nm` = partner name (add `name` to `subscribers`? simplest: `persons.name` of the first account
  the partner may access, else the partner id).
- Optional XSD validation against `pain.002.001.03.xsd` (add schema under `schemas/pain/`; keep behind
  the existing validator so tests assert schema-valid output).

### 3.5 Return-code realism

- Subscriber not authorised for HAC → `090003`. Implemented as a per-subscriber
  `protocolDownloadsAllowed` setting (admin API/UI) rather than an environment flag, which is enough for
  the luxfit "090003 → surface in admin" test.

### 3.6 Admin API / UI

- `GET /api/hac-events?partnerId=&orderId=` — list.
- `POST /api/hac-events` — append arbitrary event (body mirrors the table; `orderId` required).
- `POST /api/uploaded-orders/:id/hac/final` `{ outcome: 'positive'|'negative', reason?, info?[] }` —
  convenience for the "manual release" mode.
- `GET /api/hac/preview?partnerId=` — render the current report XML (like statement preview).
- UI: "HAC" tab on the subscriber page: timeline of events per OrderID, buttons "Final positive",
  "Final negative", "Add event".

### 3.7 Tests

- `store.test.ts`: OrderID counter, event append/list/range filter.
- `dispatcher.test.ts`: upload init response carries `OrderID`; same id on Transfer response; INI/HIA
  responses carry `OrderID`.
- `download-handlers.test.ts` (rewrite HAC block): after a BTU pain.008 upload, HAC returns
  pain.002.001.03 with FILE_UPLOAD/ES_VERIFICATION/FINAL_POS blocks whose `OrderID` attr = the upload
  response's OrderID; FINAL_POS `AddtlInf` contains `Sammlerreferenz : <PmtInfId>`; error upload →
  FINAL_NEG with TD03; DateRange excludes older events; empty → `090005`; deny-list → `090003`.
- Golden test: feed the rendered XML through a copy of luxfit's `hacBankReport` expectations (field
  names above) — or simply assert the exact `Othr` key order per dialect.
- Integration (luxfit side, separate repo): point a dev config at the test server, upload, run the
  hourly HAC job, assert `ebics_order_ack` rows + item timeline events. Not part of this repo.

## 4. Work breakdown (suggested order)

1. Schema + store: `order_id_counters`, `transactions.order_id`, `uploaded_orders.order_id`, `hac_events`.
2. OrderID on upload init/transfer + INI/HIA responses (`xml-builder`, `dispatcher`, `ini`, `hia`).
3. Event producers in dispatcher upload completion + subscriber activation.
4. Protocol-text templates (de/fr) fed from `pain008.ts` parse result (MsgId, PmtInfId, CtrlSum, NbOfTxs,
   ReqdColltnDt, creditor IBAN/name, bank BIC).
5. `handleHac` rewrite + DateRange + partner scoping + `null` on empty.
6. Feature flags + 090003 deny-list.
7. Admin API + UI tab.
8. Tests + `TASKS.md` phase "HAC customer acknowledgement" + README feature line.

Rough size: ~600 LOC server, ~200 LOC UI, 1–2 days.
