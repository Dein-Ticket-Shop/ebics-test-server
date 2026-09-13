import { describe, it, expect, beforeEach } from 'vitest';
import { privateDecrypt, createDecipheriv, constants } from 'node:crypto';
import { createTestApp, postEbics, HOST_ID, PARTNER_ID, USER_ID } from '../helpers/test-server.js';
import {
  esSigner,
  generateTestClientKeys,
  buildIniRequest,
  buildHiaRequest,
  buildHpbRequest,
  buildEbicsDownloadInitRequest,
  buildEbicsReceiptRequest,
  buildEbicsUploadTransferRequest,
  buildEbicsKeyMgmtUploadInitRequest,
  buildEbicsSprRequest,
  encryptUploadContent,
  decryptDownloadResponse,
  type BankCerts,
  type TestClientKeys,
} from '../helpers/test-client.js';
import { parseXml, xpathString } from '../../src/protocol/xml-parser.js';
import { SubscriberState } from '../../src/store/types.js';
import { extractPublicKeyFromCertBase64 } from '../../src/protocol/xml-signature.js';
import type { SqliteStore } from '../../src/store/sqlite-store.js';

function certToBase64(pem: string): string {
  return pem.replace(/-----BEGIN CERTIFICATE-----/g, '').replace(/-----END CERTIFICATE-----/g, '').replace(/\s/g, '');
}

async function setupReadySubscriber(
  app: any,
  store: SqliteStore,
  clientKeys: TestClientKeys,
): Promise<BankCerts> {
  store.createSubscriber(PARTNER_ID, USER_ID);
  await postEbics(app, buildIniRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));
  await postEbics(app, buildHiaRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));
  await app.request(`/api/subscribers/${PARTNER_ID}/${USER_ID}/activate`, { method: 'POST' });
  const hostConfig = store.getHostConfig()!;
  return {
    authCertPem: hostConfig.bankKeys.authenticationCertificate,
    encCertPem: hostConfig.bankKeys.encryptionCertificate,
  };
}

function getBankEncPubKey(store: SqliteStore): string {
  const hostConfig = store.getHostConfig()!;
  return extractPublicKeyFromCertBase64(certToBase64(hostConfig.bankKeys.encryptionCertificate));
}

function buildSignaturePubKeyOrderData(keys: TestClientKeys): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<SignaturePubKeyOrderData xmlns="http://www.ebics.org/S002" xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <SignaturePubKeyInfo>
    <ds:X509Data><ds:X509Certificate>${certToBase64(keys.signatureCert)}</ds:X509Certificate></ds:X509Data>
    <SignatureVersion>A006</SignatureVersion>
  </SignaturePubKeyInfo>
  <PartnerID>${PARTNER_ID}</PartnerID>
  <UserID>${USER_ID}</UserID>
</SignaturePubKeyOrderData>`;
}

function buildHiaOrderData(keys: TestClientKeys): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<HIARequestOrderData xmlns="urn:org:ebics:H005" xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <AuthenticationPubKeyInfo>
    <ds:X509Data><ds:X509Certificate>${certToBase64(keys.authCert)}</ds:X509Certificate></ds:X509Data>
    <AuthenticationVersion>X002</AuthenticationVersion>
  </AuthenticationPubKeyInfo>
  <EncryptionPubKeyInfo>
    <ds:X509Data><ds:X509Certificate>${certToBase64(keys.encCert)}</ds:X509Certificate></ds:X509Data>
    <EncryptionVersion>E002</EncryptionVersion>
  </EncryptionPubKeyInfo>
  <PartnerID>${PARTNER_ID}</PartnerID>
  <UserID>${USER_ID}</UserID>
</HIARequestOrderData>`;
}

function buildHcsOrderData(keys: TestClientKeys): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<HCSRequestOrderData xmlns="urn:org:ebics:H005" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:s002="http://www.ebics.org/S002">
  <s002:SignaturePubKeyInfo>
    <ds:X509Data><ds:X509Certificate>${certToBase64(keys.signatureCert)}</ds:X509Certificate></ds:X509Data>
    <s002:SignatureVersion>A006</s002:SignatureVersion>
  </s002:SignaturePubKeyInfo>
  <AuthenticationPubKeyInfo>
    <ds:X509Data><ds:X509Certificate>${certToBase64(keys.authCert)}</ds:X509Certificate></ds:X509Data>
    <AuthenticationVersion>X002</AuthenticationVersion>
  </AuthenticationPubKeyInfo>
  <EncryptionPubKeyInfo>
    <ds:X509Data><ds:X509Certificate>${certToBase64(keys.encCert)}</ds:X509Certificate></ds:X509Data>
    <EncryptionVersion>E002</EncryptionVersion>
  </EncryptionPubKeyInfo>
  <PartnerID>${PARTNER_ID}</PartnerID>
  <UserID>${USER_ID}</UserID>
