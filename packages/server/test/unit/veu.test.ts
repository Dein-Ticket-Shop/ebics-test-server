import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { SqliteStore } from '../../src/store/sqlite-store.js';
import { calculateIban } from '../../src/banking/iban.js';
import { cancelPaymentOrder, receiveCreditTransfers } from '../../src/banking/payments.js';
import {
  VeuError,
  cancelVeuOrder,
  distinctSigners,
  getVeuOrder,
  isReleasable,
  listVeuOrders,
  numSigRequired,
  orderDataDigest,
  signVeuOrder,
} from '../../src/banking/veu.js';
import { ReturnCode } from '../../src/protocol/return-codes.js';
import { buildPain001Document } from '../helpers/test-client.js';
import type { Account } from '../../src/store/types.js';

const PARTNER_ID = 'PARTNER1';
const UPLOADER = 'USER1';
const SIGNER = 'USER2';
const FLAGS = ['EBICS_EDS_HOLD', 'EBICS_VOP_CONFIRMATION', 'EBICS_VOP_DEFAULT', 'EBICS_STRICT_VALIDATION'] as const;

function veuError(action: () => unknown): VeuError {
  try {
    action();
  } catch (err) {
    if (err instanceof VeuError) return err;
    throw err;
  }
  throw new Error('expected a VeuError');
}

