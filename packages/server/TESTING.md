# EBICS Test Server — Client Connection Guide

## Server Details

| Setting | Value |
|---|---|
| **EBICS Endpoint** | `http://localhost:4000/ebics` |
| **Protocol Version** | H005 (EBICS 3.0) |
| **Host ID** | `TESTHOST` |
| **Partner ID** | `TESTPARTNER` |
| **User ID** | `TESTUSER` |
| **Admin API** | `http://localhost:4000/admin` |

## Pre-configured Test Subscriber

A subscriber is already created and waiting in `NEW` state:

- **Partner ID**: `TESTPARTNER`
- **User ID**: `TESTUSER`
- **State**: `NEW` (ready for INI/HIA)

## Connection Flow

### 1. HEV (Version Negotiation)

Send an `ebicsHEVRequest` to verify connectivity:

```
POST http://localhost:4000/ebics
Content-Type: text/xml

<?xml version="1.0" encoding="UTF-8"?>
<ebicsHEVRequest xmlns="http://www.ebics.org/H000">
  <HostID>TESTHOST</HostID>
</ebicsHEVRequest>
```

Expected: Response with `000000` (OK) and `H005`/`03.00`.

### 2. INI (Send Signature Key)

Send `ebicsUnsecuredRequest` with `AdminOrderType=INI`. The `OrderData` field must contain:
`base64(deflate(SignaturePubKeyOrderData XML))`

The `SignaturePubKeyOrderData` XML uses namespace `http://www.ebics.org/S002` and must contain:
- `SignaturePubKeyInfo` → `ds:X509Data` → `ds:X509Certificate` (base64 DER cert)
- `SignatureVersion`: `A005` or `A006`
- `PartnerID`: `TESTPARTNER`
- `UserID`: `TESTUSER`

After success: subscriber state → `PARTIALLY_INITIALIZED_INI`

### 3. HIA (Send Auth + Encryption Keys)

Send `ebicsUnsecuredRequest` with `AdminOrderType=HIA`. The `OrderData` field must contain:
`base64(deflate(HIARequestOrderData XML))`

The `HIARequestOrderData` XML uses namespace `urn:org:ebics:H005` and must contain:
- `AuthenticationPubKeyInfo` → `ds:X509Data` → `ds:X509Certificate` + `AuthenticationVersion` (`X002`)
- `EncryptionPubKeyInfo` → `ds:X509Data` → `ds:X509Certificate` + `EncryptionVersion` (`E002`)
- `PartnerID`: `TESTPARTNER`
- `UserID`: `TESTUSER`

After success: subscriber state → `INITIALIZED`

### 4. Activate Subscriber (Admin API)

This simulates the bank activating the subscriber after verifying the INI letter:

```bash
curl -X POST http://localhost:4000/admin/subscribers/TESTPARTNER/TESTUSER/activate
```

After success: subscriber state → `READY`

### 5. HPB (Download Bank Keys)

Send `ebicsNoPubKeyDigestsRequest` with `AdminOrderType=HPB`. This request **requires AuthSignature** (XMLDSig over all `authenticate="true"` elements using the subscriber's X002 authentication key).

Response contains encrypted `HPBResponseOrderData` with the bank's:
- Authentication public key (X002) as X.509 certificate
- Encryption public key (E002) as X.509 certificate

Encryption: `AES-128-CBC` with zero IV, transaction key wrapped with subscriber's E002 public key via `RSA-PKCS1`.

## Admin API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/admin/subscribers` | List all subscribers |
| `GET` | `/admin/subscribers/:partnerId/:userId` | Get subscriber state |
| `POST` | `/admin/subscribers` | Create subscriber (`{"partnerId":"...","userId":"..."}`) |
| `POST` | `/admin/subscribers/:partnerId/:userId/activate` | Activate (requires INITIALIZED state) |
| `DELETE` | `/admin/subscribers/:partnerId/:userId` | Delete subscriber |
| `POST` | `/admin/host` | Reconfigure host (`{"hostId":"..."}`) |
| `POST` | `/admin/reset` | Reset all state |

## Check Subscriber State

```bash
curl http://localhost:4000/admin/subscribers/TESTPARTNER/TESTUSER
```

## Key Technical Details

- All EBICS responses use HTTP 200 (even errors) — error info is in the XML `ReturnCode`
- All requests/responses are validated against official EBICS H005 XSD schemas
- Supported key formats: X.509 certificates (required for H005), RSA 2048-bit minimum
- `SecurityMedium`: `0000` (software)
- INI and HIA can be sent in any order
- Both must complete before activation is possible

## Return Codes

| Code | Meaning |
|---|---|
| `000000` | OK |
| `061001` | Authentication failed (bad AuthSignature) |
| `090004` | Invalid order data format |
| `091003` | Unknown user |
| `091004` | Invalid user state |
| `091010` | Invalid XML (XSD validation failed) |
| `091011` | Invalid Host ID |
