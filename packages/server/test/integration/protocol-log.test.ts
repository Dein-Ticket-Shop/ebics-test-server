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
  const hostConfig = store.getHostConfig()!;
  return {
    authCertPem: hostConfig.bankKeys.authenticationCertificate,
    encCertPem: hostConfig.bankKeys.encryptionCertificate,
  };
}

describe('Protocol Log', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: ReturnType<typeof createTestApp>['store'];
  let clientKeys: TestClientKeys;

  beforeEach(() => {
    const test = createTestApp();
    app = test.app;
    store = test.store;
    clientKeys = generateTestClientKeys();
  });

  it('should log EBICS request/response exchanges', async () => {
    store.createSubscriber(PARTNER_ID, USER_ID);
    await postEbics(app, buildIniRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));

    const log = store.getProtocolLog();
    expect(log.length).toBeGreaterThanOrEqual(1);

    const entry = log[0];
    expect(entry.rootElement).toBe('ebicsUnsecuredRequest');
    expect(entry.orderType).toBe('INI');
    expect(entry.partnerId).toBe(PARTNER_ID);
    expect(entry.userId).toBe(USER_ID);
    expect(entry.returnCode).toBe('000000');
    expect(entry.requestXml).toContain('ebicsUnsecuredRequest');
    expect(entry.responseXml).toContain('ebicsKeyManagementResponse');
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should expose protocol log via admin API', async () => {
    store.createSubscriber(PARTNER_ID, USER_ID);
    await postEbics(app, buildIniRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));

    const listRes = await app.request('/api/protocol-log');
    const list = await listRes.json() as any[];
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0].orderType).toBe('INI');
    expect(list[0].requestXml).toBeUndefined();
    expect(list[0].requestSize).toBeGreaterThan(0);

    const detailRes = await app.request(`/api/protocol-log/${list[0].id}`);
    const detail = await detailRes.json() as any;
    expect(detail.requestXml).toContain('ebicsUnsecuredRequest');
    expect(detail.responseXml).toContain('000000');
  });

  it('should serve raw XML via dedicated endpoints', async () => {
    store.createSubscriber(PARTNER_ID, USER_ID);
    await postEbics(app, buildIniRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));

    const log = store.getProtocolLog();
    const id = log[0].id;

    const reqRes = await app.request(`/api/protocol-log/${id}/request`);
    expect(reqRes.headers.get('content-type')).toContain('application/xml');
    expect(await reqRes.text()).toContain('ebicsUnsecuredRequest');

    const respRes = await app.request(`/api/protocol-log/${id}/response`);
    expect(await respRes.text()).toContain('ebicsKeyManagementResponse');
  });

  it('should log download flow with transaction ID', async () => {
    const bankCerts = await setupReadySubscriber(app, store, clientKeys);

    await postEbics(
      app,
      buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys, bankCerts, 'HPD'),
    );

    const log = store.getProtocolLog();
    const hpdEntry = log.find((e) => e.orderType === 'HPD');
    expect(hpdEntry).toBeDefined();
    expect(hpdEntry!.transactionId).toBeTruthy();
    expect(hpdEntry!.transactionPhase).toBe('Initialisation');
    expect(hpdEntry!.returnCode).toBe('000000');
  });

  it('should log errors correctly', async () => {
    await postEbics(
      app,
      buildIniRequest('WRONGHOST', PARTNER_ID, USER_ID, clientKeys),
    );

    const log = store.getProtocolLog();
    expect(log[0].returnCode).toBe('091011');
  });
});
