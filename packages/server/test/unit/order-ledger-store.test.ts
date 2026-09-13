import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore, formatOrderId } from '../../src/store/sqlite-store.js';
import type { NewPaymentOrder } from '../../src/store/types.js';

function order(overrides: Partial<NewPaymentOrder> = {}): NewPaymentOrder {
  return {
    orderId: 'A000',
    partnerId: 'P1',
    userId: 'U1',
    serviceName: 'SCI',
    serviceOption: 'VOI',
    msgName: 'pain.001',
    msgId: 'MSG1',
    pmtInfId: 'PMT1',
    debtorName: 'Debtor',
    debtorIban: 'DE02120300000000202051',
    requestedEds: true,
    status: 'PENDING_EDS',
    ...overrides,
  };
}

describe('order ledger store', () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore(':memory:');
  });

  describe('order IDs', () => {
    it('allocates a sequence per partner', () => {
      expect(store.nextOrderId('P1')).toBe('A000');
      expect(store.nextOrderId('P1')).toBe('A001');
      expect(store.nextOrderId('P2')).toBe('A000');
      expect(store.nextOrderId('P1')).toBe('A002');
    });

    it('formats as OrderIDType [A-Z][A-Z0-9]{3} and wraps letters', () => {
      expect(formatOrderId(0)).toBe('A000');
      expect(formatOrderId(999)).toBe('A999');
      expect(formatOrderId(1000)).toBe('B000');
      expect(formatOrderId(25_999)).toBe('Z999');
      expect(formatOrderId(26_000)).toBe('A000');
      for (const n of [0, 42, 1234, 25_999]) {
        expect(formatOrderId(n)).toMatch(/^[A-Z][A-Z0-9]{3}$/);
      }
    });
  });

  describe('HAC events', () => {
    it('keeps eventAt strictly increasing per partner', () => {
      const at = '2026-09-12T10:00:00.000Z';
      const a = store.appendHacEvent({ partnerId: 'P1', orderId: 'A000', action: 'FILE_UPLOAD', adminOrderType: 'BTU', eventAt: at });
      const b = store.appendHacEvent({ partnerId: 'P1', orderId: 'A000', action: 'ES_VERIFICATION', adminOrderType: 'BTU', eventAt: at });
      const c = store.appendHacEvent({ partnerId: 'P2', orderId: 'A000', action: 'FILE_UPLOAD', adminOrderType: 'BTU', eventAt: at });
      expect(a.eventAt).toBe(at);
      expect(b.eventAt).toBe('2026-09-12T10:00:00.001Z');
      expect(c.eventAt).toBe(at);
    });

    it('stores all attributes and additional info', () => {
      const event = store.appendHacEvent({
        partnerId: 'P1',
        userId: 'U1',
        orderId: 'A001',
        action: 'VEU_CANCEL_ORDER',
        adminOrderType: 'HVS',
        serviceName: 'SCI',
        serviceOption: 'VOI',
        scope: 'DE',
        containerType: 'XML',
        msgName: 'pain.001',
        orderIdRef: 'A000',
        adminOrderTypeRef: 'BTU',
        reasonCode: 'DS02',
        additionalInfo: ['line 1', 'line 2'],
        uploadedOrderId: 7,
      });
      expect(store.getHacEvent(event.id)).toEqual(event);
      expect(event.additionalInfo).toEqual(['line 1', 'line 2']);
      expect(event.uploadedOrderId).toBe(7);
      expect(store.appendHacEvent({ partnerId: 'P1', orderId: 'A002', action: 'ADDITIONAL', adminOrderType: 'BTU' }).additionalInfo).toEqual([]);
    });

    it('filters by partner, order (including OrderIDRef) and day range', () => {
      store.appendHacEvent({ partnerId: 'P1', orderId: 'A000', action: 'FILE_UPLOAD', adminOrderType: 'BTU', eventAt: '2026-09-10T08:00:00.000Z' });
      store.appendHacEvent({ partnerId: 'P1', orderId: 'A001', orderIdRef: 'A000', action: 'VEU_CANCEL_ORDER', adminOrderType: 'HVS', eventAt: '2026-09-11T08:00:00.000Z' });
      store.appendHacEvent({ partnerId: 'P1', orderId: 'A002', action: 'FILE_UPLOAD', adminOrderType: 'BTU', eventAt: '2026-09-12T08:00:00.000Z' });
      store.appendHacEvent({ partnerId: 'P2', orderId: 'A000', action: 'FILE_UPLOAD', adminOrderType: 'BTU', eventAt: '2026-09-11T09:00:00.000Z' });

      expect(store.listHacEvents()).toHaveLength(4);
      expect(store.listHacEvents({ partnerId: 'P1' })).toHaveLength(3);
      expect(store.listHacEvents({ partnerId: 'P1', orderId: 'A000' }).map((e) => e.orderId)).toEqual(['A000', 'A001']);
      expect(store.listHacEvents({ partnerId: 'P1', from: '2026-09-11' }).map((e) => e.orderId)).toEqual(['A001', 'A002']);
      expect(store.listHacEvents({ from: '2026-09-11', to: '2026-09-11' }).map((e) => e.partnerId)).toEqual(['P1', 'P2']);
    });
  });

  describe('payment orders', () => {
    it('creates an order with transactions and updates it', () => {
      const created = store.createPaymentOrder(order(), [
        { endToEndId: 'E1', creditorName: 'Bob', creditorIban: 'DE1', amountCents: 1234, currency: 'EUR', remittanceInfo: 'R1', vopStatus: 'RCVC' },
        { endToEndId: 'E2', amountCents: 1, currency: 'EUR', vopStatus: 'RVMC', vopCorrectedName: 'Robert' },
      ]);
      expect(created).toMatchObject({ orderId: 'A000', status: 'PENDING_EDS', requestedEds: true, serviceOption: 'VOI' });
      expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      const txs = store.listPaymentTransactions(created.id);
      expect(txs.map((t) => t.endToEndId)).toEqual(['E1', 'E2']);
      expect(txs[1]).toMatchObject({ vopStatus: 'RVMC', vopCorrectedName: 'Robert', creditorIban: undefined });

      store.updatePaymentTransaction(txs[0]!.id, { debitBookingId: 11, creditBookingId: 12 });
      store.updatePaymentTransaction(txs[1]!.id, { vopStatus: 'RCVC', vopCorrectedName: undefined });
      expect(store.getPaymentTransaction(txs[0]!.id)).toMatchObject({ debitBookingId: 11, creditBookingId: 12, vopStatus: 'RCVC' });
      expect(store.getPaymentTransaction(txs[1]!.id)).toMatchObject({ vopStatus: 'RCVC', vopCorrectedName: undefined });

      store.updatePaymentOrderStatus(created.id, 'EXECUTED');
      expect(store.getPaymentOrder(created.id)!.status).toBe('EXECUTED');
    });

    it('lists with filters, newest first', () => {
      const a = store.createPaymentOrder(order({ msgId: 'M1' }), []);
      const b = store.createPaymentOrder(order({ orderId: 'A001', msgId: 'M2', status: 'EXECUTED' }), []);
      const c = store.createPaymentOrder(order({ partnerId: 'P2', msgId: 'M1' }), []);

      expect(store.listPaymentOrders().map((o) => o.id)).toEqual([c.id, b.id, a.id]);
      expect(store.listPaymentOrders({ partnerId: 'P1' }).map((o) => o.id)).toEqual([b.id, a.id]);
      expect(store.listPaymentOrders({ status: 'EXECUTED' }).map((o) => o.id)).toEqual([b.id]);
      expect(store.listPaymentOrders({ partnerId: 'P1', orderId: 'A000' }).map((o) => o.id)).toEqual([a.id]);
      expect(store.listPaymentOrders({ msgId: 'M1' }).map((o) => o.id)).toEqual([c.id, a.id]);
    });

    it('records payment status events per order and partner', () => {
      const a = store.createPaymentOrder(order(), []);
      const b = store.createPaymentOrder(order({ partnerId: 'P2' }), []);
      store.appendPaymentStatusEvent({ paymentOrderId: a.id, status: 'ACTC' });
      const rejected = store.appendPaymentStatusEvent({ paymentOrderId: a.id, status: 'RJCT', reasonCode: 'DS02', additionalInfo: ['cancelled'] });
      store.appendPaymentStatusEvent({ paymentOrderId: b.id, status: 'ACTC' });

      expect(rejected).toMatchObject({ status: 'RJCT', reasonCode: 'DS02', additionalInfo: ['cancelled'] });
      expect(store.listPaymentStatusEvents({ paymentOrderId: a.id }).map((e) => e.status)).toEqual(['ACTC', 'RJCT']);
      expect(store.listPaymentStatusEvents({ partnerId: 'P2' }).map((e) => e.paymentOrderId)).toEqual([b.id]);
      const today = new Date().toISOString().slice(0, 10);
      expect(store.listPaymentStatusEvents({ from: today, to: today })).toHaveLength(3);
      expect(store.listPaymentStatusEvents({ to: '2000-01-01' })).toHaveLength(0);
    });
  });

  describe('deliveries', () => {
    it('marks, lists and resets delivered items', () => {
      store.markDelivered('P1', 'hac', ['hac:1', 'hac:2', 'hac:1']);
      store.markDelivered('P1', 'psr', ['status:1']);
      store.markDelivered('P2', 'hac', ['hac:3']);

      expect([...store.listDeliveredKeys('P1', 'hac')].sort()).toEqual(['hac:1', 'hac:2']);
      expect(store.listDeliveredKeys('P1', 'vop').size).toBe(0);

      expect(store.resetDeliveries({ partnerId: 'P1', kind: 'hac' })).toBe(2);
      expect(store.listDeliveredKeys('P1', 'hac').size).toBe(0);
      expect(store.listDeliveredKeys('P1', 'psr').size).toBe(1);
      expect(store.resetDeliveries({ kind: 'hac' })).toBe(1);
      expect(store.resetDeliveries()).toBe(1);
    });
  });

  it('reset clears the new tables and restarts order IDs', () => {
    store.nextOrderId('P1');
    const o = store.createPaymentOrder(order(), [{ amountCents: 1, currency: 'EUR', vopStatus: 'RCVC' }]);
    store.appendPaymentStatusEvent({ paymentOrderId: o.id, status: 'ACTC' });
    store.appendHacEvent({ partnerId: 'P1', orderId: 'A000', action: 'FILE_UPLOAD', adminOrderType: 'BTU' });
    store.markDelivered('P1', 'hac', ['hac:1']);

    store.reset();

    expect(store.listPaymentOrders()).toEqual([]);
    expect(store.listPaymentStatusEvents()).toEqual([]);
    expect(store.listHacEvents()).toEqual([]);
    expect(store.listDeliveredKeys('P1', 'hac').size).toBe(0);
    expect(store.nextOrderId('P1')).toBe('A000');
  });

  describe('migrations', () => {
    it('adds new columns to a database created by an older schema', () => {
      const dir = mkdtempSync(join(tmpdir(), 'ebics-migrate-'));
      const path = join(dir, 'old.db');
      try {
        const old = new Database(path);
        old.exec(`
          CREATE TABLE transactions (
            transaction_id TEXT PRIMARY KEY, partner_id TEXT NOT NULL, user_id TEXT NOT NULL, host_id TEXT NOT NULL,
            direction TEXT NOT NULL DEFAULT 'download', phase TEXT NOT NULL DEFAULT 'Initialisation', order_type TEXT NOT NULL,
            num_segments INTEGER NOT NULL DEFAULT 1, current_segment INTEGER NOT NULL DEFAULT 1, segments TEXT NOT NULL,
            transaction_key TEXT NOT NULL, enc_key_digest TEXT NOT NULL, signature_data TEXT, service_name TEXT, msg_name TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL
          );
          CREATE TABLE uploaded_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT, partner_id TEXT NOT NULL, user_id TEXT NOT NULL, service_name TEXT NOT NULL,
            msg_name TEXT, raw_content TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO transactions (transaction_id, partner_id, user_id, host_id, order_type, segments, transaction_key, enc_key_digest, expires_at)
            VALUES ('TX1', 'P1', 'U1', 'H', 'HPD', '[]', 'k', 'd', '2999-01-01 00:00:00');
          INSERT INTO uploaded_orders (partner_id, user_id, service_name, raw_content) VALUES ('P1', 'U1', 'SCT', 'x');
        `);
        old.close();

        const migrated = new SqliteStore(path);
        expect(migrated.getTransaction('TX1')).toMatchObject({ orderType: 'HPD', requestEds: false, orderId: undefined, deliveryKeys: undefined });
        expect(migrated.listUploadedOrders()[0]).toMatchObject({ serviceName: 'SCT', orderId: undefined });

        migrated.createTransaction({
          transactionId: 'TX2', partnerId: 'P1', userId: 'U1', hostId: 'H', direction: 'upload', phase: 'Transfer',
          orderType: 'BTU', numSegments: 1, currentSegment: 0, segments: [], transactionKey: 'k', encKeyDigest: '',
          orderId: 'A000', serviceOption: 'VOI', requestEds: true, deliveryKind: 'hac', deliveryKeys: ['hac:1'],
        });
        expect(migrated.getTransaction('TX2')).toMatchObject({ orderId: 'A000', serviceOption: 'VOI', requestEds: true, deliveryKind: 'hac', deliveryKeys: ['hac:1'] });

        // Opening again is idempotent
        expect(() => new SqliteStore(path)).not.toThrow();

        const columns = (new Database(path).prepare('PRAGMA table_info(transactions)').all() as { name: string }[]).map((c) => c.name);
        expect(columns).toEqual(expect.arrayContaining(['order_id', 'service_option', 'request_eds', 'delivery_kind', 'delivery_keys']));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
