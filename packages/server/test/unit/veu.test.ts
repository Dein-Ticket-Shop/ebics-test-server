import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { SqliteStore } from '../../src/store/sqlite-store.js';
import { calculateIban } from '../../src/banking/iban.js';
import { cancelPaymentOrder, receiveCreditTransfers, type CreditTransferUpload } from '../../src/banking/payments.js';
import { SignatureAuthorisationError } from '../../src/banking/validation.js';
import {
  VeuError,
  canSign,
  cancelVeuOrder,
  distinctSigners,
  getVeuOrder,
  hasRequiredSignatures,
  isReleasable,
  listVeuOrders,
  numSigRequired,
  orderDataDigest,
  signVeuOrder,
} from '../../src/banking/veu.js';
import { ReturnCode } from '../../src/protocol/return-codes.js';
import { buildPain001Document } from '../helpers/test-client.js';
import type { Account, SignatureClass } from '../../src/store/types.js';

const PARTNER_ID = 'PARTNER1';
const UPLOADER = 'USER1';
const SIGNER = 'USER2';
const THIRD = 'USER3';
const FLAGS = ['EBICS_VOP_CONFIRMATION', 'EBICS_VOP_DEFAULT', 'EBICS_STRICT_VALIDATION'] as const;
const VOP_NO_MATCH = 'Empfaengerueberpruefung RVNM: Bestaetigung per Unterschrift erforderlich';
const signatureHoldInfo = (signatureClass: SignatureClass) => `Unterschriftsklasse ${signatureClass}: weitere Unterschrift erforderlich`;

function veuError(action: () => unknown): VeuError {
  try {
    action();
  } catch (err) {
    if (err instanceof VeuError) return err;
    throw err;
  }
  throw new Error('expected a VeuError');
}

interface ReceiveOptions {
  requestEds?: boolean;
  signatureFlag?: boolean;
  signatureClass?: SignatureClass;
  userId?: string;
  creditorName?: string;
  pmtInfs?: number;
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

  /** Stores the upload like the BTU handler and returns the input for receiveCreditTransfers */
  function prepare(id: string, options: ReceiveOptions = {}): { orderId: string; rawContent: string; upload: CreditTransferUpload } {
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
    const userId = options.userId ?? UPLOADER;
    const orderId = store.nextOrderId(PARTNER_ID);
    const uploaded = store.createUploadedOrder({ partnerId: PARTNER_ID, userId, serviceName: 'SCI', msgName: 'pain.001', rawContent, orderId });
    const upload: CreditTransferUpload = {
      rawContent,
      partnerId: PARTNER_ID,
      userId,
      orderId,
      uploadedOrderId: uploaded.id,
      serviceName: 'SCI',
      serviceOption: 'VOI',
      msgName: 'pain.001',
      signatureFlag: options.signatureFlag,
      requestEds: options.requestEds ?? true,
      signatureClass: options.signatureClass,
    };
    return { orderId, rawContent, upload };
  }

  function receive(id: string, options: ReceiveOptions = {}) {
    const { orderId, rawContent, upload } = prepare(id, options);
    return { orderId, rawContent, orders: receiveCreditTransfers(store, upload) };
  }

  const setClass = (userId: string, signatureClass: SignatureClass) => store.updateSubscriberSettings(PARTNER_ID, userId, { signatureClass });
  const sign = (orderId: string, userId: string) => signVeuOrder(store, { partnerId: PARTNER_ID, orderId, userId });
  const cancel = (orderId: string, userId: string) => cancelVeuOrder(store, { partnerId: PARTNER_ID, orderId, userId });
  const veuOf = (orderId: string) => getVeuOrder(store, PARTNER_ID, orderId)!;
  const balance = (account: Account) => store.getAccount(account.id)!.currentBalanceCents;
  const statuses = (paymentOrderId: number) => store.listPaymentStatusEvents({ paymentOrderId }).map((e) => e.status);
  const orderStatus = (paymentOrderId: number) => store.getPaymentOrder(paymentOrderId)!.status;
  /** All stored signatures of the order, including transport signatures: [userId, kind, signatureClass] */
  const signers = (orderId: string) => store.listOrderSignatures(PARTNER_ID, orderId).map((s) => [s.userId, s.kind, s.signatureClass]);
  /** HAC events of the order itself (listHacEvents({ orderId }) also returns events referring to it via OrderIDRef) */
  const ownEvents = (orderId: string) => store.listHacEvents({ partnerId: PARTNER_ID, orderId }).filter((e) => e.orderId === orderId);
  const actions = (orderId: string) => ownEvents(orderId).map((e) => e.action);
  const forwardingInfo = (orderId: string) => ownEvents(orderId).find((e) => e.action === 'VEU_FORWARDING')?.additionalInfo;
  const veuActionEvents = () => store.listHacEvents({ partnerId: PARTNER_ID }).filter((e) => e.adminOrderType === 'HVE' || e.adminOrderType === 'HVS');

