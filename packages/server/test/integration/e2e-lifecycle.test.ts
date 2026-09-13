import { describe, it, expect, beforeEach } from 'vitest';
import { privateDecrypt, createDecipheriv, constants } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { createTestApp, postEbics, HOST_ID, PARTNER_ID, USER_ID } from '../helpers/test-server.js';
import { generateTestClientKeys, buildIniRequest, buildHiaRequest, buildHpbRequest } from '../helpers/test-client.js';
import { parseXml, xpathString } from '../../src/protocol/xml-parser.js';
import { SubscriberState } from '../../src/store/types.js';

function decryptHpbResponse(responseXml: string, encPrivateKeyPem: string): string {
  const doc = parseXml(responseXml);

  const transactionKeyB64 = xpathString('//ebics:TransactionKey/text()', doc);
  const orderDataB64 = xpathString('//ebics:OrderData/text()', doc);

  if (!transactionKeyB64 || !orderDataB64) {
    throw new Error('Missing TransactionKey or OrderData in response');
  }

  // RSA unwrap the AES transaction key
  const wrappedKey = Buffer.from(transactionKeyB64, 'base64');
  const transactionKey = privateDecrypt(
    { key: encPrivateKeyPem, padding: constants.RSA_PKCS1_PADDING },
    wrappedKey,
  );

  // E002: AES-128-CBC with zero IV, the last byte of the ANSI X9.23 padding is its length
  const iv = Buffer.alloc(16, 0);
  const decipher = createDecipheriv('aes-128-cbc', transactionKey, iv);
  decipher.setAutoPadding(false);
  const encrypted = Buffer.from(orderDataB64, 'base64');
  const padded = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const decrypted = padded.subarray(0, padded.length - padded[padded.length - 1]!);

  // Inflate
  const xml = inflateSync(decrypted).toString('utf8');
  return xml;
}

describe('E2E Lifecycle', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: ReturnType<typeof createTestApp>['store'];
  let clientKeys: ReturnType<typeof generateTestClientKeys>;

  beforeEach(() => {
    const test = createTestApp();
    app = test.app;
    store = test.store;
    clientKeys = generateTestClientKeys();
    store.createSubscriber(PARTNER_ID, USER_ID);
  });

  it('should complete full lifecycle: INI → HIA → activate → HPB → decrypt', async () => {
    // INI
    const iniRes = await postEbics(app, buildIniRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));
    expect(await iniRes.text()).toContain('000000');

    // HIA
    const hiaRes = await postEbics(app, buildHiaRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));
    expect(await hiaRes.text()).toContain('000000');

    // Verify INITIALIZED
    expect(store.getSubscriber(PARTNER_ID, USER_ID)!.state).toBe(SubscriberState.INITIALIZED);

    // Activate
    await app.request(`/api/subscribers/${PARTNER_ID}/${USER_ID}/activate`, { method: 'POST' });
    expect(store.getSubscriber(PARTNER_ID, USER_ID)!.state).toBe(SubscriberState.READY);

    // HPB
    const hpbRes = await postEbics(app, buildHpbRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));
    const hpbBody = await hpbRes.text();
    expect(hpbBody).toContain('000000');

    // Decrypt bank keys
    const orderDataXml = decryptHpbResponse(hpbBody, clientKeys.encKeyPair.privateKey);
    expect(orderDataXml).toContain('HPBResponseOrderData');
    expect(orderDataXml).toContain('AuthenticationPubKeyInfo');
    expect(orderDataXml).toContain('EncryptionPubKeyInfo');
    expect(orderDataXml).toContain('X509Certificate');
  });

  it('should complete lifecycle with HIA before INI', async () => {
    await postEbics(app, buildHiaRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));
    await postEbics(app, buildIniRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));
    expect(store.getSubscriber(PARTNER_ID, USER_ID)!.state).toBe(SubscriberState.INITIALIZED);

    await app.request(`/api/subscribers/${PARTNER_ID}/${USER_ID}/activate`, { method: 'POST' });

    const hpbRes = await postEbics(app, buildHpbRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));
    expect(await hpbRes.text()).toContain('000000');
  });

  it('should handle two independent subscribers simultaneously', async () => {
    const keys2 = generateTestClientKeys();
    store.createSubscriber('P2', 'U2');

    // Both do INI
    await postEbics(app, buildIniRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));
    await postEbics(app, buildIniRequest(HOST_ID, 'P2', 'U2', keys2));

    // Both do HIA
    await postEbics(app, buildHiaRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));
    await postEbics(app, buildHiaRequest(HOST_ID, 'P2', 'U2', keys2));

    expect(store.getSubscriber(PARTNER_ID, USER_ID)!.state).toBe(SubscriberState.INITIALIZED);
    expect(store.getSubscriber('P2', 'U2')!.state).toBe(SubscriberState.INITIALIZED);
  });

  it('should allow multiple HPB calls after activation', async () => {
    await postEbics(app, buildIniRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));
    await postEbics(app, buildHiaRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));
    await app.request(`/api/subscribers/${PARTNER_ID}/${USER_ID}/activate`, { method: 'POST' });

    // First HPB
    const res1 = await postEbics(app, buildHpbRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));
    expect(await res1.text()).toContain('000000');

    // Second HPB — still works
    const res2 = await postEbics(app, buildHpbRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));
    expect(await res2.text()).toContain('000000');

    // State remains READY
    expect(store.getSubscriber(PARTNER_ID, USER_ID)!.state).toBe(SubscriberState.READY);
  });

  it('should require re-creation after reset', async () => {
    await postEbics(app, buildIniRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));
    await app.request('/api/reset', { method: 'POST' });

    // INI fails — subscriber gone
    const res = await postEbics(app, buildIniRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));
    const body = await res.text();
    expect(body).toContain('091003'); // USER_UNKNOWN
  });
});
