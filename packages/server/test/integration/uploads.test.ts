import { describe, it, expect, beforeEach } from 'vitest';
import { privateDecrypt, createDecipheriv, constants } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { createTestApp, postEbics, HOST_ID, PARTNER_ID, USER_ID } from '../helpers/test-server.js';
import {
  generateTestClientKeys,
  buildIniRequest,
  buildHiaRequest,
  buildHpbRequest,
  buildEbicsUploadInitRequest,
  buildEbicsUploadTransferRequest,
  buildEbicsReceiptRequest,
  encryptUploadContent,
  type BankCerts,
  type TestClientKeys,
} from '../helpers/test-client.js';
import { parseXml, xpathString } from '../../src/protocol/xml-parser.js';
import { calculateIban } from '../../src/banking/iban.js';
import { extractPublicKeyFromCertBase64 } from '../../src/protocol/xml-signature.js';
import type { SqliteStore } from '../../src/store/sqlite-store.js';

async function setupReadySubscriber(
  app: any,
  store: SqliteStore,
  clientKeys: TestClientKeys,
): Promise<BankCerts> {
  store.createSubscriber(PARTNER_ID, USER_ID);
  await postEbics(app, buildIniRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));
  await postEbics(app, buildHiaRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));
  await app.request(`/api/subscribers/${PARTNER_ID}/${USER_ID}/activate`, { method: 'POST' });

  const hpbRes = await postEbics(app, buildHpbRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));
  const hpbBody = await hpbRes.text();
  const hostConfig = store.getHostConfig()!;
  return {
    authCertPem: hostConfig.bankKeys.authenticationCertificate,
    encCertPem: hostConfig.bankKeys.encryptionCertificate,
  };
}

function getBankEncPubKey(store: SqliteStore): string {
  const hostConfig = store.getHostConfig()!;
  const certB64 = hostConfig.bankKeys.encryptionCertificate
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s/g, '');
  return extractPublicKeyFromCertBase64(certB64);
}

