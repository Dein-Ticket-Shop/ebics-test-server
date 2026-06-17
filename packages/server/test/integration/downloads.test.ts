import { describe, it, expect, beforeEach } from 'vitest';
import { privateDecrypt, createDecipheriv, constants, randomBytes } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { createTestApp, postEbics, HOST_ID, PARTNER_ID, USER_ID } from '../helpers/test-server.js';
import {
  generateTestClientKeys,
  buildIniRequest,
  buildHiaRequest,
  buildHpbRequest,
  buildEbicsDownloadInitRequest,
  buildEbicsTransferRequest,
  buildEbicsReceiptRequest,
  decryptDownloadResponse,
  type BankCerts,
  type TestClientKeys,
} from '../helpers/test-client.js';
import { parseXml, xpathString } from '../../src/protocol/xml-parser.js';
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
  decipher.setAutoPadding(false); // EBICS E002: zero-padded, no PKCS#7
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(orderDataB64, 'base64')),
    decipher.final(),
  ]);
  const hpbXml = inflateSync(decrypted).toString('utf8');
  const hpbOrderDoc = parseXml(hpbXml);

  const hostConfig = store.getHostConfig()!;

  return {
    authCertPem: hostConfig.bankKeys.authenticationCertificate,
    encCertPem: hostConfig.bankKeys.encryptionCertificate,
  };
}

