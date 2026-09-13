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
  decipher.setAutoPadding(false); // E002 uses ANSI X9.23 padding, not PKCS#7
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

    it('should patch person fields', async () => {
      const person = store.createPerson({ name: 'Old Name', country: 'DE', externalId: 'p1' });

      const res = await app.request(`/api/banking/persons/${person.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Name', addressLine1: 'Hauptstr. 1', country: 'AT' }),
      });
      expect(res.status).toBe(200);
      const updated = await res.json();
      expect(updated.name).toBe('New Name');
      expect(updated.addressLine1).toBe('Hauptstr. 1');
      expect(updated.country).toBe('AT');
      // untouched field preserved
      expect(updated.externalId).toBe('p1');
      expect(store.getPerson(person.id)!.name).toBe('New Name');
    });

    it('should 404 when patching an unknown person', async () => {
      const res = await app.request('/api/banking/persons/9999', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'x' }),
      });
      expect(res.status).toBe(404);
    });

    it('should patch account name and currency but not IBAN', async () => {
      store.setBankConfig({ blz: '10020030', name: 'Test Bank', bic: 'TESTDEFFXXX' });
      const person = store.createPerson({ name: 'Test', country: 'DE' });
      const iban = calculateIban('10020030', '0000000001');
      const account = store.createAccount({
        personId: person.id, iban, accountNumber: '0000000001',
        currency: 'EUR', name: 'Old Account',
      });

      const res = await app.request(`/api/banking/accounts/${account.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Account', currency: 'CHF', iban: 'DE00000000000000000000' }),
      });
      expect(res.status).toBe(200);
      const updated = await res.json();
      expect(updated.name).toBe('New Account');
      expect(updated.currency).toBe('CHF');
      // IBAN is immutable — the bogus value in the body is ignored
      expect(updated.iban).toBe(iban);
    });

    it('should delete a booking and reverse its balance contribution', async () => {
      store.setBankConfig({ blz: '10020030', name: 'Test Bank', bic: 'TESTDEFFXXX' });
      const person = store.createPerson({ name: 'Test', country: 'DE' });
      const iban = calculateIban('10020030', '0000000001');
      const account = store.createAccount({
        personId: person.id, iban, accountNumber: '0000000001',
        currency: 'EUR', name: 'Test Account',
      });
      const credit = store.createBooking({
        accountId: account.id, amountCents: 100000, currency: 'EUR',
        valueDate: '2026-06-01', bookingDate: '2026-06-01', transactionCode: 'NTRF',
      });
      store.createBooking({
        accountId: account.id, amountCents: -30000, currency: 'EUR',
        valueDate: '2026-06-02', bookingDate: '2026-06-02', transactionCode: 'NTRF',
      });
      expect(store.getAccount(account.id)!.currentBalanceCents).toBe(70000);

      const res = await app.request(`/api/banking/accounts/${account.id}/bookings/${credit.id}`, { method: 'DELETE' });
      expect(res.status).toBe(200);

      // 100000 credit removed → balance drops to -30000
      expect(store.getAccount(account.id)!.currentBalanceCents).toBe(-30000);
      expect(store.listBookingsForAccount(account.id)).toHaveLength(1);
    });

    it('should delete an account along with its bookings and partner access', async () => {
      store.setBankConfig({ blz: '10020030', name: 'Test Bank', bic: 'TESTDEFFXXX' });
      const person = store.createPerson({ name: 'Test', country: 'DE' });
      const iban = calculateIban('10020030', '0000000001');
      const account = store.createAccount({
        personId: person.id, iban, accountNumber: '0000000001',
        currency: 'EUR', name: 'Test Account',
      });
      store.createBooking({
        accountId: account.id, amountCents: 100000, currency: 'EUR',
        valueDate: '2025-06-01', bookingDate: '2025-06-01', transactionCode: 'NTRF',
      });
      store.grantAccountAccess('PARTNER1', account.id);

      const res = await app.request(`/api/banking/accounts/${account.id}`, { method: 'DELETE' });
      expect(res.status).toBe(200);

      expect(store.getAccount(account.id)).toBeUndefined();
      expect(store.listBookingsForAccount(account.id)).toHaveLength(0);
      expect(store.partnerHasAccountAccess('PARTNER1', account.id)).toBe(false);
      // person remains
      expect(store.getPerson(person.id)).toBeDefined();
    });

    it('should delete a person and cascade to their accounts and bookings', async () => {
      store.setBankConfig({ blz: '10020030', name: 'Test Bank', bic: 'TESTDEFFXXX' });
      const person = store.createPerson({ name: 'Test', country: 'DE' });
      const iban = calculateIban('10020030', '0000000001');
      const account = store.createAccount({
        personId: person.id, iban, accountNumber: '0000000001',
        currency: 'EUR', name: 'Test Account',
      });
      store.createBooking({
        accountId: account.id, amountCents: 100000, currency: 'EUR',
        valueDate: '2025-06-01', bookingDate: '2025-06-01', transactionCode: 'NTRF',
      });
      store.grantAccountAccess('PARTNER1', account.id);

      const res = await app.request(`/api/banking/persons/${person.id}`, { method: 'DELETE' });
      expect(res.status).toBe(200);

      expect(store.getPerson(person.id)).toBeUndefined();
      expect(store.getAccount(account.id)).toBeUndefined();
      expect(store.listBookingsForAccount(account.id)).toHaveLength(0);
      expect(store.partnerHasAccountAccess('PARTNER1', account.id)).toBe(false);
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

    it('should report every accessible account in one camt.053 document', async () => {
      // Add a second account for the partner with its own booking.
      const person = store.createPerson({ name: 'Second Holder', country: 'DE' });
      const second = store.createAccount({
        personId: person.id,
        iban: 'DE02100200300000000099',
        accountNumber: '99',
        currency: 'EUR',
        name: 'Second Account',
      });
      store.grantAccountAccess(PARTNER_ID, second.id);
      store.createBooking({
        accountId: second.id, amountCents: 100000, currency: 'EUR',
        valueDate: new Date().toISOString().slice(0, 10),
        bookingDate: new Date().toISOString().slice(0, 10),
        counterpartyName: 'Other GmbH', transactionCode: 'NTRF',
      });

      const firstIban = store.listAccountsForPartner(PARTNER_ID).find((a) => a.id !== second.id)!.iban;

      const initRes = await postEbics(
        app,
        buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'BTD', {
          serviceName: 'STA',
          msgName: 'camt.053',
        }),
      );
      const { orderData, transactionId } = decryptDownloadResponse(await initRes.text(), clientKeys.encKeyPair.privateKey);

      // One valid document, one BkToCstmrStmt, two <Stmt> — both IBANs present.
      expect(orderData.match(/<BkToCstmrStmt>/g)).toHaveLength(1);
      expect(orderData.match(/<Stmt>/g)).toHaveLength(2);
      expect(orderData).toContain(firstIban);
      expect(orderData).toContain(second.iban);

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
