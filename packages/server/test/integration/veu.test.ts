import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp, postEbics, PARTNER_ID, USER_ID } from '../helpers/test-server.js';
import {
  buildPain001Document,
  hvdOrderParams,
  hvtOrderParams,
  hvzOrderParams,
  readBusinessReturnCode,
  type VeuOrderRef,
} from '../helpers/test-client.js';
import {
  downloadWithOrderParams,
  enrolSubscriber,
  localAttribute,
  localAttributes,
  localTexts,
  sendVeuSignature,
  uploadOrder,
  type EbicsSession,
  type PostXml,
} from '../helpers/ebics-session.js';
import { orderDataDigest } from '../../src/banking/veu.js';
import { calculateIban } from '../../src/banking/iban.js';
import { validateXml } from '../../src/protocol/xml-validator.js';
import type { SqliteStore } from '../../src/store/sqlite-store.js';
import type { Account, SignatureClass } from '../../src/store/types.js';

const SECOND_USER = 'USER2';
const THIRD_USER = 'USER3';
const OTHER_PARTNER = 'PARTNER9';
const UNKNOWN_ORDER_ID = 'Z999';
const ORDER_ID = /^[A-Z][A-Z0-9]{3}$/;
const FLAGS = ['EBICS_VOP_CONFIRMATION', 'EBICS_VOP_DEFAULT', 'EBICS_HAC_FORMAT', 'EBICS_HAC_DOWNLOAD_EVENTS'] as const;
const VOP_NO_MATCH = 'Empfaengerueberpruefung RVNM: Bestaetigung per Unterschrift erforderlich';

interface Ctx {
  app: ReturnType<typeof createTestApp>['app'];
  store: SqliteStore;
  post: PostXml;
  activate: (partnerId: string, userId: string) => Promise<unknown>;
  /** USER1: uploads the orders */
  uploader: EbicsSession;
  /** USER2 of the same partner: second signer */
  signer: EbicsSession;
  debtor: Account;
  creditor: Account;
}

async function setup(): Promise<Ctx> {
  const { app, store } = createTestApp();
  const post = async (xml: string) => (await postEbics(app, xml)).text();
  const activate = (partnerId: string, userId: string) => app.request(`/api/subscribers/${partnerId}/${userId}/activate`, { method: 'POST' });
  const uploader = await enrolSubscriber({ post, activate, store, partnerId: PARTNER_ID, userId: USER_ID });
  const signer = await enrolSubscriber({ post, activate, store, partnerId: PARTNER_ID, userId: SECOND_USER });

  const debtor = store.listAccountsForPartner(PARTNER_ID)[0]!;
  store.createBooking({ accountId: debtor.id, amountCents: 1_000_000, currency: 'EUR', valueDate: '2025-01-01', bookingDate: '2025-01-01', transactionCode: 'NTRF' });
  const bob = store.createPerson({ name: 'Bob Mustermann', country: 'DE' });
  const accountNumber = store.getNextAccountSequence().toString().padStart(10, '0');
  const creditor = store.createAccount({ personId: bob.id, iban: calculateIban('10020030', accountNumber), accountNumber, currency: 'EUR', name: 'Bob Konto' });

  return { app, store, post, activate, uploader, signer, debtor, creditor };
}

function pain001(ctx: Ctx, id: string, options: { pmtInfs?: number; creditorName?: string } = {}): string {
  return buildPain001Document({
    msgId: `MSG-${id}`,
    payments: Array.from({ length: options.pmtInfs ?? 1 }, (_, i) => ({
      pmtInfId: `PMT-${id}-${i + 1}`,
      debtorName: 'Musterfirma GmbH',
      debtorIban: ctx.debtor.iban,
      transactions: [
        { endToEndId: `E2E-${id}-${i + 1}`, creditorName: options.creditorName ?? 'Bob Mustermann', creditorIban: ctx.creditor.iban, amount: '12.34' },
      ],
    })),
  });
}

/** pain.001 upload by USER1 (SCI, requestEDS) */
async function uploadTransfer(ctx: Ctx, id: string, options: { pmtInfs?: number; creditorName?: string; requestEds?: boolean } = {}) {
  const content = pain001(ctx, id, options);
  const upload = await uploadOrder(ctx.uploader, content, {
    upload: { scope: 'DE', serviceOption: 'VOI', requestEds: options.requestEds ?? true },
  });
  expect(readBusinessReturnCode(upload.transferBody)).toBe('000000');
  const orderId = upload.orderId!;
  const ref: VeuOrderRef = { partnerId: PARTNER_ID, orderId, serviceName: 'SCI', scope: 'DE', serviceOption: 'VOI', msgName: 'pain.001' };
  return { content, orderId, ref };
}

