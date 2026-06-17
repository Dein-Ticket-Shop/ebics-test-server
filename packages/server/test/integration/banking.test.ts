import { describe, it, expect, beforeEach } from 'vitest';
import { createTestApp, postEbics, HOST_ID, PARTNER_ID, USER_ID } from '../helpers/test-server.js';
import {
  generateTestClientKeys,
  buildIniRequest,
  buildHiaRequest,
  buildHpbRequest,
  buildEbicsDownloadInitRequest,
  buildEbicsReceiptRequest,
  decryptDownloadResponse,
  type BankCerts,
  type TestClientKeys,
} from '../helpers/test-client.js';
import { privateDecrypt, createDecipheriv, constants } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { parseXml, xpathString } from '../../src/protocol/xml-parser.js';
import { calculateIban, validateIban } from '../../src/banking/iban.js';
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
  const hpbDoc = parseXml(hpbBody);
  const txKeyB64 = xpathString('//ebics:TransactionKey/text()', hpbDoc)!;
  const orderDataB64 = xpathString('//ebics:OrderData/text()', hpbDoc)!;
  const txKey = privateDecrypt(
    { key: clientKeys.encKeyPair.privateKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(txKeyB64, 'base64'),
  );
  const iv = Buffer.alloc(16, 0);
  const decipher = createDecipheriv('aes-128-cbc', txKey, iv);
  Buffer.concat([decipher.update(Buffer.from(orderDataB64, 'base64')), decipher.final()]);
  const hostConfig = store.getHostConfig()!;
  return {
    authCertPem: hostConfig.bankKeys.authenticationCertificate,
    encCertPem: hostConfig.bankKeys.encryptionCertificate,
  };
}