describe('VEU (distributed electronic signature)', () => {
  let store: SqliteStore;
  let debtor: Account;
  let creditor: Account;
  const saved: Record<string, string | undefined> = {};

  function openAccount(ownerName: string): Account {
    const person = store.createPerson({ name: ownerName, country: 'DE' });
    const accountNumber = store.getNextAccountSequence().toString().padStart(10, '0');
    return store.createAccount({ personId: person.id, iban: calculateIban('10020030', accountNumber), accountNumber, currency: 'EUR', name: `Konto ${ownerName}` });
  }

  /** Stores the upload like the BTU handler and hands it to receiveCreditTransfers */
  function receive(id: string, options: { requestEds?: boolean; creditorName?: string; pmtInfs?: number } = {}) {
    const rawContent = buildPain001Document({
      msgId: `MSG-${id}`,
      payments: Array.from({ length: options.pmtInfs ?? 1 }, (_, i) => ({
        pmtInfId: `PMT-${id}-${i + 1}`,
        debtorName: 'Musterfirma GmbH',
        debtorIban: debtor.iban,
        transactions: [
          { endToEndId: `E2E-${id}-${i + 1}`, creditorName: options.creditorName ?? 'Bob Mustermann', creditorIban: creditor.iban, amount: '12.34' },
        ],
      })),
    });
    const orderId = store.nextOrderId(PARTNER_ID);
    const uploaded = store.createUploadedOrder({ partnerId: PARTNER_ID, userId: UPLOADER, serviceName: 'SCI', msgName: 'pain.001', rawContent, orderId });
    const orders = receiveCreditTransfers(store, {
      rawContent,
      partnerId: PARTNER_ID,
      userId: UPLOADER,
      orderId,
      uploadedOrderId: uploaded.id,
      serviceName: 'SCI',
      serviceOption: 'VOI',
      msgName: 'pain.001',
      requestEds: options.requestEds ?? true,
    });
    return { orderId, rawContent, orders };
  }

  const balance = (account: Account) => store.getAccount(account.id)!.currentBalanceCents;
  const statuses = (paymentOrderId: number) => store.listPaymentStatusEvents({ paymentOrderId }).map((e) => e.status);
  const signers = (orderId: string) => store.listOrderSignatures(PARTNER_ID, orderId).map((s) => [s.userId, s.kind]);
  /** HAC events of the order itself (listHacEvents({ orderId }) also returns events referring to it via OrderIDRef) */
  const ownEvents = (orderId: string) => store.listHacEvents({ partnerId: PARTNER_ID, orderId }).filter((e) => e.orderId === orderId);
  const actions = (orderId: string) => ownEvents(orderId).map((e) => e.action);

  beforeEach(() => {
    for (const flag of FLAGS) {
      saved[flag] = process.env[flag];
      delete process.env[flag];
    }
    store = new SqliteStore(':memory:');
    store.setBankConfig({ blz: '10020030', name: 'EBICS Test Bank AG', bic: 'ETBADE2AXXX' });
    store.createSubscriber(PARTNER_ID, UPLOADER);
    store.createSubscriber(PARTNER_ID, SIGNER);
    debtor = openAccount('Musterfirma GmbH');
    store.grantAccountAccess(PARTNER_ID, debtor.id);
    store.createBooking({ accountId: debtor.id, amountCents: 1_000_000, currency: 'EUR', valueDate: '2025-01-01', bookingDate: '2025-01-01', transactionCode: 'NTRF' });
    creditor = openAccount('Bob Mustermann');
  });

  afterEach(() => {
    for (const flag of FLAGS) {
      if (saved[flag] === undefined) delete process.env[flag];
      else process.env[flag] = saved[flag];
    }
  });

  describe('orderDataDigest', () => {
    it('is the base64 SHA-256 of the order data without line breaks', () => {
      const xml = '<Document>\r\n  <MsgId>M1</MsgId>\n</Document>';
      expect(orderDataDigest(xml)).toBe(createHash('sha256').update('<Document>  <MsgId>M1</MsgId></Document>').digest('base64'));
    });

    it('ignores CRLF and LF line breaks but not other whitespace', () => {
      const flat = '<a><b>1</b></a>';
      expect(orderDataDigest('<a>\n<b>1</b>\n</a>')).toBe(orderDataDigest(flat));
      expect(orderDataDigest('<a>\r\n<b>1</b>\r\n</a>\n')).toBe(orderDataDigest(flat));
      expect(orderDataDigest('<a> <b>1</b></a>')).not.toBe(orderDataDigest(flat));
      expect(orderDataDigest('<a><b>2</b></a>')).not.toBe(orderDataDigest(flat));
    });
  });

  describe('without a hold', () => {
    it('executes at once, keeps the upload signature and leaves nothing in the VEU', () => {
      const { orderId, orders } = receive('NOW');
      expect(orders[0]).toMatchObject({ status: 'EXECUTED', signaturesRequired: 1, vopConfirmationRequired: false, requestedEds: true });
      expect(signers(orderId)).toEqual([[UPLOADER, 'UPLOAD']]);
      expect(getVeuOrder(store, PARTNER_ID, orderId)).toBeUndefined();
      expect(listVeuOrders(store)).toEqual([]);
      expect(veuError(() => signVeuOrder(store, { partnerId: PARTNER_ID, orderId, userId: SIGNER })).returnCode).toBe(ReturnCode.EBICS_ORDERID_UNKNOWN);
    });
  });

  describe('EDS hold', () => {
    beforeEach(() => {
      process.env['EBICS_EDS_HOLD'] = 'true';
    });

    it('holds an upload requesting EDS for a second signature; the upload signature is the first', () => {
      const { orderId, rawContent, orders } = receive('EDS');
      expect(orders[0]).toMatchObject({ status: 'PENDING_EDS', signaturesRequired: 2, vopConfirmationRequired: false });
      expect(balance(debtor)).toBe(1_000_000);

      const veu = getVeuOrder(store, PARTNER_ID, orderId)!;
      expect(veu).toMatchObject({
        partnerId: PARTNER_ID,
        orderId,
        signaturesRequired: 2,
        vopConfirmationRequired: false,
        vopConfirmed: false,
        rawContent,
        dataDigest: orderDataDigest(rawContent),
      });
      expect(veu.orders.map((o) => o.id)).toEqual([orders[0]!.id]);
      expect(veu.signatures.map((s) => [s.partnerId, s.orderId, s.userId, s.kind])).toEqual([[PARTNER_ID, orderId, UPLOADER, 'UPLOAD']]);
      expect(distinctSigners(veu)).toBe(1);
      expect(numSigRequired(veu)).toBe(2);
      expect(isReleasable(veu)).toBe(false);
      expect(listVeuOrders(store).map((v) => v.orderId)).toEqual([orderId]);
    });

    it('does not hold uploads without requestEDS', () => {
      const { orderId, orders } = receive('NOEDS', { requestEds: false });
      expect(orders[0]).toMatchObject({ status: 'EXECUTED', signaturesRequired: 1 });
      expect(getVeuOrder(store, PARTNER_ID, orderId)).toBeUndefined();
    });

    it('groups the PmtInfs of one upload, lists orders oldest first and filters by partner', () => {
      const first = receive('A', { pmtInfs: 2 });
      const second = receive('B');
      const foreignOrderId = store.nextOrderId('PARTNER2');
      store.createPaymentOrder(
        { orderId: foreignOrderId, partnerId: 'PARTNER2', userId: 'USER9', serviceName: 'SCT', msgName: 'pain.001', msgId: 'MSG-P2', pmtInfId: 'PMT-P2', requestedEds: true, status: 'PENDING_EDS' },
        [],
      );

      const own = listVeuOrders(store, PARTNER_ID);
      expect(own.map((v) => v.orderId)).toEqual([first.orderId, second.orderId]);
      expect(own.map((v) => v.orders.map((o) => o.pmtInfId))).toEqual([['PMT-A-1', 'PMT-A-2'], ['PMT-B-1']]);
      expect(own[0]!.signatures).toHaveLength(1);
      expect(listVeuOrders(store)).toHaveLength(3);
      expect(listVeuOrders(store, 'PARTNER2').map((v) => [v.partnerId, v.orderId])).toEqual([['PARTNER2', foreignOrderId]]);
      expect(getVeuOrder(store, PARTNER_ID, second.orderId)!.orders.map((o) => o.pmtInfId)).toEqual(['PMT-B-1']);
    });

    it('rejects a further signature by the uploader with 091306 and records nothing', () => {
      const { orderId, orders } = receive('DUP');
      const err = veuError(() => signVeuOrder(store, { partnerId: PARTNER_ID, orderId, userId: UPLOADER }));
      expect(err.returnCode).toBe(ReturnCode.EBICS_DUPLICATE_SIGNATURE);
      expect(err.returnCode).toBe('091306');

      expect(signers(orderId)).toEqual([[UPLOADER, 'UPLOAD']]);
      expect(store.listHacEvents({ partnerId: PARTNER_ID }).filter((e) => e.adminOrderType === 'HVE')).toEqual([]);
      expect(store.getPaymentOrder(orders[0]!.id)!.status).toBe('PENDING_EDS');
    });

    it('releases on the second distinct signer: executes every PmtInf, reports ACSC and records the HVE', () => {
      const { orderId, orders } = receive('REL', { pmtInfs: 2 });

      const result = signVeuOrder(store, { partnerId: PARTNER_ID, orderId, userId: SIGNER });
      expect(result.released).toBe(true);
      expect(result.orderId).toMatch(/^[A-Z][A-Z0-9]{3}$/);
      expect(result.orderId).not.toBe(orderId);

      for (const order of orders) {
        expect(store.getPaymentOrder(order.id)!.status).toBe('EXECUTED');
        expect(statuses(order.id)).toEqual(['ACTC', 'ACSC']);
      }
      expect(balance(debtor)).toBe(1_000_000 - 2 * 1234);
      expect(balance(creditor)).toBe(2 * 1234);
      expect(signers(orderId)).toEqual([[UPLOADER, 'UPLOAD'], [SIGNER, 'HVE']]);

      const hve = store.listHacEvents({ partnerId: PARTNER_ID, orderId: result.orderId });
      expect(hve.map((e) => ({ action: e.action, reasonCode: e.reasonCode, userId: e.userId, adminOrderType: e.adminOrderType, orderIdRef: e.orderIdRef, adminOrderTypeRef: e.adminOrderTypeRef }))).toEqual([
        { action: 'ES_UPLOAD', reasonCode: 'TS01', userId: SIGNER, adminOrderType: 'HVE', orderIdRef: orderId, adminOrderTypeRef: 'BTU' },
        { action: 'ES_VERIFICATION', reasonCode: 'DS01', userId: SIGNER, adminOrderType: 'HVE', orderIdRef: orderId, adminOrderTypeRef: 'BTU' },
      ]);

      // The order's history includes the HVE events through their OrderIDRef
      expect(store.listHacEvents({ partnerId: PARTNER_ID, orderId }).map((e) => e.action)).toEqual([
        'FILE_UPLOAD', 'ES_VERIFICATION', 'VEU_FORWARDING', 'ES_UPLOAD', 'ES_VERIFICATION', 'VEU_VERIFICATION_END', 'ORDER_HAC_FINAL_POS',
      ]);
      const original = ownEvents(orderId);
      expect(original.map((e) => e.action)).toEqual(['FILE_UPLOAD', 'ES_VERIFICATION', 'VEU_FORWARDING', 'VEU_VERIFICATION_END', 'ORDER_HAC_FINAL_POS']);
      expect(original[3]).toMatchObject({ reasonCode: 'DS01', adminOrderType: 'BTU' });
      const final = original.at(-1)!;
      expect(final.userId).toBeUndefined();
      const references = final.additionalInfo.filter((l) => l.startsWith('Sammlerreferenz')).map((l) => l.split(':')[1]!.trim());
      expect(references).toEqual(['PMT-REL-1', 'PMT-REL-2']);

      expect(getVeuOrder(store, PARTNER_ID, orderId)).toBeUndefined();
      expect(veuError(() => signVeuOrder(store, { partnerId: PARTNER_ID, orderId, userId: SIGNER })).returnCode).toBe(ReturnCode.EBICS_ORDERID_UNKNOWN);
      expect(veuError(() => cancelVeuOrder(store, { partnerId: PARTNER_ID, orderId, userId: SIGNER })).returnCode).toBe(ReturnCode.EBICS_ORDERID_UNKNOWN);
    });

    it('cancels on behalf of a user: RJCT DS02 for every PmtInf and VEU_CANCEL_ORDER attributed to the canceller', () => {
      const { orderId, orders } = receive('CXL', { pmtInfs: 2 });

      const result = cancelVeuOrder(store, { partnerId: PARTNER_ID, orderId, userId: SIGNER }, ['Storniert durch USER2']);
      expect(result.orderId).toMatch(/^[A-Z][A-Z0-9]{3}$/);
      expect(result.orderId).not.toBe(orderId);

      for (const order of orders) {
        expect(store.getPaymentOrder(order.id)!.status).toBe('CANCELLED');
        const events = store.listPaymentStatusEvents({ paymentOrderId: order.id });
        expect(events.map((e) => e.status)).toEqual(['ACTC', 'RJCT']);
        expect(events.at(-1)).toMatchObject({ reasonCode: 'DS02', additionalInfo: ['Storniert durch USER2'] });
      }
      expect(balance(debtor)).toBe(1_000_000);
      expect(signers(orderId)).toEqual([[UPLOADER, 'UPLOAD']]);

      const cancel = store.listHacEvents({ partnerId: PARTNER_ID, orderId: result.orderId });
      expect(cancel).toHaveLength(1);
      expect(cancel[0]).toMatchObject({
        action: 'VEU_CANCEL_ORDER',
        adminOrderType: 'HVS',
        userId: SIGNER,
        orderIdRef: orderId,
        adminOrderTypeRef: 'BTU',
        reasonCode: 'DS02',
        additionalInfo: ['Storniert durch USER2'],
      });

      const original = ownEvents(orderId);
      expect(original.map((e) => e.action)).toEqual(['FILE_UPLOAD', 'ES_VERIFICATION', 'VEU_FORWARDING', 'ORDER_HAC_FINAL_POS']);
      expect(original.at(-1)!.userId).toBeUndefined();
      expect(original.at(-1)!.additionalInfo.filter((l) => l.startsWith('Sammlerreferenz'))).toHaveLength(2);

      expect(getVeuOrder(store, PARTNER_ID, orderId)).toBeUndefined();
      expect(veuError(() => cancelVeuOrder(store, { partnerId: PARTNER_ID, orderId, userId: SIGNER })).returnCode).toBe(ReturnCode.EBICS_ORDERID_UNKNOWN);
      expect(veuError(() => signVeuOrder(store, { partnerId: PARTNER_ID, orderId, userId: SIGNER })).returnCode).toBe(ReturnCode.EBICS_ORDERID_UNKNOWN);
    });

    it('attributes a cancellation without canceller to the uploader under a new OrderID', () => {
      const { orderId, orders } = receive('ADMIN');
      cancelPaymentOrder(store, orders[0]!.id);

      const cancel = store.listHacEvents({ partnerId: PARTNER_ID }).find((e) => e.action === 'VEU_CANCEL_ORDER')!;
      expect(cancel).toMatchObject({ adminOrderType: 'HVS', userId: UPLOADER, orderIdRef: orderId, additionalInfo: [] });
      expect(cancel.orderId).not.toBe(orderId);
      expect(store.getPaymentOrder(orders[0]!.id)!.status).toBe('CANCELLED');
    });

    it('answers 091114 for unknown orders and orders of another partner', () => {
      const { orderId } = receive('UNKNOWN');
      expect(veuError(() => signVeuOrder(store, { partnerId: PARTNER_ID, orderId: 'Z999', userId: SIGNER })).returnCode).toBe('091114');
      expect(veuError(() => cancelVeuOrder(store, { partnerId: PARTNER_ID, orderId: 'Z999', userId: SIGNER })).returnCode).toBe('091114');
      expect(veuError(() => signVeuOrder(store, { partnerId: 'PARTNER2', orderId, userId: SIGNER })).returnCode).toBe('091114');
      expect(actions(orderId)).toEqual(['FILE_UPLOAD', 'ES_VERIFICATION', 'VEU_FORWARDING']);
    });
  });

  describe('VoP confirmation hold', () => {
    beforeEach(() => {
      process.env['EBICS_VOP_CONFIRMATION'] = 'true';
    });

    it('holds a transfer whose payee name does not match until an HVE confirms it; the uploader may confirm', () => {
      const { orderId, orders } = receive('VOP', { creditorName: 'Alice Wunderland' });
      expect(orders[0]).toMatchObject({ status: 'PENDING_EDS', signaturesRequired: 1, vopConfirmationRequired: true });
      expect(store.listPaymentTransactions(orders[0]!.id)[0]!.vopStatus).toBe('RVNM');
      const forwarding = store.listHacEvents({ partnerId: PARTNER_ID, orderId }).find((e) => e.action === 'VEU_FORWARDING')!;
      expect(forwarding.reasonCode).toBe('DS06');
      expect(forwarding.additionalInfo[0]).toContain('RVNM');

      const veu = getVeuOrder(store, PARTNER_ID, orderId)!;
      expect(veu).toMatchObject({ signaturesRequired: 1, vopConfirmationRequired: true, vopConfirmed: false });
      expect(distinctSigners(veu)).toBe(1);
      expect(numSigRequired(veu)).toBe(2);
      expect(isReleasable(veu)).toBe(false);

      const result = signVeuOrder(store, { partnerId: PARTNER_ID, orderId, userId: UPLOADER });
      expect(result.released).toBe(true);
      expect(store.getPaymentOrder(orders[0]!.id)!.status).toBe('EXECUTED');
      expect(statuses(orders[0]!.id)).toEqual(['ACTC', 'ACSC']);
      expect(signers(orderId)).toEqual([[UPLOADER, 'UPLOAD'], [UPLOADER, 'HVE']]);
      expect(actions(orderId).slice(-2)).toEqual(['VEU_VERIFICATION_END', 'ORDER_HAC_FINAL_POS']);
    });

    it('holds a close match as well and accepts the confirmation from another user', () => {
      const { orderId, orders } = receive('CLOSE', { creditorName: 'Mustermann Bob' });
      expect(store.listPaymentTransactions(orders[0]!.id)[0]!.vopStatus).toBe('RVMC');
      expect(orders[0]!.status).toBe('PENDING_EDS');
      expect(signVeuOrder(store, { partnerId: PARTNER_ID, orderId, userId: SIGNER }).released).toBe(true);
    });

    it('executes a transfer whose payee name matches at once', () => {
      const { orderId, orders } = receive('MATCH');
      expect(orders[0]).toMatchObject({ status: 'EXECUTED', vopConfirmationRequired: false });
      expect(getVeuOrder(store, PARTNER_ID, orderId)).toBeUndefined();
    });

    it('ignores the VoP result without EBICS_VOP_CONFIRMATION', () => {
      delete process.env['EBICS_VOP_CONFIRMATION'];
      const { orders } = receive('NOFLAG', { creditorName: 'Alice Wunderland' });
      expect(orders[0]).toMatchObject({ status: 'EXECUTED', vopConfirmationRequired: false });
    });

    it('with the EDS hold on, the confirmation does not replace the second signer', () => {
      process.env['EBICS_EDS_HOLD'] = 'true';
      const { orderId, orders } = receive('BOTH', { creditorName: 'Alice Wunderland' });
      const pending = getVeuOrder(store, PARTNER_ID, orderId)!;
      expect(pending).toMatchObject({ signaturesRequired: 2, vopConfirmationRequired: true, vopConfirmed: false });
      expect(numSigRequired(pending)).toBe(2);

      expect(signVeuOrder(store, { partnerId: PARTNER_ID, orderId, userId: UPLOADER }).released).toBe(false);
      const confirmed = getVeuOrder(store, PARTNER_ID, orderId)!;
      expect(confirmed.vopConfirmed).toBe(true);
      expect(distinctSigners(confirmed)).toBe(1);
      expect(isReleasable(confirmed)).toBe(false);
      expect(store.getPaymentOrder(orders[0]!.id)!.status).toBe('PENDING_EDS');

      expect(veuError(() => signVeuOrder(store, { partnerId: PARTNER_ID, orderId, userId: UPLOADER })).returnCode).toBe('091306');
      expect(signVeuOrder(store, { partnerId: PARTNER_ID, orderId, userId: SIGNER }).released).toBe(true);
      expect(store.getPaymentOrder(orders[0]!.id)!.status).toBe('EXECUTED');
    });

    // NumSigRequired is "the total number of signatures required for release": an order that is still pending
    // must report more than NumSigDone, also after the uploader confirmed the VoP result.
    it('reports NumSigRequired above the signatures done while the order is still pending', () => {
      process.env['EBICS_EDS_HOLD'] = 'true';
      const { orderId } = receive('COUNT', { creditorName: 'Alice Wunderland' });
      signVeuOrder(store, { partnerId: PARTNER_ID, orderId, userId: UPLOADER });
      const veu = getVeuOrder(store, PARTNER_ID, orderId)!;
      expect(isReleasable(veu)).toBe(false);
      expect(numSigRequired(veu)).toBe(3);
    });
  });
});