describe('Downloads', () => {
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

  describe('HPD', () => {
    it('should download bank parameters', async () => {
      const initRes = await postEbics(
        app,
        buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'HPD'),
      );
      const initBody = await initRes.text();
      expect(initBody).toContain('000000');

      const { orderData, transactionId } = decryptDownloadResponse(initBody, clientKeys.encKeyPair.privateKey);
      expect(orderData).toContain('HPDResponseOrderData');
      expect(orderData).toContain('ProtocolParams');
      expect(orderData).toContain('H005');

      const receiptRes = await postEbics(
        app,
        buildEbicsReceiptRequest(HOST_ID, clientKeys, transactionId),
      );
      expect(await receiptRes.text()).toContain('000000');
    });
  });

  describe('HTD', () => {
    it('should download subscriber info', async () => {
      const initRes = await postEbics(
        app,
        buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'HTD'),
      );
      const initBody = await initRes.text();
      expect(initBody).toContain('000000');

      const { orderData, transactionId } = decryptDownloadResponse(initBody, clientKeys.encKeyPair.privateKey);
      expect(orderData).toContain('HTDResponseOrderData');
      expect(orderData).toContain(USER_ID);

      const receiptRes = await postEbics(
        app,
        buildEbicsReceiptRequest(HOST_ID, clientKeys, transactionId),
      );
      expect(await receiptRes.text()).toContain('000000');
    });
  });

  describe('HKD', () => {
    it('should download customer info with all subscribers', async () => {
      const initRes = await postEbics(
        app,
        buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'HKD'),
      );
      const initBody = await initRes.text();
      expect(initBody).toContain('000000');

      const { orderData, transactionId } = decryptDownloadResponse(initBody, clientKeys.encKeyPair.privateKey);
      expect(orderData).toContain('HKDResponseOrderData');
      expect(orderData).toContain(USER_ID);

      await postEbics(app, buildEbicsReceiptRequest(HOST_ID, clientKeys, transactionId));
    });
  });

  describe('HAA', () => {
    it('should list available order types from seeded data', async () => {
      store.upsertDownloadData('STA', 'mt940', 'test content', 'text');

      const initRes = await postEbics(
        app,
        buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'HAA'),
      );
      const initBody = await initRes.text();
      expect(initBody).toContain('000000');

      const { orderData, transactionId } = decryptDownloadResponse(initBody, clientKeys.encKeyPair.privateKey);
      expect(orderData).toContain('HAAResponseOrderData');
      expect(orderData).toContain('STA');

      await postEbics(app, buildEbicsReceiptRequest(HOST_ID, clientKeys, transactionId));
    });
  });

  describe('HAC', () => {
    it('should download activity log', async () => {
      const initRes = await postEbics(
        app,
        buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'HAC'),
      );
      const initBody = await initRes.text();
      expect(initBody).toContain('000000');

      const { orderData, transactionId } = decryptDownloadResponse(initBody, clientKeys.encKeyPair.privateKey);
      expect(orderData).toContain('HACResponseOrderData');

      await postEbics(app, buildEbicsReceiptRequest(HOST_ID, clientKeys, transactionId));
    });
  });

  describe('BTD', () => {
    it('should download seeded data via BTD', async () => {
      const testContent = 'MT940 statement data here';
      store.upsertDownloadData('STA', 'mt940', testContent, 'text');

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
      expect(orderData).toBe(testContent);

      const receiptRes = await postEbics(
        app,
        buildEbicsReceiptRequest(HOST_ID, clientKeys, transactionId),
      );
      expect(await receiptRes.text()).toContain('000000');
    });

    it('should return no data available for unknown service', async () => {
      const initRes = await postEbics(
        app,
        buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'BTD', {
          serviceName: 'ZZZ',
          msgName: 'zzz',
        }),
      );
      const initBody = await initRes.text();
      expect(initBody).toContain('090005');
    });
  });

  describe('Nonce replay', () => {
    it('should reject duplicate nonce', async () => {
      const req = buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'HPD');
      const res1 = await postEbics(app, req);
      expect(await res1.text()).toContain('000000');

      const res2 = await postEbics(app, req);
      expect(await res2.text()).toContain('091103');
    });
  });

  describe('Multi-segment download', () => {
    it('should handle multi-segment BTD download', async () => {
      const bigContent = randomBytes(1_200_000).toString('base64');
      store.upsertDownloadData('STA', 'mt940', bigContent, 'text');

      const initRes = await postEbics(
        app,
        buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'BTD', {
          serviceName: 'STA',
          msgName: 'mt940',
        }),
      );
      const initBody = await initRes.text();
      expect(initBody).toContain('000000');

      const initDoc = parseXml(initBody);
      const transactionId = xpathString('//ebics:TransactionID/text()', initDoc)!;
      const numSegmentsStr = xpathString('//ebics:NumSegments/text()', initDoc)!;
      const numSegments = parseInt(numSegmentsStr, 10);
      expect(numSegments).toBeGreaterThan(1);

      const transactionKeyB64 = xpathString('//ebics:TransactionKey/text()', initDoc)!;
      const firstOrderDataB64 = xpathString('//ebics:OrderData/text()', initDoc)!;

      const wrappedKey = Buffer.from(transactionKeyB64, 'base64');
      const transactionKey = privateDecrypt(
        { key: clientKeys.encKeyPair.privateKey, padding: constants.RSA_PKCS1_PADDING },
        wrappedKey,
      );

      const encryptedParts: Buffer[] = [Buffer.from(firstOrderDataB64, 'base64')];

      for (let seg = 2; seg <= numSegments; seg++) {
        const transferRes = await postEbics(
          app,
          buildEbicsTransferRequest(HOST_ID, clientKeys, transactionId, seg, seg === numSegments),
        );
        const transferBody = await transferRes.text();
        expect(transferBody).toContain('000000');

        const transferDoc = parseXml(transferBody);
        const segData = xpathString('//ebics:OrderData/text()', transferDoc)!;
        encryptedParts.push(Buffer.from(segData, 'base64'));
      }

      const iv = Buffer.alloc(16, 0);
      const decipher = createDecipheriv('aes-128-cbc', transactionKey, iv);
      decipher.setAutoPadding(false); // EBICS E002: zero-padded, no PKCS#7
      const fullEncrypted = Buffer.concat(encryptedParts);
      const decrypted = Buffer.concat([decipher.update(fullEncrypted), decipher.final()]);
      const result = inflateSync(decrypted).toString('utf8');
      expect(result).toBe(bigContent);

      const receiptRes = await postEbics(
        app,
        buildEbicsReceiptRequest(HOST_ID, clientKeys, transactionId),
      );
      expect(await receiptRes.text()).toContain('000000');
    });
  });

  describe('Transaction lifecycle', () => {
    it('should reject unknown transaction ID', async () => {
      const res = await postEbics(
        app,
        buildEbicsReceiptRequest(HOST_ID, clientKeys, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA0'),
      );
      expect(await res.text()).toContain('091101');
    });

    it('should handle receipt with failure code', async () => {
      const initRes = await postEbics(
        app,
        buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'HPD'),
      );
      const initBody = await initRes.text();
      const { transactionId } = decryptDownloadResponse(initBody, clientKeys.encKeyPair.privateKey);

      const receiptRes = await postEbics(
        app,
        buildEbicsReceiptRequest(HOST_ID, clientKeys, transactionId, 1),
      );
      const receiptBody = await receiptRes.text();
      expect(receiptBody).toContain('000000');

      expect(store.getTransaction(transactionId)).toBeUndefined();
    });
  });

  describe('Error handling', () => {
    it('should reject unsupported order type', async () => {
      const res = await postEbics(
        app,
        buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'ZZZ'),
      );
      expect(await res.text()).toContain('091006');
    });
  });

  describe('Auth and access errors', () => {
    it('should reject download with wrong host ID', async () => {
      const res = await postEbics(
        app,
        buildEbicsDownloadInitRequest('WRONGHOST', PARTNER_ID, USER_ID, clientKeys, bankCerts, 'HPD'),
      );
      expect(await res.text()).toContain('091011');
    });

    it('should reject download for unknown user', async () => {
      const res = await postEbics(
        app,
        buildEbicsDownloadInitRequest(HOST_ID, 'UNKNOWN', 'NOBODY', clientKeys, bankCerts, 'HPD'),
      );
      expect(await res.text()).toContain('091003');
    });

    it('should reject download for non-READY subscriber', async () => {
      store.createSubscriber('P2', 'U2');
      const res = await postEbics(
        app,
        buildEbicsDownloadInitRequest(HOST_ID, 'P2', 'U2', clientKeys, bankCerts, 'HPD'),
      );
      expect(await res.text()).toContain('091004');
    });
  });

  describe('Segment errors', () => {
    it('should reject out-of-range segment number', async () => {
      const bigContent = Buffer.alloc(1_200_000, 0x41).toString('base64');
      store.upsertDownloadData('STA', 'mt940', bigContent, 'text');

      const initRes = await postEbics(
        app,
        buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'BTD', {
          serviceName: 'STA',
          msgName: 'mt940',
        }),
      );
      const initBody = await initRes.text();
      const initDoc = parseXml(initBody);
      const transactionId = xpathString('//ebics:TransactionID/text()', initDoc)!;

      const transferRes = await postEbics(
        app,
        buildEbicsTransferRequest(HOST_ID, clientKeys, transactionId, 999, true),
      );
      expect(await transferRes.text()).toContain('091104');
    });
  });

  describe('Double receipt', () => {
    it('should reject receipt for already-completed transaction', async () => {
      const initRes = await postEbics(
        app,
        buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'HPD'),
      );
      const initBody = await initRes.text();
      const { transactionId } = decryptDownloadResponse(initBody, clientKeys.encKeyPair.privateKey);

      await postEbics(app, buildEbicsReceiptRequest(HOST_ID, clientKeys, transactionId));

      const res2 = await postEbics(
        app,
        buildEbicsReceiptRequest(HOST_ID, clientKeys, transactionId),
      );
      expect(await res2.text()).toContain('091101');
    });
  });

  describe('HPD content verification', () => {
    it('should contain protocol version and access info after decryption', async () => {
      const initRes = await postEbics(
        app,
        buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'HPD'),
      );
      const { orderData } = decryptDownloadResponse(await initRes.text(), clientKeys.encKeyPair.privateKey);
      expect(orderData).toContain('H005');
      expect(orderData).toContain('X002');
      expect(orderData).toContain('E002');
      expect(orderData).toContain('A006');
      expect(orderData).toContain(HOST_ID);
    });
  });

  describe('HTD content verification', () => {
    it('should contain subscriber user ID after decryption', async () => {
      const initRes = await postEbics(
        app,
        buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'HTD'),
      );
      const { orderData } = decryptDownloadResponse(await initRes.text(), clientKeys.encKeyPair.privateKey);
      expect(orderData).toContain(USER_ID);
      expect(orderData).toContain('HTDResponseOrderData');
    });
  });

  describe('HKD with multiple subscribers', () => {
    it('should list all partner subscribers after decryption', async () => {
      store.createSubscriber(PARTNER_ID, 'EXTRA_USER');

      const initRes = await postEbics(
        app,
        buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'HKD'),
      );
      const { orderData } = decryptDownloadResponse(await initRes.text(), clientKeys.encKeyPair.privateKey);
      expect(orderData).toContain(USER_ID);
      expect(orderData).toContain('EXTRA_USER');
    });
  });

  describe('HAA with no data', () => {
    it('should return valid but empty response', async () => {
      const initRes = await postEbics(
        app,
        buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'HAA'),
      );
      const initBody = await initRes.text();
      expect(initBody).toContain('000000');

      const { orderData } = decryptDownloadResponse(initBody, clientKeys.encKeyPair.privateKey);
      expect(orderData).toContain('HAAResponseOrderData');
    });
  });

  describe('HAC activity log', () => {
    it('should include prior request activity', async () => {
      await postEbics(
        app,
        buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'HPD'),
      );

      const initRes = await postEbics(
        app,
        buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'HAC'),
      );
      const { orderData } = decryptDownloadResponse(await initRes.text(), clientKeys.encKeyPair.privateKey);
      expect(orderData).toContain('HACResponseOrderData');
      expect(orderData).toContain('HPD');
    });
  });

  describe('BTD edge cases', () => {
    it('should return different data for different msg names under same service', async () => {
      store.upsertDownloadData('STA', 'mt940', 'MT940 content', 'text');
      store.upsertDownloadData('STA', 'camt.053', 'CAMT053 content', 'xml');

      const res1 = await postEbics(
        app,
        buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'BTD', {
          serviceName: 'STA',
          msgName: 'mt940',
        }),
      );
      const { orderData: data1 } = decryptDownloadResponse(await res1.text(), clientKeys.encKeyPair.privateKey);
      expect(data1).toBe('MT940 content');

      const res2 = await postEbics(
        app,
        buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'BTD', {
          serviceName: 'STA',
          msgName: 'camt.053',
        }),
      );
      const { orderData: data2 } = decryptDownloadResponse(await res2.text(), clientKeys.encKeyPair.privateKey);
      expect(data2).toBe('CAMT053 content');
    });
  });

  describe('Repeated download', () => {
    it('should allow same order type download after receipt', async () => {
      const init1 = await postEbics(
        app,
        buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'HPD'),
      );
      const { transactionId: txId1 } = decryptDownloadResponse(await init1.text(), clientKeys.encKeyPair.privateKey);
      await postEbics(app, buildEbicsReceiptRequest(HOST_ID, clientKeys, txId1));

      const init2 = await postEbics(
        app,
        buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'HPD'),
      );
      const body2 = await init2.text();
      expect(body2).toContain('000000');
      expect(body2).toContain('OrderData');
    });
  });
});
