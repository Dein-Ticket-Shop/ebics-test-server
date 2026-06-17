import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteStore } from '../../src/store/sqlite-store.js';
import { SubscriberState } from '../../src/store/types.js';

describe('SqliteStore', () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore(':memory:');
  });

  describe('host config', () => {
    it('should return undefined before setup', () => {
      expect(store.getHostConfig()).toBeUndefined();
    });

    it('should store and retrieve config', () => {
      store.setHostConfig({
        hostId: 'BANK1',
        bankKeys: {
          authenticationPrivateKey: 'auth-priv',
          authenticationCertificate: 'auth-cert',
          authenticationVersion: 'X002',
          encryptionPrivateKey: 'enc-priv',
          encryptionCertificate: 'enc-cert',
          encryptionVersion: 'E002',
        },
      });

      const config = store.getHostConfig()!;
      expect(config.hostId).toBe('BANK1');
      expect(config.bankKeys.authenticationVersion).toBe('X002');
      expect(config.bankKeys.encryptionVersion).toBe('E002');
    });

    it('should overwrite existing config', () => {
      store.setHostConfig({ hostId: 'A', bankKeys: { authenticationPrivateKey: '1', authenticationCertificate: '1', authenticationVersion: 'X002', encryptionPrivateKey: '1', encryptionCertificate: '1', encryptionVersion: 'E002' } });
      store.setHostConfig({ hostId: 'B', bankKeys: { authenticationPrivateKey: '2', authenticationCertificate: '2', authenticationVersion: 'X002', encryptionPrivateKey: '2', encryptionCertificate: '2', encryptionVersion: 'E002' } });

      expect(store.getHostConfig()!.hostId).toBe('B');
    });
  });

  describe('subscribers', () => {
    it('should create subscriber with NEW state', () => {
      const sub = store.createSubscriber('P1', 'U1');
      expect(sub.partnerId).toBe('P1');
      expect(sub.userId).toBe('U1');
      expect(sub.state).toBe(SubscriberState.NEW);
    });

    it('should throw on duplicate subscriber', () => {
      store.createSubscriber('P1', 'U1');
      expect(() => store.createSubscriber('P1', 'U1')).toThrow();
    });

    it('should return undefined for non-existent subscriber', () => {
      expect(store.getSubscriber('X', 'Y')).toBeUndefined();
    });

    it('should list all subscribers', () => {
      store.createSubscriber('P1', 'U1');
      store.createSubscriber('P1', 'U2');
      store.createSubscriber('P2', 'U1');
      expect(store.listSubscribers()).toHaveLength(3);
    });

    it('should return empty array when none exist', () => {
      expect(store.listSubscribers()).toEqual([]);
    });

    it('should update state', () => {
      store.createSubscriber('P1', 'U1');
      store.updateSubscriberState('P1', 'U1', SubscriberState.INITIALIZED);
      expect(store.getSubscriber('P1', 'U1')!.state).toBe(SubscriberState.INITIALIZED);
    });

    it('should update signature keys', () => {
      store.createSubscriber('P1', 'U1');
      store.updateSubscriberKeys('P1', 'U1', {
        signatureVersion: 'A006',
        signatureCertificate: 'cert-data',
      });

      const sub = store.getSubscriber('P1', 'U1')!;
      expect(sub.keys.signatureVersion).toBe('A006');
      expect(sub.keys.signatureCertificate).toBe('cert-data');
    });

    it('should update auth+enc keys', () => {
      store.createSubscriber('P1', 'U1');
      store.updateSubscriberKeys('P1', 'U1', {
        authenticationVersion: 'X002',
        authenticationCertificate: 'auth-cert',
        encryptionVersion: 'E002',
        encryptionCertificate: 'enc-cert',
      });

      const sub = store.getSubscriber('P1', 'U1')!;
      expect(sub.keys.authenticationVersion).toBe('X002');
      expect(sub.keys.encryptionVersion).toBe('E002');
    });

    it('should not clear other fields on partial update', () => {
      store.createSubscriber('P1', 'U1');
      store.updateSubscriberKeys('P1', 'U1', { signatureVersion: 'A006', signatureCertificate: 'sig' });
      store.updateSubscriberKeys('P1', 'U1', { authenticationVersion: 'X002', authenticationCertificate: 'auth' });

      const sub = store.getSubscriber('P1', 'U1')!;
      expect(sub.keys.signatureVersion).toBe('A006');
      expect(sub.keys.authenticationVersion).toBe('X002');
    });

    it('should delete subscriber', () => {
      store.createSubscriber('P1', 'U1');
      store.deleteSubscriber('P1', 'U1');
      expect(store.getSubscriber('P1', 'U1')).toBeUndefined();
    });

    it('should not throw on deleting non-existent', () => {
      expect(() => store.deleteSubscriber('X', 'Y')).not.toThrow();
    });
  });

  describe('nonces', () => {
    it('should store and find nonce', () => {
      store.storeNonce('abc123', '2026-01-01T00:00:00Z');
      expect(store.hasNonce('abc123')).toBe(true);
    });

    it('should return false for unknown nonce', () => {
      expect(store.hasNonce('unknown')).toBe(false);
    });

    it('should handle duplicate nonce (no-op)', () => {
      store.storeNonce('abc', '2026-01-01T00:00:00Z');
      expect(() => store.storeNonce('abc', '2026-01-01T00:00:00Z')).not.toThrow();
    });
  });

  describe('reset', () => {
    it('should clear all tables', () => {
      store.setHostConfig({ hostId: 'X', bankKeys: { authenticationPrivateKey: '1', authenticationCertificate: '1', authenticationVersion: 'X002', encryptionPrivateKey: '1', encryptionCertificate: '1', encryptionVersion: 'E002' } });
      store.createSubscriber('P1', 'U1');
      store.storeNonce('n1', '2026-01-01T00:00:00Z');
      store.logActivity({ eventType: 'test', partnerId: 'P1', userId: 'U1' });
      store.upsertDownloadData('STA', 'mt940', 'data', 'text');
      store.createTransaction({
        transactionId: 'TX1', partnerId: 'P1', userId: 'U1', hostId: 'H',
        direction: 'download' as const,
        phase: 'Initialisation', orderType: 'HPD', numSegments: 1, currentSegment: 1,
        segments: ['s1'], transactionKey: 'k', encKeyDigest: 'd',
      });

      store.reset();

      expect(store.getHostConfig()).toBeUndefined();
      expect(store.listSubscribers()).toEqual([]);
      expect(store.hasNonce('n1')).toBe(false);
      expect(store.getActivityLog()).toEqual([]);
      expect(store.listDownloadData()).toEqual([]);
      expect(store.getTransaction('TX1')).toBeUndefined();
    });
  });

  describe('activity log', () => {
    it('should log and retrieve activity', () => {
      store.logActivity({
        eventType: 'ebics_request',
        partnerId: 'P1',
        userId: 'U1',
        orderType: 'HPB',
        resultCode: '000000',
      });

      const log = store.getActivityLog();
      expect(log).toHaveLength(1);
      expect(log[0].eventType).toBe('ebics_request');
      expect(log[0].orderType).toBe('HPB');
      expect(log[0].resultCode).toBe('000000');
    });

    it('should return entries in reverse chronological order', () => {
      store.logActivity({ eventType: 'first', partnerId: 'P1', userId: 'U1' });
      store.logActivity({ eventType: 'second', partnerId: 'P1', userId: 'U1' });

      const log = store.getActivityLog();
      expect(log[0].eventType).toBe('second');
      expect(log[1].eventType).toBe('first');
    });

    it('should respect limit and offset', () => {
      for (let i = 0; i < 10; i++) {
        store.logActivity({ eventType: `event_${i}`, partnerId: 'P1', userId: 'U1' });
      }

      const page1 = store.getActivityLog(3, 0);
      expect(page1).toHaveLength(3);

      const page2 = store.getActivityLog(3, 3);
      expect(page2).toHaveLength(3);
      expect(page2[0].id).not.toBe(page1[0].id);
    });

    it('should return empty array when no entries', () => {
      expect(store.getActivityLog()).toEqual([]);
    });
  });

  describe('transactions', () => {
    const baseTx = {
      transactionId: 'TX001',
      partnerId: 'P1',
      userId: 'U1',
      hostId: 'HOST1',
      direction: 'download' as const,
      phase: 'Initialisation' as const,
      orderType: 'HPD',
      numSegments: 3,
      currentSegment: 1,
      segments: ['seg1data', 'seg2data', 'seg3data'],
      transactionKey: 'wrappedKeyBase64',
      encKeyDigest: 'digestBase64',
    };

    it('should create and retrieve transaction', () => {
      const tx = store.createTransaction(baseTx);
      expect(tx.transactionId).toBe('TX001');
      expect(tx.createdAt).toBeTruthy();
      expect(tx.expiresAt).toBeTruthy();

      const retrieved = store.getTransaction('TX001')!;
      expect(retrieved.partnerId).toBe('P1');
      expect(retrieved.numSegments).toBe(3);
      expect(retrieved.segments).toEqual(['seg1data', 'seg2data', 'seg3data']);
    });

    it('should return undefined for unknown transaction', () => {
      expect(store.getTransaction('NOPE')).toBeUndefined();
    });

    it('should update transaction phase', () => {
      store.createTransaction(baseTx);
      store.updateTransactionPhase('TX001', 'Transfer');
      expect(store.getTransaction('TX001')!.phase).toBe('Transfer');
    });

    it('should update current segment', () => {
      store.createTransaction(baseTx);
      store.updateTransactionSegment('TX001', 2);
      expect(store.getTransaction('TX001')!.currentSegment).toBe(2);
    });

    it('should delete transaction', () => {
      store.createTransaction(baseTx);
      store.deleteTransaction('TX001');
      expect(store.getTransaction('TX001')).toBeUndefined();
    });

    it('should not throw when deleting non-existent transaction', () => {
      expect(() => store.deleteTransaction('NOPE')).not.toThrow();
    });

    it('should set expiry in the future', () => {
      const tx = store.createTransaction(baseTx);
      const expiresAt = new Date(tx.expiresAt.replace(' ', 'T') + 'Z');
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('download data', () => {
    it('should upsert and retrieve download data', () => {
      store.upsertDownloadData('STA', 'mt940', 'content here', 'text');
      const data = store.getDownloadData('STA', 'mt940')!;
      expect(data.serviceName).toBe('STA');
      expect(data.msgName).toBe('mt940');
      expect(data.content).toBe('content here');
      expect(data.contentType).toBe('text');
    });

    it('should upsert without msgName', () => {
      store.upsertDownloadData('HPD', undefined, 'hpd content', 'xml');
      const data = store.getDownloadData('HPD')!;
      expect(data.serviceName).toBe('HPD');
      expect(data.msgName).toBeUndefined();
      expect(data.content).toBe('hpd content');
    });

    it('should overwrite on upsert', () => {
      store.upsertDownloadData('STA', 'mt940', 'old', 'text');
      store.upsertDownloadData('STA', 'mt940', 'new', 'text');
      expect(store.getDownloadData('STA', 'mt940')!.content).toBe('new');
    });

    it('should return undefined for unknown data', () => {
      expect(store.getDownloadData('ZZZ', 'zzz')).toBeUndefined();
    });

    it('should list all download data', () => {
      store.upsertDownloadData('STA', 'mt940', 'c1', 'text');
      store.upsertDownloadData('VMK', 'camt.052', 'c2', 'xml');
      const all = store.listDownloadData();
      expect(all).toHaveLength(2);
    });

    it('should return empty list when none exist', () => {
      expect(store.listDownloadData()).toEqual([]);
    });

    it('should distinguish entries with same serviceName but different msgName', () => {
      store.upsertDownloadData('STA', 'mt940', 'mt940 content', 'text');
      store.upsertDownloadData('STA', 'camt.053', 'camt content', 'xml');
      expect(store.getDownloadData('STA', 'mt940')!.content).toBe('mt940 content');
      expect(store.getDownloadData('STA', 'camt.053')!.content).toBe('camt content');
    });
  });
});