  beforeEach(() => {
    for (const flag of FLAGS) {
      saved[flag] = process.env[flag];
      delete process.env[flag];
    }
    store = new SqliteStore(':memory:');
    store.setBankConfig({ blz: '10020030', name: 'EBICS Test Bank AG', bic: 'ETBADE2AXXX' });
    store.createSubscriber(PARTNER_ID, UPLOADER);
    store.createSubscriber(PARTNER_ID, SIGNER);
    store.createSubscriber(PARTNER_ID, THIRD);
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

  describe('class E uploader (default)', () => {
    it('subscribers have signature class E by default', () => {
      expect(store.getSubscriber(PARTNER_ID, UPLOADER)!.signatureClass).toBe('E');
    });

    it('executes an upload with requestEDS at once, keeps the upload signature with class E and leaves nothing in the VEU', () => {
      const { orderId, orders } = receive('NOW');
      expect(orders[0]).toMatchObject({ status: 'EXECUTED', vopConfirmationRequired: false, requestedEds: true });
      expect(orders[0]).not.toHaveProperty('signaturesRequired');
      expect(statuses(orders[0]!.id)).toEqual(['ACTC', 'ACSC']);
      expect(balance(debtor)).toBe(1_000_000 - 1234);
      expect(signers(orderId)).toEqual([[UPLOADER, 'UPLOAD', 'E']]);
      expect(actions(orderId)).toEqual(['FILE_UPLOAD', 'ES_VERIFICATION', 'ORDER_HAC_FINAL_POS']);
      expect(getVeuOrder(store, PARTNER_ID, orderId)).toBeUndefined();
      expect(listVeuOrders(store)).toEqual([]);
      expect(veuError(() => sign(orderId, SIGNER)).returnCode).toBe(ReturnCode.EBICS_ORDERID_UNKNOWN);
    });

    it('executes an upload with SignatureFlag but without requestEDS at once', () => {
      const { orderId, orders } = receive('FLAG', { signatureFlag: true, requestEds: false });
      expect(orders[0]).toMatchObject({ status: 'EXECUTED', requestedEds: false });
      expect(signers(orderId)).toEqual([[UPLOADER, 'UPLOAD', 'E']]);
    });

    it('treats an uploader unknown to the store as class E', () => {
      const { orderId, orders } = receive('GHOST', { userId: 'GHOST' });
      expect(orders[0]!.status).toBe('EXECUTED');
      expect(store.listOrderSignatures(PARTNER_ID, orderId).map((s) => [s.userId, s.signatureClass])).toEqual([['GHOST', 'E']]);
    });

    it('prefers the signature class passed with the upload over the stored class', () => {
      setClass(UPLOADER, 'A');
      expect(receive('PASSED-E', { signatureClass: 'E' }).orders[0]!.status).toBe('EXECUTED');

      setClass(UPLOADER, 'E');
      const held = receive('PASSED-B', { signatureClass: 'B' });
      expect(held.orders[0]!.status).toBe('PENDING_EDS');
      expect(signers(held.orderId)).toEqual([[UPLOADER, 'UPLOAD', 'B']]);
      expect(forwardingInfo(held.orderId)).toEqual([signatureHoldInfo('B')]);
    });
  });

  describe('uploads without SignatureFlag', () => {
    it.each(['E', 'A', 'B', 'T'] as const)('executes the upload of a class %s user at once; its signature is a transport signature (T)', (signatureClass) => {
      setClass(UPLOADER, signatureClass);
      const { orderId, orders } = receive(`NOFLAG-${signatureClass}`, { requestEds: false });
      expect(orders[0]).toMatchObject({ status: 'EXECUTED', requestedEds: false });
      expect(balance(creditor)).toBe(1234);
      expect(signers(orderId)).toEqual([[UPLOADER, 'UPLOAD', 'T']]);
      expect(getVeuOrder(store, PARTNER_ID, orderId)).toBeUndefined();
    });
  });

  describe('uploads with SignatureFlag but without requestEDS', () => {
    it.each(['A', 'B', 'T'] as const)('rejects the upload of a class %s user before anything is stored', (signatureClass) => {
      setClass(UPLOADER, signatureClass);
      const { orderId, upload } = prepare(`REJECT-${signatureClass}`, { signatureFlag: true, requestEds: false });

      expect(() => receiveCreditTransfers(store, upload)).toThrow(SignatureAuthorisationError);
      expect(() => receiveCreditTransfers(store, upload)).toThrow(`Unterschriftsklasse ${signatureClass} von ${UPLOADER}`);
      expect(store.listPaymentOrders({ partnerId: PARTNER_ID })).toEqual([]);
      expect(store.listOrderSignatures(PARTNER_ID, orderId)).toEqual([]);
      expect(store.listHacEvents({ partnerId: PARTNER_ID })).toEqual([]);
      expect(balance(debtor)).toBe(1_000_000);
    });
  });

  describe('class A uploader', () => {
    beforeEach(() => {
      setClass(UPLOADER, 'A');
    });

    it('holds an upload requesting EDS for a second signature; the upload signature is the first', () => {
      const { orderId, rawContent, orders } = receive('EDS');
      expect(orders[0]).toMatchObject({ status: 'PENDING_EDS', vopConfirmationRequired: false, requestedEds: true });
      expect(statuses(orders[0]!.id)).toEqual(['ACTC']);
      expect(balance(debtor)).toBe(1_000_000);

      const forwarding = ownEvents(orderId).find((e) => e.action === 'VEU_FORWARDING')!;
      expect(forwarding).toMatchObject({ reasonCode: 'DS06', additionalInfo: [signatureHoldInfo('A')] });
      expect(actions(orderId)).toEqual(['FILE_UPLOAD', 'ES_VERIFICATION', 'VEU_FORWARDING']);

      const veu = veuOf(orderId);
      expect(veu).toMatchObject({
        partnerId: PARTNER_ID,
        orderId,
        vopConfirmationRequired: false,
        vopConfirmed: false,
        rawContent,
        dataDigest: orderDataDigest(rawContent),
      });
      expect(veu).not.toHaveProperty('signaturesRequired');
      expect(veu.orders.map((o) => o.id)).toEqual([orders[0]!.id]);
      expect(veu.signatures.map((s) => [s.partnerId, s.orderId, s.userId, s.kind, s.signatureClass])).toEqual([[PARTNER_ID, orderId, UPLOADER, 'UPLOAD', 'A']]);
      expect(distinctSigners(veu)).toBe(1);
      expect(hasRequiredSignatures(veu)).toBe(false);
      expect(numSigRequired(veu)).toBe(2);
      expect(isReleasable(veu)).toBe(false);
      expect(listVeuOrders(store).map((v) => v.orderId)).toEqual([orderId]);
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
      const err = veuError(() => sign(orderId, UPLOADER));
      expect(err.returnCode).toBe(ReturnCode.EBICS_DUPLICATE_SIGNATURE);
      expect(err.returnCode).toBe('091306');

      expect(signers(orderId)).toEqual([[UPLOADER, 'UPLOAD', 'A']]);
      expect(veuActionEvents()).toEqual([]);
      expect(orderStatus(orders[0]!.id)).toBe('PENDING_EDS');
    });

    it('releases on a class B second signer: executes every PmtInf, reports ACSC and records the HVE', () => {
      setClass(SIGNER, 'B');
      const { orderId, orders } = receive('REL', { pmtInfs: 2 });

      const result = sign(orderId, SIGNER);
      expect(result.released).toBe(true);
      expect(result.orderId).toMatch(/^[A-Z][A-Z0-9]{3}$/);
      expect(result.orderId).not.toBe(orderId);

      for (const order of orders) {
        expect(orderStatus(order.id)).toBe('EXECUTED');
        expect(statuses(order.id)).toEqual(['ACTC', 'ACSC']);
      }
      expect(balance(debtor)).toBe(1_000_000 - 2 * 1234);
      expect(balance(creditor)).toBe(2 * 1234);
      expect(signers(orderId)).toEqual([[UPLOADER, 'UPLOAD', 'A'], [SIGNER, 'HVE', 'B']]);

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
      expect(veuError(() => sign(orderId, SIGNER)).returnCode).toBe(ReturnCode.EBICS_ORDERID_UNKNOWN);
      expect(veuError(() => cancel(orderId, SIGNER)).returnCode).toBe(ReturnCode.EBICS_ORDERID_UNKNOWN);
    });

    it.each(['E', 'A', 'B'] as const)('releases on a second signer with class %s and stores the HVE with that class', (signatureClass) => {
      setClass(SIGNER, signatureClass);
      const { orderId, orders } = receive(`SECOND-${signatureClass}`);
      expect(canSign(veuOf(orderId), { userId: SIGNER, signatureClass })).toBe(true);

      expect(sign(orderId, SIGNER).released).toBe(true);
      expect(orderStatus(orders[0]!.id)).toBe('EXECUTED');
      expect(signers(orderId)).toEqual([[UPLOADER, 'UPLOAD', 'A'], [SIGNER, 'HVE', signatureClass]]);
    });

    it('answers 091304 for a signer who is not a subscriber of the partner', () => {
      const { orderId, orders } = receive('NOBODY');
      expect(veuError(() => sign(orderId, 'NOBODY')).returnCode).toBe(ReturnCode.EBICS_SIGNER_UNKNOWN);
      expect(veuError(() => cancel(orderId, 'NOBODY')).returnCode).toBe('091304');
      expect(orderStatus(orders[0]!.id)).toBe('PENDING_EDS');
      expect(signers(orderId)).toHaveLength(1);
    });

    it('cancels on behalf of a user: RJCT DS02 for every PmtInf and VEU_CANCEL_ORDER attributed to the canceller', () => {
      // A class B user may cancel as well
      setClass(SIGNER, 'B');
      const { orderId, orders } = receive('CXL', { pmtInfs: 2 });

      const result = cancelVeuOrder(store, { partnerId: PARTNER_ID, orderId, userId: SIGNER }, ['Storniert durch USER2']);
      expect(result.orderId).toMatch(/^[A-Z][A-Z0-9]{3}$/);
      expect(result.orderId).not.toBe(orderId);

      for (const order of orders) {
        expect(orderStatus(order.id)).toBe('CANCELLED');
        const events = store.listPaymentStatusEvents({ paymentOrderId: order.id });
        expect(events.map((e) => e.status)).toEqual(['ACTC', 'RJCT']);
        expect(events.at(-1)).toMatchObject({ reasonCode: 'DS02', additionalInfo: ['Storniert durch USER2'] });
      }
      expect(balance(debtor)).toBe(1_000_000);
      expect(signers(orderId)).toEqual([[UPLOADER, 'UPLOAD', 'A']]);

      const cancelEvents = store.listHacEvents({ partnerId: PARTNER_ID, orderId: result.orderId });
      expect(cancelEvents).toHaveLength(1);
      expect(cancelEvents[0]).toMatchObject({
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
      expect(veuError(() => cancel(orderId, SIGNER)).returnCode).toBe(ReturnCode.EBICS_ORDERID_UNKNOWN);
      expect(veuError(() => sign(orderId, SIGNER)).returnCode).toBe(ReturnCode.EBICS_ORDERID_UNKNOWN);
    });

    it('attributes a cancellation without canceller to the uploader under a new OrderID', () => {
      const { orderId, orders } = receive('ADMIN');
      cancelPaymentOrder(store, orders[0]!.id);

      const cancelEvent = store.listHacEvents({ partnerId: PARTNER_ID }).find((e) => e.action === 'VEU_CANCEL_ORDER')!;
      expect(cancelEvent).toMatchObject({ adminOrderType: 'HVS', userId: UPLOADER, orderIdRef: orderId, additionalInfo: [] });
      expect(cancelEvent.orderId).not.toBe(orderId);
      expect(orderStatus(orders[0]!.id)).toBe('CANCELLED');
    });

    it('answers 091114 for unknown orders and orders of another partner', () => {
      const { orderId } = receive('UNKNOWN');
      expect(veuError(() => signVeuOrder(store, { partnerId: PARTNER_ID, orderId: 'Z999', userId: SIGNER })).returnCode).toBe('091114');
      expect(veuError(() => cancelVeuOrder(store, { partnerId: PARTNER_ID, orderId: 'Z999', userId: SIGNER })).returnCode).toBe('091114');
      expect(veuError(() => signVeuOrder(store, { partnerId: 'PARTNER2', orderId, userId: SIGNER })).returnCode).toBe('091114');
      expect(actions(orderId)).toEqual(['FILE_UPLOAD', 'ES_VERIFICATION', 'VEU_FORWARDING']);
    });
  });

  describe('class B signatures', () => {
    it.each(['A', 'E'] as const)('B + B does not release the order; a class %s signer completes the authorisation', (thirdClass) => {
      setClass(UPLOADER, 'B');
      setClass(SIGNER, 'B');
      setClass(THIRD, thirdClass);
      const { orderId, orders } = receive(`BB-${thirdClass}`);
      expect(forwardingInfo(orderId)).toEqual([signatureHoldInfo('B')]);
      expect(numSigRequired(veuOf(orderId))).toBe(2);

      const second = sign(orderId, SIGNER);
      expect(second.released).toBe(false);
      expect(second.orderId).toMatch(/^[A-Z][A-Z0-9]{3}$/);
      const pending = veuOf(orderId);
      expect(pending.signatures.map((s) => [s.userId, s.kind, s.signatureClass])).toEqual([[UPLOADER, 'UPLOAD', 'B'], [SIGNER, 'HVE', 'B']]);
      expect(distinctSigners(pending)).toBe(2);
      expect(hasRequiredSignatures(pending)).toBe(false);
      expect(isReleasable(pending)).toBe(false);
      expect(numSigRequired(pending)).toBe(3);
      expect(orderStatus(orders[0]!.id)).toBe('PENDING_EDS');
      expect(statuses(orders[0]!.id)).toEqual(['ACTC']);
      expect(balance(debtor)).toBe(1_000_000);
      expect(actions(orderId)).toEqual(['FILE_UPLOAD', 'ES_VERIFICATION', 'VEU_FORWARDING']);

      expect(veuError(() => sign(orderId, SIGNER)).returnCode).toBe('091306');
      expect(veuError(() => sign(orderId, UPLOADER)).returnCode).toBe('091306');

      expect(sign(orderId, THIRD).released).toBe(true);
      expect(orderStatus(orders[0]!.id)).toBe('EXECUTED');
      expect(balance(debtor)).toBe(1_000_000 - 1234);
      expect(signers(orderId)).toEqual([[UPLOADER, 'UPLOAD', 'B'], [SIGNER, 'HVE', 'B'], [THIRD, 'HVE', thirdClass]]);
    });

    it('a class B uploader is released by a class A signer', () => {
      setClass(UPLOADER, 'B');
      setClass(SIGNER, 'A');
      const { orderId, orders } = receive('BA');
      expect(sign(orderId, SIGNER).released).toBe(true);
      expect(orderStatus(orders[0]!.id)).toBe('EXECUTED');
    });
  });

  describe('class T uploader', () => {
    beforeEach(() => {
      setClass(UPLOADER, 'T');
    });

    it('holds the upload without listing the transport signature; one class E signature releases it', () => {
      const { orderId, orders } = receive('T', { pmtInfs: 2 });
      expect(orders.map((o) => o.status)).toEqual(['PENDING_EDS', 'PENDING_EDS']);
      expect(signers(orderId)).toEqual([[UPLOADER, 'UPLOAD', 'T']]);
      expect(forwardingInfo(orderId)).toEqual([signatureHoldInfo('T')]);

      const veu = veuOf(orderId);
      expect(veu.signatures).toEqual([]);
      expect(distinctSigners(veu)).toBe(0);
      expect(hasRequiredSignatures(veu)).toBe(false);
      expect(isReleasable(veu)).toBe(false);
      expect(numSigRequired(veu)).toBe(1);
      expect(canSign(veu, { userId: UPLOADER, signatureClass: 'T' })).toBe(false);
      expect(canSign(veu, { userId: SIGNER, signatureClass: 'E' })).toBe(true);

      expect(sign(orderId, SIGNER).released).toBe(true);
      for (const order of orders) {
        expect(orderStatus(order.id)).toBe('EXECUTED');
        expect(statuses(order.id)).toEqual(['ACTC', 'ACSC']);
      }
      expect(balance(debtor)).toBe(1_000_000 - 2 * 1234);
      expect(signers(orderId)).toEqual([[UPLOADER, 'UPLOAD', 'T'], [SIGNER, 'HVE', 'E']]);
    });

    it('waits for a second user when the first signature has class A', () => {
      setClass(SIGNER, 'A');
      setClass(THIRD, 'B');
      const { orderId, orders } = receive('TA');

      expect(sign(orderId, SIGNER).released).toBe(false);
      const pending = veuOf(orderId);
      expect(pending.signatures.map((s) => [s.userId, s.signatureClass])).toEqual([[SIGNER, 'A']]);
      expect(distinctSigners(pending)).toBe(1);
      expect(numSigRequired(pending)).toBe(2);
      expect(orderStatus(orders[0]!.id)).toBe('PENDING_EDS');

      expect(sign(orderId, THIRD).released).toBe(true);
      expect(orderStatus(orders[0]!.id)).toBe('EXECUTED');
    });

    it('refuses HVE and HVS by class T users with 090003 and records nothing', () => {
      setClass(SIGNER, 'T');
      const { orderId, orders } = receive('TSIGN');

      for (const userId of [UPLOADER, SIGNER]) {
        const signError = veuError(() => sign(orderId, userId));
        expect(signError.returnCode, userId).toBe(ReturnCode.EBICS_AUTHORISATION_ORDER_TYPE_FAILED);
        expect(signError.returnCode, userId).toBe('090003');
        expect(veuError(() => cancel(orderId, userId)).returnCode, userId).toBe('090003');
      }

      expect(signers(orderId)).toEqual([[UPLOADER, 'UPLOAD', 'T']]);
      expect(veuActionEvents()).toEqual([]);
      expect(actions(orderId)).toEqual(['FILE_UPLOAD', 'ES_VERIFICATION', 'VEU_FORWARDING']);
      expect(orderStatus(orders[0]!.id)).toBe('PENDING_EDS');
      expect(statuses(orders[0]!.id)).toEqual(['ACTC']);
      expect(balance(debtor)).toBe(1_000_000);
    });
  });

  describe('canSign', () => {
    it('allows users with class E, A or B who have not signed yet and never class T', () => {
      setClass(UPLOADER, 'A');
      const veu = veuOf(receive('CAN').orderId);
      for (const signatureClass of ['E', 'A', 'B'] as const) {
        expect(canSign(veu, { userId: SIGNER, signatureClass }), signatureClass).toBe(true);
        expect(canSign(veu, { userId: UPLOADER, signatureClass }), signatureClass).toBe(false);
      }
      expect(canSign(veu, { userId: SIGNER, signatureClass: 'T' })).toBe(false);
    });

    it('lets a user who already signed sign again only while a VoP confirmation is pending', () => {
      process.env['EBICS_VOP_CONFIRMATION'] = 'true';
      setClass(UPLOADER, 'A');
      const { orderId } = receive('CAN-VOP', { creditorName: 'Alice Wunderland' });

      const pending = veuOf(orderId);
      expect(canSign(pending, { userId: UPLOADER, signatureClass: 'A' })).toBe(true);
      expect(canSign(pending, { userId: UPLOADER, signatureClass: 'T' })).toBe(false);

      sign(orderId, UPLOADER);
      const confirmed = veuOf(orderId);
      expect(canSign(confirmed, { userId: UPLOADER, signatureClass: 'A' })).toBe(false);
      expect(canSign(confirmed, { userId: SIGNER, signatureClass: 'B' })).toBe(true);
    });
  });

  describe('signature class changes after signing', () => {
    it('keep the stored classes and the authorisation state of a B + B order', () => {
      setClass(UPLOADER, 'B');
      setClass(SIGNER, 'B');
      setClass(THIRD, 'A');
      const { orderId, orders } = receive('CHANGE');
      expect(sign(orderId, SIGNER).released).toBe(false);

      setClass(UPLOADER, 'E');
      setClass(SIGNER, 'E');
      expect(store.getSubscriber(PARTNER_ID, SIGNER)!.signatureClass).toBe('E');
      expect(signers(orderId)).toEqual([[UPLOADER, 'UPLOAD', 'B'], [SIGNER, 'HVE', 'B']]);
      const veu = veuOf(orderId);
      expect(hasRequiredSignatures(veu)).toBe(false);
      expect(numSigRequired(veu)).toBe(3);
      expect(orderStatus(orders[0]!.id)).toBe('PENDING_EDS');
      expect(veuError(() => sign(orderId, SIGNER)).returnCode).toBe('091306');

      expect(sign(orderId, THIRD).released).toBe(true);
      expect(signers(orderId).map((s) => s[2])).toEqual(['B', 'B', 'A']);
    });

    it('a class A signature still counts after the signer is changed to class T', () => {
      setClass(UPLOADER, 'T');
      setClass(SIGNER, 'A');
      setClass(THIRD, 'B');
      const { orderId, orders } = receive('DEMOTE');
      expect(sign(orderId, SIGNER).released).toBe(false);

      setClass(SIGNER, 'T');
      expect(veuOf(orderId).signatures.map((s) => [s.userId, s.signatureClass])).toEqual([[SIGNER, 'A']]);

      expect(sign(orderId, THIRD).released).toBe(true);
      expect(orderStatus(orders[0]!.id)).toBe('EXECUTED');
      expect(signers(orderId)).toEqual([[UPLOADER, 'UPLOAD', 'T'], [SIGNER, 'HVE', 'A'], [THIRD, 'HVE', 'B']]);
    });

    it('a class T uploader changed to class E can sign the order itself; the upload signature stays T', () => {
      setClass(UPLOADER, 'T');
      const { orderId, orders } = receive('PROMOTE');
      setClass(UPLOADER, 'E');

      const veu = veuOf(orderId);
      expect(veu.signatures).toEqual([]);
      expect(canSign(veu, store.getSubscriber(PARTNER_ID, UPLOADER)!)).toBe(true);

      expect(sign(orderId, UPLOADER).released).toBe(true);
      expect(orderStatus(orders[0]!.id)).toBe('EXECUTED');
      expect(signers(orderId)).toEqual([[UPLOADER, 'UPLOAD', 'T'], [UPLOADER, 'HVE', 'E']]);
    });
  });

  describe('VoP confirmation hold', () => {
    beforeEach(() => {
      process.env['EBICS_VOP_CONFIRMATION'] = 'true';
    });

    it('holds a transfer whose payee name does not match until an HVE confirms it; the class E uploader may confirm', () => {
      const { orderId, orders } = receive('VOP', { creditorName: 'Alice Wunderland' });
      expect(orders[0]).toMatchObject({ status: 'PENDING_EDS', vopConfirmationRequired: true });
      expect(store.listPaymentTransactions(orders[0]!.id)[0]!.vopStatus).toBe('RVNM');
      const forwarding = ownEvents(orderId).find((e) => e.action === 'VEU_FORWARDING')!;
      expect(forwarding.reasonCode).toBe('DS06');
      expect(forwarding.additionalInfo).toEqual([VOP_NO_MATCH]);

      const veu = veuOf(orderId);
      expect(veu).toMatchObject({ vopConfirmationRequired: true, vopConfirmed: false });
      expect(veu.signatures.map((s) => [s.userId, s.signatureClass])).toEqual([[UPLOADER, 'E']]);
      expect(distinctSigners(veu)).toBe(1);
      expect(hasRequiredSignatures(veu)).toBe(true);
      expect(numSigRequired(veu)).toBe(2);
      expect(isReleasable(veu)).toBe(false);

      const result = sign(orderId, UPLOADER);
      expect(result.released).toBe(true);
      expect(orderStatus(orders[0]!.id)).toBe('EXECUTED');
      expect(statuses(orders[0]!.id)).toEqual(['ACTC', 'ACSC']);
      expect(signers(orderId)).toEqual([[UPLOADER, 'UPLOAD', 'E'], [UPLOADER, 'HVE', 'E']]);
      expect(actions(orderId).slice(-2)).toEqual(['VEU_VERIFICATION_END', 'ORDER_HAC_FINAL_POS']);
    });

    it('holds a close match as well and accepts the confirmation from another user', () => {
      const { orderId, orders } = receive('CLOSE', { creditorName: 'Mustermann Bob' });
      expect(store.listPaymentTransactions(orders[0]!.id)[0]!.vopStatus).toBe('RVMC');
      expect(orders[0]!.status).toBe('PENDING_EDS');
      expect(forwardingInfo(orderId)).toEqual(['Empfaengerueberpruefung RVMC: Bestaetigung per Unterschrift erforderlich']);
      expect(sign(orderId, SIGNER).released).toBe(true);
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

    it('with a class A uploader, the confirmation does not replace the second signer', () => {
      setClass(UPLOADER, 'A');
      const { orderId, orders } = receive('BOTH', { creditorName: 'Alice Wunderland' });
      expect(forwardingInfo(orderId)).toEqual([signatureHoldInfo('A'), VOP_NO_MATCH]);
      const pending = veuOf(orderId);
      expect(pending).toMatchObject({ vopConfirmationRequired: true, vopConfirmed: false });
      expect(hasRequiredSignatures(pending)).toBe(false);
      expect(numSigRequired(pending)).toBe(2);

      expect(sign(orderId, UPLOADER).released).toBe(false);
      const confirmed = veuOf(orderId);
      expect(confirmed.vopConfirmed).toBe(true);
      expect(distinctSigners(confirmed)).toBe(1);
      expect(hasRequiredSignatures(confirmed)).toBe(false);
      expect(isReleasable(confirmed)).toBe(false);
      expect(orderStatus(orders[0]!.id)).toBe('PENDING_EDS');

      expect(veuError(() => sign(orderId, UPLOADER)).returnCode).toBe('091306');
      expect(sign(orderId, SIGNER).released).toBe(true);
      expect(orderStatus(orders[0]!.id)).toBe('EXECUTED');
    });

    // NumSigRequired is "the total number of signatures required for release": an order that is still pending
    // must report more than NumSigDone, also after the uploader confirmed the VoP result.
    it('reports NumSigRequired above the signatures done while the order is still pending', () => {
      setClass(UPLOADER, 'A');
      const { orderId } = receive('COUNT', { creditorName: 'Alice Wunderland' });
      sign(orderId, UPLOADER);
      const veu = veuOf(orderId);
      expect(isReleasable(veu)).toBe(false);
      expect(veu.signatures).toHaveLength(2);
      expect(numSigRequired(veu)).toBe(3);
    });

    it.each(['E', 'B'] as const)('with a class A uploader, one HVE by a class %s user confirms the VoP result and authorises the order', (signatureClass) => {
      setClass(UPLOADER, 'A');
      setClass(SIGNER, signatureClass);
      const { orderId, orders } = receive(`VOP-A-${signatureClass}`, { creditorName: 'Alice Wunderland' });
      expect(sign(orderId, SIGNER).released).toBe(true);
      expect(orderStatus(orders[0]!.id)).toBe('EXECUTED');
    });

    it('a class T user cannot confirm the VoP result', () => {
      setClass(SIGNER, 'T');
      const { orderId, orders } = receive('VOP-T', { creditorName: 'Alice Wunderland' });
      expect(veuError(() => sign(orderId, SIGNER)).returnCode).toBe('090003');
      expect(veuOf(orderId).vopConfirmed).toBe(false);
      expect(orderStatus(orders[0]!.id)).toBe('PENDING_EDS');
      expect(signers(orderId)).toEqual([[UPLOADER, 'UPLOAD', 'E']]);
    });

    // Without SignatureFlag the order is authorised outside EBICS: it only waits for the VoP confirmation,
    // which any user with class E, A or B gives alone.
    it.each(['A', 'B'] as const)('an upload without SignatureFlag is released by one class %s confirmation', (signatureClass) => {
      setClass(UPLOADER, 'T');
      setClass(SIGNER, signatureClass);
      const { orderId, orders } = receive(`VOP-NOFLAG-${signatureClass}`, {
        requestEds: false,
        signatureFlag: false,
        creditorName: 'Alice Wunderland',
      });
      expect(orders[0]).toMatchObject({ status: 'PENDING_EDS', requestedEds: false, vopConfirmationRequired: true });
      expect(forwardingInfo(orderId)).toEqual([VOP_NO_MATCH]);

      const pending = veuOf(orderId);
      expect(pending).toMatchObject({ signaturesNeeded: false, signatures: [] });
      expect(hasRequiredSignatures(pending)).toBe(true);
      expect(isReleasable(pending)).toBe(false);
      expect(numSigRequired(pending)).toBe(1);

      expect(sign(orderId, SIGNER).released).toBe(true);
      expect(orderStatus(orders[0]!.id)).toBe('EXECUTED');
      expect(signers(orderId)).toEqual([
        [UPLOADER, 'UPLOAD', 'T'],
        [SIGNER, 'HVE', signatureClass],
      ]);
    });
  });
});
