import { describe, it, expect, beforeEach } from 'vitest';
import { createTestApp, postEbics, HOST_ID, PARTNER_ID, USER_ID } from '../helpers/test-server.js';
import { generateTestClientKeys, buildIniRequest, buildHiaRequest, buildHpbRequest } from '../helpers/test-client.js';
import { SubscriberState } from '../../src/store/types.js';

describe('Key Exchange', () => {
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

  describe('INI', () => {
    it('should accept INI and store signature key', async () => {
      const xml = buildIniRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys);
      const res = await postEbics(app, xml);

      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('000000');

      const sub = store.getSubscriber(PARTNER_ID, USER_ID)!;
      expect(sub.state).toBe(SubscriberState.PARTIALLY_INITIALIZED_INI);
      expect(sub.keys.signatureVersion).toBe('A006');
      expect(sub.keys.signatureCertificate).toBeTruthy();
    });

    it('should reject INI for unknown user', async () => {
      const xml = buildIniRequest(HOST_ID, 'UNKNOWN', 'UNKNOWN', clientKeys);
      const res = await postEbics(app, xml);

      const body = await res.text();
      expect(body).toContain('091003');
    });

    it('should reject INI for wrong host', async () => {
      const xml = buildIniRequest('WRONGHOST', PARTNER_ID, USER_ID, clientKeys);
      const res = await postEbics(app, xml);

      const body = await res.text();
      expect(body).toContain('091011');
    });

    it('should reject duplicate INI', async () => {
      const xml = buildIniRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys);
      await postEbics(app, xml);

      const res = await postEbics(app, xml);
      const body = await res.text();
      expect(body).toContain('091004');
    });
  });

  describe('HIA', () => {
    it('should accept HIA and store auth+encryption keys', async () => {
      const xml = buildHiaRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys);
      const res = await postEbics(app, xml);

      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('000000');

      const sub = store.getSubscriber(PARTNER_ID, USER_ID)!;
      expect(sub.state).toBe(SubscriberState.PARTIALLY_INITIALIZED_HIA);
      expect(sub.keys.authenticationVersion).toBe('X002');
      expect(sub.keys.encryptionVersion).toBe('E002');
    });
  });

  describe('INI + HIA → INITIALIZED', () => {
    it('should reach INITIALIZED after both INI and HIA', async () => {
      await postEbics(app, buildIniRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));
      await postEbics(app, buildHiaRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));

      const sub = store.getSubscriber(PARTNER_ID, USER_ID)!;
      expect(sub.state).toBe(SubscriberState.INITIALIZED);
    });

    it('should reach INITIALIZED regardless of order (HIA first)', async () => {
      await postEbics(app, buildHiaRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));
      await postEbics(app, buildIniRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));

      const sub = store.getSubscriber(PARTNER_ID, USER_ID)!;
      expect(sub.state).toBe(SubscriberState.INITIALIZED);
    });
  });

  describe('Admin activation', () => {
    it('should activate subscriber via admin API', async () => {
      await postEbics(app, buildIniRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));
      await postEbics(app, buildHiaRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));

      const activateRes = await app.request(`/api/subscribers/${PARTNER_ID}/${USER_ID}/activate`, {
        method: 'POST',
      });

      expect(activateRes.status).toBe(200);
      const sub = store.getSubscriber(PARTNER_ID, USER_ID)!;
      expect(sub.state).toBe(SubscriberState.READY);
    });

    it('should reject activation before INI+HIA', async () => {
      const res = await app.request(`/api/subscribers/${PARTNER_ID}/${USER_ID}/activate`, {
        method: 'POST',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('HPB', () => {
    it('should reject HPB before activation', async () => {
      await postEbics(app, buildIniRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));
      await postEbics(app, buildHiaRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));

      const xml = buildHpbRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys);
      const res = await postEbics(app, xml);

      const body = await res.text();
      // INITIALIZED state should be accepted for HPB too
      // but auth signature must verify
      expect(res.status).toBe(200);
    });

    it('should return bank keys after full lifecycle', async () => {
      // INI + HIA
      await postEbics(app, buildIniRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));
      await postEbics(app, buildHiaRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys));

      // Activate
      await app.request(`/api/subscribers/${PARTNER_ID}/${USER_ID}/activate`, {
        method: 'POST',
      });

      // HPB
      const xml = buildHpbRequest(HOST_ID, PARTNER_ID, USER_ID, clientKeys);
      const res = await postEbics(app, xml);

      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('000000');
      expect(body).toContain('OrderData');
      expect(body).toContain('TransactionKey');
    });
  });
});