describe('Banking', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: ReturnType<typeof createTestApp>['store'];

  beforeEach(() => {
    const test = createTestApp();
    app = test.app;
    store = test.store;
  });

  describe('IBAN', () => {
    it('should generate valid German IBAN', () => {
      const iban = calculateIban('10020030', '0000000001');
      expect(iban).toMatch(/^DE\d{20}$/);
      expect(validateIban(iban)).toBe(true);
    });

    it('should validate known IBAN', () => {
      expect(validateIban('DE89370400440532013000')).toBe(true);
      expect(validateIban('DE00370400440532013000')).toBe(false);
    });
  });

  describe('Admin API', () => {
    it('should create bank config', async () => {
      const res = await app.request('/api/banking/bank', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blz: '10020030', name: 'Test Bank', bic: 'TESTDEFFXXX' }),
      });
      expect(res.status).toBe(200);

      const getRes = await app.request('/api/banking/bank');
      const config = await getRes.json();
      expect(config.blz).toBe('10020030');
    });

    it('should create person and account with auto-IBAN', async () => {
      await app.request('/api/banking/bank', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blz: '10020030', name: 'Test Bank', bic: 'TESTDEFFXXX' }),
      });

      const personRes = await app.request('/api/banking/persons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Person', externalId: 'test' }),
      });
      expect(personRes.status).toBe(201);
      const person = await personRes.json();

      const accRes = await app.request('/api/banking/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personId: person.id, name: 'Girokonto' }),
      });
      expect(accRes.status).toBe(201);
      const account = await accRes.json();
      expect(account.iban).toMatch(/^DE\d{20}$/);
      expect(validateIban(account.iban)).toBe(true);
      expect(account.currentBalanceCents).toBe(0);
    });

    it('should create booking and update balance', async () => {
      store.setBankConfig({ blz: '10020030', name: 'Test Bank', bic: 'TESTDEFFXXX' });
      const person = store.createPerson({ name: 'Test', country: 'DE' });
      const iban = calculateIban('10020030', '0000000001');
      const account = store.createAccount({
        personId: person.id, iban, accountNumber: '0000000001',
        currency: 'EUR', name: 'Test Account',
      });

      const bookingRes = await app.request(`/api/banking/accounts/${account.id}/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amountCents: 100000,
          valueDate: '2025-01-15',
          counterpartyName: 'Sender',
          counterpartyIban: 'DE89370400440532013000',
          remittanceInfo: 'Payment 001',
        }),
      });
      expect(bookingRes.status).toBe(201);

      const updatedAcc = store.getAccount(account.id)!;
      expect(updatedAcc.currentBalanceCents).toBe(100000);
    });

    it('should grant and list partner account access', async () => {
      store.setBankConfig({ blz: '10020030', name: 'Test Bank', bic: 'TESTDEFFXXX' });
      const person = store.createPerson({ name: 'Test', country: 'DE' });
      const iban = calculateIban('10020030', '0000000001');
      const account = store.createAccount({
        personId: person.id, iban, accountNumber: '0000000001',
        currency: 'EUR', name: 'Test Account',
      });

      await app.request(`/api/banking/partners/PARTNER1/accounts/${account.id}`, { method: 'POST' });

      const listRes = await app.request('/api/banking/partners/PARTNER1/accounts');
      const accounts = await listRes.json();
      expect(accounts).toHaveLength(1);
      expect(accounts[0].iban).toBe(iban);
    });

    it('should seed demo data', async () => {
      const res = await app.request('/api/banking/seed/demo', { method: 'POST' });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.persons).toHaveLength(2);
      expect(data.accounts).toHaveLength(2);
      expect(data.bookingCount).toBeGreaterThan(0);

      for (const acc of data.accounts) {
        expect(validateIban(acc.iban)).toBe(true);
      }
    });

    it('should preview statement in camt.053', async () => {
      store.setBankConfig({ blz: '10020030', name: 'Test Bank', bic: 'TESTDEFFXXX' });
      const person = store.createPerson({ name: 'Alice', country: 'DE' });
      const iban = calculateIban('10020030', '0000000001');
      const account = store.createAccount({
        personId: person.id, iban, accountNumber: '0000000001',
        currency: 'EUR', name: 'Girokonto',
      });
      store.createBooking({
        accountId: account.id, amountCents: 50000, currency: 'EUR',
        valueDate: '2025-06-01', bookingDate: '2025-06-01',
        counterpartyName: 'Sender', transactionCode: 'NTRF',
      });

      const res = await app.request(
        `/api/banking/accounts/${account.id}/statement?format=camt.053&from=2025-06-01&to=2025-06-30`,
      );
      expect(res.status).toBe(200);
      const xml = await res.text();
      expect(xml).toContain('BkToCstmrStmt');
      expect(xml).toContain(iban);
      expect(xml).toContain('Alice');
      expect(xml).toContain('500.00');
    });

    it('should preview statement in MT940', async () => {
      store.setBankConfig({ blz: '10020030', name: 'Test Bank', bic: 'TESTDEFFXXX' });
      const person = store.createPerson({ name: 'Alice', country: 'DE' });
      const iban = calculateIban('10020030', '0000000001');
      const account = store.createAccount({
        personId: person.id, iban, accountNumber: '0000000001',
        currency: 'EUR', name: 'Girokonto',
      });
      store.createBooking({
        accountId: account.id, amountCents: -15099, currency: 'EUR',
        valueDate: '2025-06-15', bookingDate: '2025-06-15',
        counterpartyName: 'Recipient', remittanceInfo: 'Invoice 42',
        transactionCode: 'NTRF',
      });

      const res = await app.request(
        `/api/banking/accounts/${account.id}/statement?format=mt940&from=2025-06-01&to=2025-06-30`,
      );
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain(':20:');
      expect(text).toContain(`:25:${iban}`);
      expect(text).toContain(':60F:');
      expect(text).toContain(':62F:');
      expect(text).toContain('150,99');
    });
  });

  describe('BTD dynamic statements', () => {
    let clientKeys: TestClientKeys;
    let bankCerts: BankCerts;

    beforeEach(async () => {
      clientKeys = generateTestClientKeys();
      bankCerts = await setupReadySubscriber(app, store, clientKeys);

      // Use the auto-provisioned account created during subscriber activation
      const accounts = store.listAccountsForPartner(PARTNER_ID);
      const account = accounts[0];
      store.createBooking({
        accountId: account.id, amountCents: 250000, currency: 'EUR',
        valueDate: new Date().toISOString().slice(0, 10),
        bookingDate: new Date().toISOString().slice(0, 10),
        counterpartyName: 'Customer AG', counterpartyIban: 'DE89370400440532013000',
        remittanceInfo: 'Invoice payment', endToEndId: 'E2E-TEST-001',
        transactionCode: 'NTRF',
      });
    });

    it('should download camt.053 via BTD', async () => {
      const initRes = await postEbics(
        app,
        buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'BTD', {
          serviceName: 'STA',
          msgName: 'camt.053',
        }),
      );
      const initBody = await initRes.text();
      expect(initBody).toContain('000000');

      const { orderData, transactionId } = decryptDownloadResponse(initBody, clientKeys.encKeyPair.privateKey);
      const autoAccount = store.listAccountsForPartner(PARTNER_ID)[0];
      expect(orderData).toContain('BkToCstmrStmt');
      expect(orderData).toContain(autoAccount.iban);
      expect(orderData).toContain('2500.00');
      expect(orderData).toContain('Customer AG');

      await postEbics(app, buildEbicsReceiptRequest(HOST_ID, clientKeys, transactionId));
    });

    it('should download MT940 via BTD', async () => {
      const initRes = await postEbics(
        app,
        buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'BTD', {
          serviceName: 'STA',
          msgName: 'mt940',
        }),
      );
      const initBody = await initRes.text();
      expect(initBody).toContain('000000');

      const { orderData, transactionId } = decryptDownloadResponse(initBody, clientKeys.encKeyPair.privateKey);
      expect(orderData).toContain(':20:');
      expect(orderData).toContain(':60F:');
      expect(orderData).toContain('2500,00');

      await postEbics(app, buildEbicsReceiptRequest(HOST_ID, clientKeys, transactionId));
    });

    it('should fall back to static data when no accounts linked', async () => {
      const autoAccounts = store.listAccountsForPartner(PARTNER_ID);
      for (const acc of autoAccounts) {
        store.revokeAccountAccess(PARTNER_ID, acc.id);
      }
      store.upsertDownloadData('STA', 'mt940', 'static fallback content', 'text');

      const initRes = await postEbics(
        app,
        buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'BTD', {
          serviceName: 'STA',
          msgName: 'mt940',
        }),
      );
      const initBody = await initRes.text();
      expect(initBody).toContain('000000');

      const { orderData } = decryptDownloadResponse(initBody, clientKeys.encKeyPair.privateKey);
      expect(orderData).toBe('static fallback content');
    });
  });
});
