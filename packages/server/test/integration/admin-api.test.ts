import { describe, it, expect, beforeEach } from 'vitest';
import { createTestApp, HOST_ID, PARTNER_ID, USER_ID } from '../helpers/test-server.js';
import { SubscriberState } from '../../src/store/types.js';

describe('Admin API', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: ReturnType<typeof createTestApp>['store'];

  beforeEach(() => {
    const test = createTestApp();
    app = test.app;
    store = test.store;
  });

  describe('GET /health', () => {
    it('should return ok', async () => {
      const res = await app.request('/health');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
    });
  });

  describe('POST /api/subscribers', () => {
    it('should create subscriber', async () => {
      const res = await app.request('/api/subscribers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partnerId: 'P1', userId: 'U1' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.partnerId).toBe('P1');
      expect(body.userId).toBe('U1');
      expect(body.state).toBe('NEW');
    });
  });

  describe('GET /api/subscribers', () => {
    it('should list all subscribers', async () => {
      store.createSubscriber('P1', 'U1');
      store.createSubscriber('P2', 'U2');
      const res = await app.request('/api/subscribers');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(2);
    });

    it('should return empty array when none', async () => {
      const res = await app.request('/api/subscribers');
      const body = await res.json();
      expect(body).toEqual([]);
    });
  });

  describe('GET /api/subscribers/:partnerId/:userId', () => {
    it('should return subscriber', async () => {
      store.createSubscriber('P1', 'U1');
      const res = await app.request('/api/subscribers/P1/U1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.partnerId).toBe('P1');
    });

    it('should return 404 for unknown', async () => {
      const res = await app.request('/api/subscribers/X/Y');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/subscribers/:partnerId/:userId/activate', () => {
    it('should activate INITIALIZED subscriber', async () => {
      store.createSubscriber('P1', 'U1');
      store.updateSubscriberState('P1', 'U1', SubscriberState.INITIALIZED);

      const res = await app.request('/api/subscribers/P1/U1/activate', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(store.getSubscriber('P1', 'U1')!.state).toBe(SubscriberState.READY);
    });

    it('should reject NEW subscriber', async () => {
      store.createSubscriber('P1', 'U1');
      const res = await app.request('/api/subscribers/P1/U1/activate', { method: 'POST' });
      expect(res.status).toBe(400);
    });

    it('should reject already READY subscriber', async () => {
      store.createSubscriber('P1', 'U1');
      store.updateSubscriberState('P1', 'U1', SubscriberState.READY);

      const res = await app.request('/api/subscribers/P1/U1/activate', { method: 'POST' });
      expect(res.status).toBe(400);
    });

    it('should return 404 for unknown subscriber', async () => {
      const res = await app.request('/api/subscribers/X/Y/activate', { method: 'POST' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/subscribers/:partnerId/:userId', () => {
    it('should delete subscriber', async () => {
      store.createSubscriber('P1', 'U1');
      const res = await app.request('/api/subscribers/P1/U1', { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(store.getSubscriber('P1', 'U1')).toBeUndefined();
    });
  });

  describe('GET /api/host', () => {
    it('should return the bank certificates with their public key digests (X002/E002 of bank letters)', async () => {
      const res = await app.request('/api/host');
      expect(res.status).toBe(200);
      const { bankKeys } = await res.json();
      expect(bankKeys.authenticationPublicKeyDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(bankKeys.encryptionPublicKeyDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(bankKeys.authenticationPublicKeyDigest).not.toBe(bankKeys.encryptionPublicKeyDigest);
    });
  });

  describe('POST /api/host', () => {
    it('should reconfigure host', async () => {
      const res = await app.request('/api/host', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostId: 'NEWHOST' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.hostId).toBe('NEWHOST');
    });
  });

  describe('POST /api/reset', () => {
    it('should reset all state', async () => {
      store.createSubscriber('P1', 'U1');
      const res = await app.request('/api/reset', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(store.listSubscribers()).toEqual([]);
    });
  });
});