async function api<T = any>(ctx: Ctx, path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; json: T }> {
  const res = await ctx.app.request(`/api${path}`, {
    method: init?.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, json: (await res.json()) as T };
}

/** Changes a subscriber's signature class through the admin API */
async function setSignatureClass(ctx: Ctx, userId: string, signatureClass: SignatureClass): Promise<void> {
  const res = await api(ctx, `/subscribers/${PARTNER_ID}/${userId}`, { method: 'PATCH', body: { signatureClass } });
  expect(res.status).toBe(200);
  expect(res.json).toMatchObject({ partnerId: PARTNER_ID, userId, signatureClass });
}

/** Creates USER3 through the admin API with the given signature class */
async function createThirdUser(ctx: Ctx, signatureClass: SignatureClass): Promise<void> {
  const created = await api(ctx, '/subscribers', { method: 'POST', body: { partnerId: PARTNER_ID, userId: THIRD_USER, signatureClass } });
  expect(created.status).toBeLessThan(300);
  expect(created.json).toMatchObject({ partnerId: PARTNER_ID, userId: THIRD_USER, signatureClass });
}

/** Creates USER3 with the given signature class and enrols it (INI, HIA, activation, HPB) */
async function enrolThirdUser(ctx: Ctx, signatureClass: SignatureClass): Promise<EbicsSession> {
  await createThirdUser(ctx, signatureClass);
  const session = await enrolSubscriber({ post: ctx.post, activate: ctx.activate, store: ctx.store, partnerId: PARTNER_ID, userId: THIRD_USER });
  expect(ctx.store.getSubscriber(PARTNER_ID, THIRD_USER)!.signatureClass).toBe(signatureClass);
  return session;
}

describe('VEU (distributed electronic signature)', () => {
  let ctx: Ctx;
  const saved: Record<string, string | undefined> = {};

  const orderStatuses = (orderId: string) => ctx.store.listPaymentOrders({ partnerId: PARTNER_ID, orderId }).map((o) => o.status);
  /** All stored signatures of the order, including transport signatures: [userId, kind, signatureClass] */
  const signatures = (orderId: string) => ctx.store.listOrderSignatures(PARTNER_ID, orderId).map((s) => [s.userId, s.kind, s.signatureClass]);
  const veuActionEvents = () => ctx.store.listHacEvents({ partnerId: PARTNER_ID }).filter((e) => e.adminOrderType === 'HVE' || e.adminOrderType === 'HVS');
  const hvz = (session: EbicsSession) => downloadWithOrderParams(session, 'HVZ', hvzOrderParams());
  const hvzXml = async (session: EbicsSession) => {
    const result = await hvz(session);
    expect(result.code).toBe('000000');
    const xml = result.data!.toString('utf8');
    expect(() => validateXml(xml, 'response')).not.toThrow();
    return xml;
  };

  beforeEach(async () => {
    for (const flag of FLAGS) {
      saved[flag] = process.env[flag];
      delete process.env[flag];
    }
    ctx = await setup();
    // USER1 signs with class A: its uploads requesting EDS wait in the VEU for a second signature
    ctx.store.updateSubscriberSettings(PARTNER_ID, USER_ID, { signatureClass: 'A' });
  });

  afterEach(() => {
    for (const flag of FLAGS) {
      if (saved[flag] === undefined) delete process.env[flag];
      else process.env[flag] = saved[flag];
    }
  });

  describe('HVZ', () => {
    it('answers 090005 when no order waits for signatures', async () => {
      expect((await hvz(ctx.uploader)).code).toBe('090005');
      // Without SignatureFlag the order is authorised outside EBICS and executed
      const { orderId } = await uploadTransfer(ctx, 'NOEDS', { requestEds: false });
      expect(orderStatuses(orderId)).toEqual(['EXECUTED']);
      expect(signatures(orderId)).toEqual([[USER_ID, 'UPLOAD', 'T']]);
      expect((await hvz(ctx.signer)).code).toBe('090005');
    });

    it('lists the order with service, digest, signing state, signers, originator and payment summary', async () => {
      const { content, orderId } = await uploadTransfer(ctx, 'HVZ', { pmtInfs: 2 });

      const xml = await hvzXml(ctx.signer);

      expect(localTexts(xml, 'OrderDetails')).toHaveLength(1);
      expect(localTexts(xml, 'OrderDetails/OrderID')).toEqual([orderId]);
      expect(localTexts(xml, 'OrderDetails/Service/ServiceName')).toEqual(['SCI']);
      expect(localTexts(xml, 'OrderDetails/Service/Scope')).toEqual(['DE']);
      expect(localTexts(xml, 'OrderDetails/Service/ServiceOption')).toEqual(['VOI']);
      expect(localTexts(xml, 'OrderDetails/Service/MsgName')).toEqual(['pain.001']);
      expect(localTexts(xml, 'OrderDetails/DataDigest')).toEqual([orderDataDigest(content)]);
      expect(localAttribute(xml, 'DataDigest', 'SignatureVersion')).toBe('A006');
      expect(localTexts(xml, 'OrderDetails/OrderDataAvailable')).toEqual(['true']);
      expect(localTexts(xml, 'OrderDetails/OrderDataSize')).toEqual([String(Buffer.byteLength(content))]);

      expect(localAttribute(xml, 'SigningInfo', 'readyToBeSigned')).toBe('true');
      expect(localAttribute(xml, 'SigningInfo', 'NumSigRequired')).toBe('2');
      expect(localAttribute(xml, 'SigningInfo', 'NumSigDone')).toBe('1');
      expect(localTexts(xml, 'OrderDetails/SignerInfo/PartnerID')).toEqual([PARTNER_ID]);
      expect(localTexts(xml, 'OrderDetails/SignerInfo/UserID')).toEqual([USER_ID]);
      expect(localAttributes(xml, 'Permission', 'AuthorisationLevel')).toEqual(['A']);
      expect(localTexts(xml, 'OrderDetails/OriginatorInfo/PartnerID')).toEqual([PARTNER_ID]);
      expect(localTexts(xml, 'OrderDetails/OriginatorInfo/UserID')).toEqual([USER_ID]);
      expect(localTexts(xml, 'OrderDetails/OriginatorInfo/Timestamp')[0]).not.toBe('');

      expect(localTexts(xml, 'OrderDetails/TotalOrders')).toEqual(['2']);
      expect(localTexts(xml, 'OrderDetails/TotalAmount')).toEqual(['24.68']);
      expect(localAttribute(xml, 'TotalAmount', 'isCredit')).toBe('false');
      expect(localTexts(xml, 'OrderDetails/Currency')).toEqual(['EUR']);
      expect(localTexts(xml, 'FirstOrderInfo/OrderPartyInfo')).toEqual(['Bob Mustermann']);
      expect(localTexts(xml, 'FirstOrderInfo/AccountInfo/AccountNumber')).toEqual([ctx.creditor.iban]);
      expect(localAttribute(xml, 'AccountNumber', 'international')).toBe('true');
      expect(localTexts(xml, 'FirstOrderInfo/AccountInfo/BankCode')).toEqual(['ETBADE2AXXX']);

      // The overview covers the whole partner, so the uploader sees the same order
      const own = await hvz(ctx.uploader);
      expect(localTexts(own.data!.toString('utf8'), 'OrderDetails/OrderID')).toEqual([orderId]);
    });

    // HVUSigningInfoType/@readyToBeSigned: "true" if the order can be signed, "false" if the requesting
    // subscriber already signed it.
    it('reports readyToBeSigned="false" to a user who already signed the order', async () => {
      await uploadTransfer(ctx, 'READY');
      const own = await hvz(ctx.uploader);
      expect(localAttribute(own.data!.toString('utf8'), 'SigningInfo', 'readyToBeSigned')).toBe('false');
    });

    it("reports each signer's class as AuthorisationLevel; B + B waits for a class A signer", async () => {
      await setSignatureClass(ctx, USER_ID, 'B');
      await setSignatureClass(ctx, SECOND_USER, 'B');
      const { content, orderId, ref } = await uploadTransfer(ctx, 'HVZ-BB');

      const second = await sendVeuSignature(ctx.signer, 'HVE', ref, { dataDigest: orderDataDigest(content) });
      expect(second.code).toBe('000000');
      expect(second.orderId).toMatch(ORDER_ID);
      expect(orderStatuses(orderId)).toEqual(['PENDING_EDS']);

      const third = await enrolThirdUser(ctx, 'A');
      const xml = await hvzXml(third);
      expect(localTexts(xml, 'OrderDetails/SignerInfo/UserID')).toEqual([USER_ID, SECOND_USER]);
      expect(localAttributes(xml, 'Permission', 'AuthorisationLevel')).toEqual(['B', 'B']);
      expect(localAttribute(xml, 'SigningInfo', 'NumSigDone')).toBe('2');
      expect(localAttribute(xml, 'SigningInfo', 'NumSigRequired')).toBe('3');
      expect(localAttribute(xml, 'SigningInfo', 'readyToBeSigned')).toBe('true');
      expect(localAttribute(await hvzXml(ctx.signer), 'SigningInfo', 'readyToBeSigned')).toBe('false');
      expect((await sendVeuSignature(ctx.signer, 'HVE', ref)).code).toBe('091306');

      const released = await sendVeuSignature(third, 'HVE', ref, { dataDigest: orderDataDigest(content) });
      expect(released.code).toBe('000000');
      expect(orderStatuses(orderId)).toEqual(['EXECUTED']);
      expect(signatures(orderId)).toEqual([[USER_ID, 'UPLOAD', 'B'], [SECOND_USER, 'HVE', 'B'], [THIRD_USER, 'HVE', 'A']]);
      expect((await hvz(third)).code).toBe('090005');
    });

    it('class T uploader: the transport signature is not listed, NumSigDone starts at 0 and the T user is not ready to sign', async () => {
      await setSignatureClass(ctx, USER_ID, 'T');
      const { content, orderId, ref } = await uploadTransfer(ctx, 'HVZ-T');
      expect(orderStatuses(orderId)).toEqual(['PENDING_EDS']);
      expect(signatures(orderId)).toEqual([[USER_ID, 'UPLOAD', 'T']]);
      const forwarding = ctx.store.listHacEvents({ partnerId: PARTNER_ID, orderId }).find((e) => e.action === 'VEU_FORWARDING')!;
      expect(forwarding.additionalInfo).toEqual(['Unterschriftsklasse T: weitere Unterschrift erforderlich']);

      const own = await hvzXml(ctx.uploader);
      expect(localTexts(own, 'OrderDetails/OrderID')).toEqual([orderId]);
      expect(localAttribute(own, 'SigningInfo', 'readyToBeSigned')).toBe('false');
      expect(localAttribute(own, 'SigningInfo', 'NumSigDone')).toBe('0');
      expect(localAttribute(own, 'SigningInfo', 'NumSigRequired')).toBe('1');
      expect(localTexts(own, 'OrderDetails/SignerInfo')).toEqual([]);
      expect(localTexts(own, 'OrderDetails/OriginatorInfo/UserID')).toEqual([USER_ID]);

      expect(localAttribute(await hvzXml(ctx.signer), 'SigningInfo', 'readyToBeSigned')).toBe('true');

      const details = await downloadWithOrderParams(ctx.signer, 'HVD', hvdOrderParams(ref));
      expect(details.code).toBe('000000');
      const hvdXml = details.data!.toString('utf8');
      expect(() => validateXml(hvdXml, 'response')).not.toThrow();
      expect(localTexts(hvdXml, 'SignerInfo')).toEqual([]);

      const released = await sendVeuSignature(ctx.signer, 'HVE', ref, { dataDigest: orderDataDigest(content) });
      expect(released.code).toBe('000000');
      expect(orderStatuses(orderId)).toEqual(['EXECUTED']);
      expect(signatures(orderId)).toEqual([[USER_ID, 'UPLOAD', 'T'], [SECOND_USER, 'HVE', 'E']]);
    });
  });

  describe('HVD', () => {
    it('returns the digest, the display file with the Sammlerreferenz and the signers', async () => {
      const { content, ref } = await uploadTransfer(ctx, 'HVD');

      const result = await downloadWithOrderParams(ctx.signer, 'HVD', hvdOrderParams(ref));
      expect(result.code).toBe('000000');
      const xml = result.data!.toString('utf8');
      expect(() => validateXml(xml, 'response')).not.toThrow();

      expect(localTexts(xml, 'HVDResponseOrderData/DataDigest')).toEqual([orderDataDigest(content)]);
      expect(localAttribute(xml, 'DataDigest', 'SignatureVersion')).toBe('A006');
      const display = Buffer.from(localTexts(xml, 'DisplayFile')[0]!, 'base64').toString('utf8').split('\n');
      expect(display).toContain('Sammlerreferenz          : PMT-HVD-1');
      expect(display).toContain(`Kontonummer              : ${ctx.debtor.iban}`);
      expect(display).toContain('Summe der Betraege (EUR) : 12,34');
      expect(localTexts(xml, 'OrderDataAvailable')).toEqual(['true']);
      expect(localTexts(xml, 'OrderDataSize')).toEqual([String(Buffer.byteLength(content))]);
      expect(localTexts(xml, 'SignerInfo/UserID')).toEqual([USER_ID]);
      expect(localAttributes(xml, 'Permission', 'AuthorisationLevel')).toEqual(['A']);
    });
  });

  describe('HVT', () => {
    it('returns the uploaded pain.001 with completeOrderData="true"', async () => {
      const { content, ref } = await uploadTransfer(ctx, 'HVT');
      const result = await downloadWithOrderParams(ctx.signer, 'HVT', hvtOrderParams(ref, { completeOrderData: true }));
      expect(result.code).toBe('000000');
      expect(result.data!.toString('utf8')).toBe(content);
    });

    it('answers 091112 without completeOrderData', async () => {
      const { ref } = await uploadTransfer(ctx, 'HVT-DETAILS');
      const result = await downloadWithOrderParams(ctx.signer, 'HVT', hvtOrderParams(ref, { completeOrderData: false }));
      expect(result.code).toBe('091112');
    });
  });

  describe('HVE', () => {
    it('rejects a second signature by the uploader with 091306', async () => {
      const { content, orderId, ref } = await uploadTransfer(ctx, 'HVE-DUP');
      const result = await sendVeuSignature(ctx.uploader, 'HVE', ref, { dataDigest: orderDataDigest(content) });
      expect(result.technicalCode).toBe('000000');
      expect(result.code).toBe('091306');
      expect(result.orderId).toBeUndefined();
      expect(orderStatuses(orderId)).toEqual(['PENDING_EDS']);
      expect(ctx.store.listOrderSignatures(PARTNER_ID, orderId)).toHaveLength(1);
    });

    it("releases the order with the second user's signature", async () => {
      const { content, orderId, ref } = await uploadTransfer(ctx, 'HVE', { pmtInfs: 2 });

      const result = await sendVeuSignature(ctx.signer, 'HVE', ref, { dataDigest: orderDataDigest(content) });
      expect(result.technicalCode).toBe('000000');
      expect(result.code).toBe('000000');
      expect(result.orderId).toMatch(ORDER_ID);
      expect(result.orderId).not.toBe(orderId);

      expect(orderStatuses(orderId)).toEqual(['EXECUTED', 'EXECUTED']);
      for (const order of ctx.store.listPaymentOrders({ orderId })) {
        expect(ctx.store.listPaymentStatusEvents({ paymentOrderId: order.id }).map((e) => e.status)).toEqual(['ACTC', 'ACSC']);
      }
      expect(ctx.store.getAccount(ctx.debtor.id)!.currentBalanceCents).toBe(1_000_000 - 2 * 1234);
      expect(signatures(orderId)).toEqual([[USER_ID, 'UPLOAD', 'A'], [SECOND_USER, 'HVE', 'E']]);

      const hve = ctx.store.listHacEvents({ partnerId: PARTNER_ID, orderId: result.orderId });
      expect(hve.map((e) => [e.action, e.reasonCode, e.userId, e.adminOrderType, e.orderIdRef, e.adminOrderTypeRef])).toEqual([
        ['ES_UPLOAD', 'TS01', SECOND_USER, 'HVE', orderId, 'BTU'],
        ['ES_VERIFICATION', 'DS01', SECOND_USER, 'HVE', orderId, 'BTU'],
      ]);
      expect(ctx.store.listHacEvents({ partnerId: PARTNER_ID, orderId }).map((e) => e.action).slice(-2)).toEqual(['VEU_VERIFICATION_END', 'ORDER_HAC_FINAL_POS']);

      expect((await hvz(ctx.signer)).code).toBe('090005');
      expect((await sendVeuSignature(ctx.signer, 'HVE', ref)).code).toBe('091114');
      expect((await downloadWithOrderParams(ctx.signer, 'HVD', hvdOrderParams(ref))).code).toBe('091114');
    });

    it('releases an A upload with the signature of a class B user', async () => {
      await setSignatureClass(ctx, SECOND_USER, 'B');
      const { orderId, ref } = await uploadTransfer(ctx, 'HVE-B');
      expect(localAttribute(await hvzXml(ctx.signer), 'SigningInfo', 'readyToBeSigned')).toBe('true');

      expect((await sendVeuSignature(ctx.signer, 'HVE', ref)).code).toBe('000000');
      expect(orderStatuses(orderId)).toEqual(['EXECUTED']);
      expect(signatures(orderId)).toEqual([[USER_ID, 'UPLOAD', 'A'], [SECOND_USER, 'HVE', 'B']]);
    });

    it('refuses a signature by a class T user with 090003 and records nothing', async () => {
      await setSignatureClass(ctx, SECOND_USER, 'T');
      const { content, orderId, ref } = await uploadTransfer(ctx, 'HVE-T');

      const overview = await hvzXml(ctx.signer);
      expect(localTexts(overview, 'OrderDetails/OrderID')).toEqual([orderId]);
      expect(localAttribute(overview, 'SigningInfo', 'readyToBeSigned')).toBe('false');

      const result = await sendVeuSignature(ctx.signer, 'HVE', ref, { dataDigest: orderDataDigest(content) });
      expect(result.technicalCode).toBe('000000');
      expect(result.code).toBe('090003');
      expect(result.orderId).toBeUndefined();

      expect(orderStatuses(orderId)).toEqual(['PENDING_EDS']);
      expect(signatures(orderId)).toEqual([[USER_ID, 'UPLOAD', 'A']]);
      expect(veuActionEvents()).toEqual([]);
      expect(ctx.store.getAccount(ctx.debtor.id)!.currentBalanceCents).toBe(1_000_000);
    });
  });

  describe('HVS', () => {
    it('cancels the order and attributes the cancellation to the requesting user', async () => {
      const { orderId, ref } = await uploadTransfer(ctx, 'HVS');

      const result = await sendVeuSignature(ctx.signer, 'HVS', ref);
      expect(result.code).toBe('000000');
      expect(result.orderId).toMatch(ORDER_ID);
      expect(result.orderId).not.toBe(orderId);

      expect(orderStatuses(orderId)).toEqual(['CANCELLED']);
      const order = ctx.store.listPaymentOrders({ orderId })[0]!;
      expect(ctx.store.listPaymentStatusEvents({ paymentOrderId: order.id }).at(-1)).toMatchObject({ status: 'RJCT', reasonCode: 'DS02' });
      expect(ctx.store.getAccount(ctx.debtor.id)!.currentBalanceCents).toBe(1_000_000);

      const cancel = ctx.store.listHacEvents({ partnerId: PARTNER_ID, orderId: result.orderId });
      expect(cancel).toHaveLength(1);
      expect(cancel[0]).toMatchObject({ action: 'VEU_CANCEL_ORDER', adminOrderType: 'HVS', userId: SECOND_USER, orderIdRef: orderId, adminOrderTypeRef: 'BTU', reasonCode: 'DS02' });
      expect(ctx.store.listHacEvents({ partnerId: PARTNER_ID, orderId }).at(-1)!.action).toBe('ORDER_HAC_FINAL_POS');

      expect((await hvz(ctx.uploader)).code).toBe('090005');
      expect((await sendVeuSignature(ctx.signer, 'HVS', ref)).code).toBe('091114');
    });

    it('refuses a cancellation by a class T user with 090003 and cancels nothing', async () => {
      await setSignatureClass(ctx, USER_ID, 'T');
      const { orderId, ref } = await uploadTransfer(ctx, 'HVS-T');

      const result = await sendVeuSignature(ctx.uploader, 'HVS', ref);
      expect(result.technicalCode).toBe('000000');
      expect(result.code).toBe('090003');
      expect(result.orderId).toBeUndefined();

      expect(orderStatuses(orderId)).toEqual(['PENDING_EDS']);
      const order = ctx.store.listPaymentOrders({ orderId })[0]!;
      expect(ctx.store.listPaymentStatusEvents({ paymentOrderId: order.id }).map((e) => e.status)).toEqual(['ACTC']);
      expect(veuActionEvents()).toEqual([]);
      expect(ctx.store.listHacEvents({ partnerId: PARTNER_ID }).map((e) => e.action)).not.toContain('VEU_CANCEL_ORDER');
      expect((await hvz(ctx.signer)).code).toBe('000000');
    });
  });

  describe('error codes', () => {
    it('HVD and HVT: 091114 for unknown orders, 091120 for another partner', async () => {
      const { ref } = await uploadTransfer(ctx, 'ERR-DL');
      const params = {
        HVD: (r: VeuOrderRef) => hvdOrderParams(r),
        HVT: (r: VeuOrderRef) => hvtOrderParams(r, { completeOrderData: true }),
      };
      for (const [orderType, build] of Object.entries(params)) {
        expect((await downloadWithOrderParams(ctx.signer, orderType, build({ ...ref, orderId: UNKNOWN_ORDER_ID }))).code, orderType).toBe('091114');
        expect((await downloadWithOrderParams(ctx.signer, orderType, build({ ...ref, partnerId: OTHER_PARTNER }))).code, orderType).toBe('091120');
      }
    });

    it('HVE and HVS: 091114, 091120, 091304 for foreign signature data and 091111 for undecodable signature data', async () => {
      const { orderId, ref } = await uploadTransfer(ctx, 'ERR-SIG');
      for (const orderType of ['HVE', 'HVS'] as const) {
        expect((await sendVeuSignature(ctx.signer, orderType, { ...ref, orderId: UNKNOWN_ORDER_ID })).code, orderType).toBe('091114');
        expect((await sendVeuSignature(ctx.signer, orderType, { ...ref, partnerId: OTHER_PARTNER })).code, orderType).toBe('091120');
        expect((await sendVeuSignature(ctx.signer, orderType, ref, { signer: { partnerId: PARTNER_ID, userId: USER_ID } })).code, orderType).toBe('091304');
        expect((await sendVeuSignature(ctx.signer, orderType, ref, { signer: { partnerId: OTHER_PARTNER, userId: SECOND_USER } })).code, orderType).toBe('091304');
        expect((await sendVeuSignature(ctx.signer, orderType, ref, { compressSignatureData: false })).code, orderType).toBe('091111');
      }
      expect(orderStatuses(orderId)).toEqual(['PENDING_EDS']);
      expect(ctx.store.listOrderSignatures(PARTNER_ID, orderId)).toHaveLength(1);
    });
  });

  describe('class E uploader', () => {
    beforeEach(async () => {
      await setSignatureClass(ctx, USER_ID, 'E');
    });

    it('executes an upload requesting EDS immediately and leaves nothing in the VEU', async () => {
      const { orderId } = await uploadTransfer(ctx, 'E-EDS');
      expect(orderStatuses(orderId)).toEqual(['EXECUTED']);
      expect(ctx.store.getAccount(ctx.creditor.id)!.currentBalanceCents).toBe(1234);
      expect(signatures(orderId)).toEqual([[USER_ID, 'UPLOAD', 'E']]);
      expect(ctx.store.listHacEvents({ partnerId: PARTNER_ID, orderId }).map((e) => e.action)).not.toContain('VEU_FORWARDING');
      expect((await hvz(ctx.uploader)).code).toBe('090005');
      expect((await api(ctx, '/veu/orders')).json).toEqual([]);
    });

    it('executes an upload with SignatureFlag but without requestEDS; the same upload of a class A, B or T user is rejected with 091301', async () => {
      const upload = (id: string) =>
        uploadOrder(ctx.uploader, pain001(ctx, id), { upload: { scope: 'DE', serviceOption: 'VOI', signatureFlag: true, requestEds: false } });

      const accepted = await upload('FLAG-E');
      expect(accepted.initBody).toContain('<ReturnCode>000000</ReturnCode>');
      expect(readBusinessReturnCode(accepted.transferBody)).toBe('000000');
      expect(orderStatuses(accepted.orderId!)).toEqual(['EXECUTED']);
      expect(signatures(accepted.orderId!)).toEqual([[USER_ID, 'UPLOAD', 'E']]);

      for (const signatureClass of ['A', 'B', 'T'] as const) {
        await setSignatureClass(ctx, USER_ID, signatureClass);
        const rejected = await upload(`FLAG-${signatureClass}`);
        expect(readBusinessReturnCode(rejected.transferBody), signatureClass).toBe('091301');
        expect(orderStatuses(rejected.orderId!), signatureClass).toEqual([]);
        expect(signatures(rejected.orderId!), signatureClass).toEqual([]);
        const verification = ctx.store.listHacEvents({ partnerId: PARTNER_ID, orderId: rejected.orderId! }).find((e) => e.action === 'ES_VERIFICATION');
        expect(verification?.reasonCode, signatureClass).toBe('DS19');
      }
      expect((await hvz(ctx.uploader)).code).toBe('090005');
    });
  });

  describe('VoP confirmation hold', () => {
    beforeEach(() => {
      ctx.store.updateSubscriberSettings(PARTNER_ID, USER_ID, { signatureClass: 'E' });
      process.env['EBICS_VOP_CONFIRMATION'] = 'true';
    });

    it('holds a transfer to a creditor with a non-matching name until the uploader confirms it with HVE', async () => {
      const { orderId, ref } = await uploadTransfer(ctx, 'VOP', { creditorName: 'Alice Wunderland' });
      expect(orderStatuses(orderId)).toEqual(['PENDING_EDS']);
      const forwarding = ctx.store.listHacEvents({ partnerId: PARTNER_ID, orderId }).find((e) => e.action === 'VEU_FORWARDING')!;
      expect(forwarding.additionalInfo).toEqual([VOP_NO_MATCH]);

      const xml = await hvzXml(ctx.uploader);
      expect(localTexts(xml, 'OrderDetails/OrderID')).toEqual([orderId]);
      expect(localAttribute(xml, 'SigningInfo', 'NumSigRequired')).toBe('2');
      expect(localAttribute(xml, 'SigningInfo', 'NumSigDone')).toBe('1');
      expect(localAttribute(xml, 'SigningInfo', 'readyToBeSigned')).toBe('true');
      expect(localAttributes(xml, 'Permission', 'AuthorisationLevel')).toEqual(['E']);

      const result = await sendVeuSignature(ctx.uploader, 'HVE', ref);
      expect(result.code).toBe('000000');
      expect(result.orderId).toMatch(ORDER_ID);
      expect(orderStatuses(orderId)).toEqual(['EXECUTED']);
      expect(ctx.store.getAccount(ctx.creditor.id)!.currentBalanceCents).toBe(1234);
      expect((await hvz(ctx.uploader)).code).toBe('090005');
    });

    it('executes a transfer with a matching name immediately', async () => {
      const { orderId } = await uploadTransfer(ctx, 'VOP-MATCH');
      expect(orderStatuses(orderId)).toEqual(['EXECUTED']);
      expect((await hvz(ctx.uploader)).code).toBe('090005');
    });

    it("with a class A uploader, the uploader's confirmation still needs a second user's signature", async () => {
      await setSignatureClass(ctx, USER_ID, 'A');
      const { orderId, ref } = await uploadTransfer(ctx, 'VOP-A', { creditorName: 'Alice Wunderland' });
      expect(orderStatuses(orderId)).toEqual(['PENDING_EDS']);
      const forwarding = ctx.store.listHacEvents({ partnerId: PARTNER_ID, orderId }).find((e) => e.action === 'VEU_FORWARDING')!;
      expect(forwarding.additionalInfo).toEqual(['Unterschriftsklasse A: weitere Unterschrift erforderlich', VOP_NO_MATCH]);

      let xml = await hvzXml(ctx.uploader);
      expect(localAttribute(xml, 'SigningInfo', 'readyToBeSigned')).toBe('true');
      expect(localAttribute(xml, 'SigningInfo', 'NumSigRequired')).toBe('2');
      expect(localAttribute(xml, 'SigningInfo', 'NumSigDone')).toBe('1');

      expect((await sendVeuSignature(ctx.uploader, 'HVE', ref)).code).toBe('000000');
      expect(orderStatuses(orderId)).toEqual(['PENDING_EDS']);

      xml = await hvzXml(ctx.uploader);
      expect(localAttribute(xml, 'SigningInfo', 'readyToBeSigned')).toBe('false');
      expect(localAttribute(xml, 'SigningInfo', 'NumSigDone')).toBe('2');
      expect(localAttribute(xml, 'SigningInfo', 'NumSigRequired')).toBe('3');
      expect(localTexts(xml, 'OrderDetails/SignerInfo/UserID')).toEqual([USER_ID, USER_ID]);
      expect(localAttributes(xml, 'Permission', 'AuthorisationLevel')).toEqual(['A', 'A']);
      expect((await sendVeuSignature(ctx.uploader, 'HVE', ref)).code).toBe('091306');
      expect(localAttribute(await hvzXml(ctx.signer), 'SigningInfo', 'readyToBeSigned')).toBe('true');

      expect((await sendVeuSignature(ctx.signer, 'HVE', ref)).code).toBe('000000');
      expect(orderStatuses(orderId)).toEqual(['EXECUTED']);
      expect(ctx.store.getAccount(ctx.creditor.id)!.currentBalanceCents).toBe(1234);
      expect(signatures(orderId)).toEqual([[USER_ID, 'UPLOAD', 'A'], [USER_ID, 'HVE', 'A'], [SECOND_USER, 'HVE', 'E']]);
    });
  });

  describe('admin VEU routes', () => {
    it('lists and reads orders and signs them on behalf of a user', async () => {
      const { content, orderId } = await uploadTransfer(ctx, 'API');

      const list = await api(ctx, '/veu/orders');
      expect(list.status).toBe(200);
      expect(list.json).toHaveLength(1);
      expect(list.json[0]).toMatchObject({
        partnerId: PARTNER_ID,
        orderId,
        serviceName: 'SCI',
        serviceOption: 'VOI',
        msgName: 'pain.001',
        msgId: 'MSG-API',
        originatorUserId: USER_ID,
        debtorIban: ctx.debtor.iban,
        totalCents: 1234,
        currency: 'EUR',
        vopGroupStatus: 'RCVC',
        signaturesDone: 1,
        signaturesComplete: false,
        numSigRequired: 2,
        vopConfirmationRequired: false,
        vopConfirmed: false,
        releasable: false,
        dataDigest: orderDataDigest(content),
      });
      expect(list.json[0]).not.toHaveProperty('signaturesRequired');
      expect(list.json[0].paymentOrderIds).toHaveLength(1);
      expect(list.json[0].transactions).toHaveLength(1);
      expect(list.json[0].signatures).toMatchObject([{ userId: USER_ID, kind: 'UPLOAD', signatureClass: 'A' }]);
      expect((await api(ctx, `/veu/orders?partnerId=${PARTNER_ID}`)).json).toHaveLength(1);
      expect((await api(ctx, `/veu/orders?partnerId=${OTHER_PARTNER}`)).json).toEqual([]);

      const single = await api(ctx, `/veu/orders/${PARTNER_ID}/${orderId}`);
      expect(single.status).toBe(200);
      expect(single.json).toMatchObject({ orderId, signaturesDone: 1, signaturesComplete: false });
      expect((await api(ctx, `/veu/orders/${PARTNER_ID}/${UNKNOWN_ORDER_ID}`)).status).toBe(404);

      const sign = (body: unknown, partnerId = PARTNER_ID) => api(ctx, `/veu/orders/${partnerId}/${orderId}/sign`, { method: 'POST', body });
      const missing = await sign({});
      expect(missing.status).toBe(400);
      expect(missing.json.error).toBe('userId is required');
      const unknown = await sign({ userId: 'NOBODY' });
      expect(unknown.status).toBe(400);
      expect(unknown.json.error).toMatch(/Unknown user NOBODY/);
      expect((await sign({ userId: USER_ID }, OTHER_PARTNER)).status).toBe(400);

      const duplicate = await sign({ userId: USER_ID });
      expect(duplicate.status).toBe(409);
      expect(duplicate.json).toMatchObject({ returnCode: '091306' });
      expect(duplicate.json.error).toEqual(expect.any(String));

      const signed = await sign({ userId: SECOND_USER });
      expect(signed.status).toBe(200);
      expect(signed.json).toMatchObject({ released: true, order: null });
      expect(signed.json.orderId).toMatch(ORDER_ID);
      expect(orderStatuses(orderId)).toEqual(['EXECUTED']);
      expect(ctx.store.listHacEvents({ partnerId: PARTNER_ID, orderId: signed.json.orderId }).map((e) => [e.action, e.userId])).toEqual([
        ['ES_UPLOAD', SECOND_USER],
        ['ES_VERIFICATION', SECOND_USER],
      ]);
      expect((await api(ctx, '/veu/orders')).json).toEqual([]);

      const again = await sign({ userId: SECOND_USER });
      expect(again.status).toBe(409);
      expect(again.json.returnCode).toBe('091114');
    });

    it('returns the remaining VEU state when a signature does not release the order yet', async () => {
      process.env['EBICS_VOP_CONFIRMATION'] = 'true';
      const { orderId } = await uploadTransfer(ctx, 'API-PARTIAL', { creditorName: 'Alice Wunderland' });

      const signed = await api(ctx, `/veu/orders/${PARTNER_ID}/${orderId}/sign`, { method: 'POST', body: { userId: USER_ID } });
      expect(signed.status).toBe(200);
      expect(signed.json).toMatchObject({
        released: false,
        order: { orderId, vopConfirmationRequired: true, vopConfirmed: true, signaturesDone: 1, signaturesComplete: false, numSigRequired: 3, releasable: false },
      });
      expect(orderStatuses(orderId)).toEqual(['PENDING_EDS']);
    });

    it('reports signaturesComplete when only the VoP confirmation is missing', async () => {
      ctx.store.updateSubscriberSettings(PARTNER_ID, USER_ID, { signatureClass: 'E' });
      process.env['EBICS_VOP_CONFIRMATION'] = 'true';
      const { orderId } = await uploadTransfer(ctx, 'API-VOP', { creditorName: 'Alice Wunderland' });

      const view = await api(ctx, `/veu/orders/${PARTNER_ID}/${orderId}`);
      expect(view.status).toBe(200);
      expect(view.json).toMatchObject({
        signaturesDone: 1,
        signaturesComplete: true,
        numSigRequired: 2,
        vopGroupStatus: 'RVNM',
        vopConfirmationRequired: true,
        vopConfirmed: false,
        releasable: false,
      });

      const signed = await api(ctx, `/veu/orders/${PARTNER_ID}/${orderId}/sign`, { method: 'POST', body: { userId: SECOND_USER } });
      expect(signed.json).toMatchObject({ released: true, order: null });
      expect(orderStatuses(orderId)).toEqual(['EXECUTED']);
    });

    it('cancels orders on behalf of a user', async () => {
      const { orderId } = await uploadTransfer(ctx, 'API-CANCEL');
      const cancel = (body: unknown) => api(ctx, `/veu/orders/${PARTNER_ID}/${orderId}/cancel`, { method: 'POST', body });

      expect((await cancel({})).status).toBe(400);
      expect((await cancel({ userId: 'NOBODY' })).status).toBe(400);

      const cancelled = await cancel({ userId: SECOND_USER, additionalInfo: ['Storno per Admin', '', 42] });
      expect(cancelled.status).toBe(200);
      expect(cancelled.json.orderId).toMatch(ORDER_ID);
      expect(orderStatuses(orderId)).toEqual(['CANCELLED']);
      const order = ctx.store.listPaymentOrders({ orderId })[0]!;
      expect(ctx.store.listPaymentStatusEvents({ paymentOrderId: order.id }).at(-1)).toMatchObject({ status: 'RJCT', reasonCode: 'DS02', additionalInfo: ['Storno per Admin'] });
      expect(ctx.store.listHacEvents({ partnerId: PARTNER_ID, orderId: cancelled.json.orderId })[0]).toMatchObject({
        action: 'VEU_CANCEL_ORDER',
        userId: SECOND_USER,
        orderIdRef: orderId,
        additionalInfo: ['Storno per Admin'],
      });

      const again = await cancel({ userId: SECOND_USER });
      expect(again.status).toBe(409);
      expect(again.json.returnCode).toBe('091114');
    });

    it('refuses to sign or cancel on behalf of a class T user with 409 and returnCode 090003', async () => {
      await setSignatureClass(ctx, SECOND_USER, 'T');
      const { orderId } = await uploadTransfer(ctx, 'API-T');

      const signed = await api(ctx, `/veu/orders/${PARTNER_ID}/${orderId}/sign`, { method: 'POST', body: { userId: SECOND_USER } });
      expect(signed.status).toBe(409);
      expect(signed.json).toMatchObject({ returnCode: '090003', error: expect.any(String) });

      const cancelled = await api(ctx, `/veu/orders/${PARTNER_ID}/${orderId}/cancel`, { method: 'POST', body: { userId: SECOND_USER } });
      expect(cancelled.status).toBe(409);
      expect(cancelled.json).toMatchObject({ returnCode: '090003', error: expect.any(String) });

      expect(orderStatuses(orderId)).toEqual(['PENDING_EDS']);
      expect(signatures(orderId)).toEqual([[USER_ID, 'UPLOAD', 'A']]);
      expect(veuActionEvents()).toEqual([]);
      expect((await api(ctx, `/veu/orders/${PARTNER_ID}/${orderId}`)).json).toMatchObject({ signaturesDone: 1, releasable: false });
    });

    it('keeps the stored signature classes when the signers change their class', async () => {
      await setSignatureClass(ctx, USER_ID, 'B');
      await setSignatureClass(ctx, SECOND_USER, 'B');
      const { orderId } = await uploadTransfer(ctx, 'API-CLASS');
      const sign = (userId: string) => api(ctx, `/veu/orders/${PARTNER_ID}/${orderId}/sign`, { method: 'POST', body: { userId } });

      const second = await sign(SECOND_USER);
      expect(second.status).toBe(200);
      expect(second.json).toMatchObject({ released: false, order: { signaturesDone: 2, signaturesComplete: false, numSigRequired: 3 } });

      await setSignatureClass(ctx, USER_ID, 'E');
      await setSignatureClass(ctx, SECOND_USER, 'E');
      const view = await api(ctx, `/veu/orders/${PARTNER_ID}/${orderId}`);
      expect(view.json).toMatchObject({ signaturesDone: 2, signaturesComplete: false, numSigRequired: 3, releasable: false });
      expect(view.json.signatures.map((s: { userId: string; signatureClass: string }) => [s.userId, s.signatureClass])).toEqual([[USER_ID, 'B'], [SECOND_USER, 'B']]);
      expect(localAttributes(await hvzXml(ctx.uploader), 'Permission', 'AuthorisationLevel')).toEqual(['B', 'B']);
      expect((await sign(SECOND_USER)).json.returnCode).toBe('091306');

      await createThirdUser(ctx, 'A');
      const released = await sign(THIRD_USER);
      expect(released.status).toBe(200);
      expect(released.json).toMatchObject({ released: true, order: null });
      expect(orderStatuses(orderId)).toEqual(['EXECUTED']);
      expect(signatures(orderId)).toEqual([[USER_ID, 'UPLOAD', 'B'], [SECOND_USER, 'HVE', 'B'], [THIRD_USER, 'HVE', 'A']]);
    });
  });
});