</HCSRequestOrderData>`;
}

async function doUpload(
  app: any,
  store: SqliteStore,
  clientKeys: TestClientKeys,
  bankCerts: BankCerts,
  orderType: string,
  content: string,
): Promise<string> {
  const bankEncPubKey = getBankEncPubKey(store);
  const enc = encryptUploadContent(content, bankEncPubKey, esSigner(PARTNER_ID, USER_ID, clientKeys));
  const initRes = await postEbics(app, buildEbicsKeyMgmtUploadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, orderType, enc));
  const initBody = await initRes.text();
  expect(initBody).toContain('000000');
  const initDoc = parseXml(initBody);
  const txId = xpathString('//ebics:TransactionID/text()', initDoc)!;

  for (let i = 0; i < enc.numSegments; i++) {
    const transferRes = await postEbics(app, buildEbicsUploadTransferRequest(HOST_ID, clientKeys, txId, i + 1, i === enc.numSegments - 1, enc.segments[i]));
    expect(await transferRes.text()).toContain('000000');
  }

  const receiptRes = await postEbics(app, buildEbicsReceiptRequest(HOST_ID, clientKeys, txId));
  return await receiptRes.text();
}

describe('Key Management', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: ReturnType<typeof createTestApp>['store'];
  let clientKeys: TestClientKeys;
  let bankCerts: BankCerts;

  beforeEach(async () => {
    const test = createTestApp();
    app = test.app;
    store = test.store;
    clientKeys = generateTestClientKeys();
    bankCerts = await setupReadySubscriber(app, store, clientKeys);
  });

  describe('PUB — replace signature key', () => {
    it('should update signature key', async () => {
      const newKeys = generateTestClientKeys();
      const orderData = buildSignaturePubKeyOrderData(newKeys);
      const receiptBody = await doUpload(app, store, clientKeys, bankCerts, 'PUB', orderData);
      expect(receiptBody).toContain('000000');

      const sub = store.getSubscriber(PARTNER_ID, USER_ID)!;
      expect(sub.keys.signatureVersion).toBe('A006');
      expect(sub.keys.signatureCertificate).toBe(certToBase64(newKeys.signatureCert));
    });
  });

  describe('HCA — replace auth + enc keys', () => {
    it('should update auth and encryption keys', async () => {
      const newKeys = generateTestClientKeys();
      const orderData = buildHiaOrderData(newKeys);
      const receiptBody = await doUpload(app, store, clientKeys, bankCerts, 'HCA', orderData);
      expect(receiptBody).toContain('000000');

      const sub = store.getSubscriber(PARTNER_ID, USER_ID)!;
      expect(sub.keys.authenticationCertificate).toBe(certToBase64(newKeys.authCert));
      expect(sub.keys.encryptionCertificate).toBe(certToBase64(newKeys.encCert));
    });
  });

  describe('HCS — replace all keys', () => {
    it('should update all three keys', async () => {
      const newKeys = generateTestClientKeys();
      const orderData = buildHcsOrderData(newKeys);
      const receiptBody = await doUpload(app, store, clientKeys, bankCerts, 'HCS', orderData);
      expect(receiptBody).toContain('000000');

      const sub = store.getSubscriber(PARTNER_ID, USER_ID)!;
      expect(sub.keys.signatureCertificate).toBe(certToBase64(newKeys.signatureCert));
      expect(sub.keys.authenticationCertificate).toBe(certToBase64(newKeys.authCert));
      expect(sub.keys.encryptionCertificate).toBe(certToBase64(newKeys.encCert));
    });
  });

  describe('SPR — suspend subscriber', () => {
    it('should suspend subscriber', async () => {
      const sprRes = await postEbics(
        app,
        buildEbicsSprRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, getBankEncPubKey(store)),
      );
      expect(await sprRes.text()).toContain('000000');

      const sub = store.getSubscriber(PARTNER_ID, USER_ID)!;
      expect(sub.state).toBe(SubscriberState.SUSPENDED);
    });

    it('should reject requests after suspension', async () => {
      await postEbics(app, buildEbicsSprRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, getBankEncPubKey(store)));

      const hpdRes = await postEbics(
        app,
        buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'HPD'),
      );
      expect(await hpdRes.text()).toContain('091004');
    });
  });

  describe('Error handling', () => {
    it('should reject unknown host ID', async () => {
      const res = await postEbics(
        app,
        buildEbicsDownloadInitRequest('WRONGHOST', PARTNER_ID, USER_ID, clientKeys, bankCerts, 'HPD'),
      );
      expect(await res.text()).toContain('091011');
    });

    it('should reject unknown user', async () => {
      const res = await postEbics(
        app,
        buildEbicsDownloadInitRequest(HOST_ID, 'NOPARTNER', 'NOUSER', clientKeys, bankCerts, 'HPD'),
      );
      expect(await res.text()).toContain('091003');
    });
  });
});