describe('Uploads', () => {
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

  describe('Single-segment upload', () => {
    it('should upload and store content via BTU', async () => {
      const testContent = 'Hello from upload test!';
      const bankEncPubKey = getBankEncPubKey(store);
      const enc = encryptUploadContent(testContent, bankEncPubKey, PARTNER_ID, USER_ID);

      // Init
      const initRes = await postEbics(
        app,
        buildEbicsUploadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'SCT', 'pain.001', enc),
      );
      const initBody = await initRes.text();
      expect(initBody).toContain('000000');

      const initDoc = parseXml(initBody);
      const transactionId = xpathString('//ebics:TransactionID/text()', initDoc)!;
      expect(transactionId).toBeTruthy();

      // Transfer (1 segment)
      const transferRes = await postEbics(
        app,
        buildEbicsUploadTransferRequest(HOST_ID, clientKeys, transactionId, 1, true, enc.segments[0]),
      );
      expect(await transferRes.text()).toContain('000000');

      // Receipt
      const receiptRes = await postEbics(
        app,
        buildEbicsReceiptRequest(HOST_ID, clientKeys, transactionId),
      );
      expect(await receiptRes.text()).toContain('000000');

      // Verify stored
      const orders = store.listUploadedOrders();
      expect(orders).toHaveLength(1);
      expect(orders[0].rawContent).toBe(testContent);
      expect(orders[0].serviceName).toBe('SCT');
      expect(orders[0].msgName).toBe('pain.001');
    });
  });

  describe('Multi-segment upload', () => {
    it('should handle multi-segment BTU upload', async () => {
      const bigContent = 'X'.repeat(50) + Array.from({ length: 500 }, (_, i) => `Line ${i}: ${Math.random().toString(36)}`).join('\n');
      const bankEncPubKey = getBankEncPubKey(store);
      const enc = encryptUploadContent(bigContent, bankEncPubKey, PARTNER_ID, USER_ID);

      const initRes = await postEbics(
        app,
        buildEbicsUploadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'SCT', 'pain.001', enc),
      );
      const initBody = await initRes.text();
      expect(initBody).toContain('000000');

      const initDoc = parseXml(initBody);
      const transactionId = xpathString('//ebics:TransactionID/text()', initDoc)!;

      for (let i = 0; i < enc.numSegments; i++) {
        const transferRes = await postEbics(
          app,
          buildEbicsUploadTransferRequest(HOST_ID, clientKeys, transactionId, i + 1, i === enc.numSegments - 1, enc.segments[i]),
        );
        expect(await transferRes.text()).toContain('000000');
      }

      const receiptRes = await postEbics(
        app,
        buildEbicsReceiptRequest(HOST_ID, clientKeys, transactionId),
      );
      expect(await receiptRes.text()).toContain('000000');

      const orders = store.listUploadedOrders();
      expect(orders).toHaveLength(1);
      expect(orders[0].rawContent).toBe(bigContent);
    });
  });

  describe('Admin API', () => {
    it('should list uploaded orders', async () => {
      const testContent = 'admin test content';
      const bankEncPubKey = getBankEncPubKey(store);
      const enc = encryptUploadContent(testContent, bankEncPubKey, PARTNER_ID, USER_ID);

      const initRes = await postEbics(app, buildEbicsUploadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'SCT', 'pain.001', enc));
      const initDoc = parseXml(await initRes.text());
      const txId = xpathString('//ebics:TransactionID/text()', initDoc)!;
      await postEbics(app, buildEbicsUploadTransferRequest(HOST_ID, clientKeys, txId, 1, true, enc.segments[0]));
      await postEbics(app, buildEbicsReceiptRequest(HOST_ID, clientKeys, txId));

      const res = await app.request('/api/uploaded-orders');
      const orders = await res.json();
      expect(orders).toHaveLength(1);
      expect(orders[0].rawContent).toBe(testContent);
    });
  });

  describe('Transaction lifecycle', () => {
    it('should clean up transaction after receipt', async () => {
      const bankEncPubKey = getBankEncPubKey(store);
      const enc = encryptUploadContent('cleanup test', bankEncPubKey, PARTNER_ID, USER_ID);

      const initRes = await postEbics(app, buildEbicsUploadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'SCT', 'pain.001', enc));
      const initDoc = parseXml(await initRes.text());
      const txId = xpathString('//ebics:TransactionID/text()', initDoc)!;

      await postEbics(app, buildEbicsUploadTransferRequest(HOST_ID, clientKeys, txId, 1, true, enc.segments[0]));
      await postEbics(app, buildEbicsReceiptRequest(HOST_ID, clientKeys, txId));

      expect(store.getTransaction(txId)).toBeUndefined();
    });

    it('should reject unknown transaction ID', async () => {
      const res = await postEbics(
        app,
        buildEbicsUploadTransferRequest(HOST_ID, clientKeys, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA0', 1, true, 'data'),
      );
      expect(await res.text()).toContain('091101');
    });
  });

  describe('pain.001 processing', () => {
    it('should create bookings from pain.001 upload', async () => {
      // Use auto-provisioned account as the debtor (Alice)
      const autoAccounts = store.listAccountsForPartner(PARTNER_ID);
      const aliceAcc = autoAccounts[0];
      const aliceIban = aliceAcc.iban;

      // Create a second person + account as the creditor (Bob)
      const bob = store.createPerson({ name: 'Bob', country: 'DE' });
      const bobAccNum = store.getNextAccountSequence().toString().padStart(10, '0');
      const bobIban = calculateIban('10020030', bobAccNum);
      const bobAcc = store.createAccount({ personId: bob.id, iban: bobIban, accountNumber: bobAccNum, currency: 'EUR', name: 'Bob Konto' });

      // Give Alice an initial balance
      store.createBooking({ accountId: aliceAcc.id, amountCents: 1000000, currency: 'EUR', valueDate: '2025-01-01', bookingDate: '2025-01-01', transactionCode: 'NTRF' });

      const pain001 = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>MSG001</MsgId>
      <CreDtTm>2025-06-01T10:00:00</CreDtTm>
      <NbOfTxs>1</NbOfTxs>
      <CtrlSum>500.00</CtrlSum>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>PMT001</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <NbOfTxs>1</NbOfTxs>
      <CtrlSum>500.00</CtrlSum>
      <DbtrAcct><Id><IBAN>${aliceIban}</IBAN></Id></DbtrAcct>
      <CdtTrfTxInf>
        <PmtId><EndToEndId>E2E-PAY-001</EndToEndId></PmtId>
        <Amt><InstdAmt Ccy="EUR">500.00</InstdAmt></Amt>
        <Cdtr><Nm>Bob</Nm></Cdtr>
        <CdtrAcct><Id><IBAN>${bobIban}</IBAN></Id></CdtrAcct>
        <RmtInf><Ustrd>Payment for services</Ustrd></RmtInf>
      </CdtTrfTxInf>
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>`;

      const bankEncPubKey = getBankEncPubKey(store);
      const enc = encryptUploadContent(pain001, bankEncPubKey, PARTNER_ID, USER_ID);

      const initRes = await postEbics(app, buildEbicsUploadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'SCT', 'pain.001', enc));
      const initDoc = parseXml(await initRes.text());
      const txId = xpathString('//ebics:TransactionID/text()', initDoc)!;

      await postEbics(app, buildEbicsUploadTransferRequest(HOST_ID, clientKeys, txId, 1, true, enc.segments[0]));
      const receiptRes = await postEbics(app, buildEbicsReceiptRequest(HOST_ID, clientKeys, txId));
      expect(await receiptRes.text()).toContain('000000');

      // Verify bookings
      const aliceAccUpdated = store.getAccount(aliceAcc.id)!;
      expect(aliceAccUpdated.currentBalanceCents).toBe(1000000 - 50000); // 10000 - 500

      const bobAccUpdated = store.getAccount(bobAcc.id)!;
      expect(bobAccUpdated.currentBalanceCents).toBe(50000); // +500
    });
  });
});
