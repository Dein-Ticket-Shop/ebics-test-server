import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp, postEbics, PARTNER_ID, USER_ID } from '../helpers/test-server.js';
import {
  buildPain008Document,
  hvdOrderParams,
  hvtOrderParams,
  hvuOrderParams,
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
} from '../helpers/ebics-session.js';
import { orderDataDigest } from '../../src/banking/veu.js';
import { calculateIban } from '../../src/banking/iban.js';
import type { Account } from '../../src/store/types.js';
import type { SqliteStore } from '../../src/store/sqlite-store.js';

const SECOND_USER = 'USER2';
const FLAGS = ['EBICS_VOP_CONFIRMATION', 'EBICS_VOP_DEFAULT', 'EBICS_HAC_FORMAT', 'EBICS_HAC_DOWNLOAD_EVENTS'] as const;

type App = ReturnType<typeof createTestApp>['app'];

interface Ctx {
  app: App;
  store: SqliteStore;
  /** USER1, class A: uploads the direct debits */
  uploader: EbicsSession;
  /** USER2, class E */
  signer: EbicsSession;
  /** The partner's account, collecting the direct debits */
  account: Account;
  /** Bob's account at this bank, debited */
  bob: Account;
}

async function setup(): Promise<Ctx> {
  const { app, store } = createTestApp();
  const post = async (xml: string) => (await postEbics(app, xml)).text();
  const activate = (partnerId: string, userId: string) => app.request(`/api/subscribers/${partnerId}/${userId}/activate`, { method: 'POST' });
  const uploader = await enrolSubscriber({ post, activate, store, partnerId: PARTNER_ID, userId: USER_ID, signatureClass: 'A' });
  const signer = await enrolSubscriber({ post, activate, store, partnerId: PARTNER_ID, userId: SECOND_USER, signatureClass: 'E' });
  const account = store.listAccountsForPartner(PARTNER_ID)[0]!;
  const person = store.createPerson({ name: 'Bob Mustermann', country: 'DE' });
  const accountNumber = store.getNextAccountSequence().toString().padStart(10, '0');
  const bob = store.createAccount({ personId: person.id, iban: calculateIban('10020030', accountNumber), accountNumber, currency: 'EUR', name: 'Bob Konto' });
  return { app, store, uploader, signer, account, bob };
}

describe('Direct debits in the VEU (EBICS 3.0.2 chapter 8)', () => {
  let ctx: Ctx;
  let restoreFlags: () => void;

  beforeEach(async () => {
    const saved = Object.fromEntries(FLAGS.map((flag) => [flag, process.env[flag]]));
    for (const flag of FLAGS) delete process.env[flag];
    restoreFlags = () => {
      for (const flag of FLAGS) {
        if (saved[flag] === undefined) delete process.env[flag];
        else process.env[flag] = saved[flag];
      }
    };
    ctx = await setup();
  });

  afterEach(() => restoreFlags());

  const today = new Date().toISOString().slice(0, 10);
  const balances = () => [ctx.store.getAccount(ctx.account.id)!.currentBalanceCents, ctx.store.getAccount(ctx.bob.id)!.currentBalanceCents];
  const statuses = () => ctx.store.listDirectDebitOrders().map((o) => o.status);
  const actions = (orderId: string) => ctx.store.listHacEvents({ orderId }).map((e) => e.action);

  /** pain.008 by USER1 (class A) with requestEDS collecting 5.00 EUR from Bob; waits in the VEU */
  async function heldDirectDebit(id: string) {
    const content = buildPain008Document({
      msgId: `MSG-${id}`,
      payments: [
        {
          pmtInfId: `PMT-${id}`,
          creditorName: 'Musterfirma GmbH',
          creditorIban: ctx.account.iban,
          transactions: [
            { endToEndId: `E2E-${id}`, debtorName: 'Bob Mustermann', debtorIban: ctx.bob.iban, amount: '5.00', mandateId: 'MNDT-1', remittance: 'Ticket 42' },
          ],
        },
      ],
    });
    const upload = await uploadOrder(ctx.uploader, content, { serviceName: 'SDD', msgName: 'pain.008', upload: { scope: 'DE', requestEds: true } });
    expect(readBusinessReturnCode(upload.transferBody)).toBe('000000');
    const orderId = upload.orderId!;
    const ref: VeuOrderRef = { partnerId: PARTNER_ID, orderId, serviceName: 'SDD', scope: 'DE', msgName: 'pain.008' };
    return { content, orderId, ref };
  }

  it('holds the upload without booking and lists it in HVU and HVZ with isCredit="false" and the creditor as ordering party', async () => {
    const { orderId } = await heldDirectDebit('HOLD');
    expect(statuses()).toEqual(['PENDING_EDS']);
    expect(balances()).toEqual([0, 0]);
    expect(actions(orderId)).toEqual(['FILE_UPLOAD', 'ES_VERIFICATION', 'VEU_FORWARDING']);

    const hvu = await downloadWithOrderParams(ctx.signer, 'HVU', hvuOrderParams());
    expect(hvu.code).toBe('000000');
    const hvuXml = hvu.data!.toString('utf8');
    expect(localTexts(hvuXml, 'OrderDetails/OrderID')).toEqual([orderId]);
    expect(localTexts(hvuXml, 'OrderDetails/Service/ServiceName')).toEqual(['SDD']);

    const hvz = await downloadWithOrderParams(ctx.signer, 'HVZ', hvzOrderParams([{ serviceName: 'SDD' }]));
    expect(hvz.code).toBe('000000');
    const xml = hvz.data!.toString('utf8');
    expect(localTexts(xml, 'OrderDetails/TotalOrders')).toEqual(['1']);
    expect(localTexts(xml, 'OrderDetails/TotalAmount')).toEqual(['5.00']);
    expect(localAttribute(xml, 'TotalAmount', 'isCredit')).toBe('false');
    expect(localTexts(xml, 'FirstOrderInfo/OrderPartyInfo')).toEqual(['Musterfirma GmbH']);
    expect(localTexts(xml, 'FirstOrderInfo/AccountInfo/AccountNumber')).toEqual([ctx.account.iban]);
    expect(localAttribute(xml, 'SigningInfo', 'NumSigRequired')).toBe('2');
  });

  it('HVD returns the direct debit display file, HVT the single orders with the creditor as Originator', async () => {
    const { content, ref } = await heldDirectDebit('DETAILS');

    const hvd = await downloadWithOrderParams(ctx.signer, 'HVD', hvdOrderParams(ref));
    expect(hvd.code).toBe('000000');
    const hvdXml = hvd.data!.toString('utf8');
    expect(localTexts(hvdXml, 'DataDigest')).toEqual([orderDataDigest(content)]);
    expect(Buffer.from(localTexts(hvdXml, 'DisplayFile')[0]!, 'base64').toString('utf8')).toContain('L A S T S C H R I F T E N');

    const hvt = await downloadWithOrderParams(ctx.signer, 'HVT', hvtOrderParams(ref, { completeOrderData: false }));
    expect(hvt.code).toBe('000000');
    const hvtXml = hvt.data!.toString('utf8');
    expect(localTexts(hvtXml, 'NumOrderInfos')).toEqual(['1']);
    expect(localAttributes(hvtXml, 'AccountNumber', 'Role')).toEqual(['Originator', 'Recipient']);
    expect(localTexts(hvtXml, 'OrderInfo/AccountInfo/AccountNumber')).toEqual([ctx.account.iban, ctx.bob.iban]);
    expect(localAttribute(hvtXml, 'Amount', 'isCredit')).toBe('false');
    expect(localTexts(hvtXml, 'OrderInfo/Amount')).toEqual(['5.00']);
    expect(localTexts(hvtXml, 'OrderInfo/ExecutionDate')).toEqual([today]);
    expect(localTexts(hvtXml, 'OrderInfo/Description')).toEqual(['Ticket 42']);

    const complete = await downloadWithOrderParams(ctx.signer, 'HVT', hvtOrderParams(ref, { completeOrderData: true }));
    expect(complete.data!.toString('utf8')).toBe(content);
  });

  it('HVE by a class E user books the direct debits and closes the order with the display file', async () => {
    const { orderId, ref } = await heldDirectDebit('SIGN');
    expect((await sendVeuSignature(ctx.signer, 'HVE', ref)).code).toBe('000000');
    expect(statuses()).toEqual(['EXECUTED']);
    expect(balances()).toEqual([500, -500]);

    const events = ctx.store.listHacEvents({ orderId }).filter((e) => e.orderId === orderId);
    expect(events.map((e) => e.action)).toEqual(['FILE_UPLOAD', 'ES_VERIFICATION', 'VEU_FORWARDING', 'VEU_VERIFICATION_END', 'ORDER_HAC_FINAL_POS']);
    expect(events.at(-1)!.additionalInfo).toContain('L A S T S C H R I F T E N');
    expect((await downloadWithOrderParams(ctx.signer, 'HVU', hvuOrderParams())).code).toBe('090005');
  });

  it('HVS cancels the direct debits without booking', async () => {
    const { orderId, ref } = await heldDirectDebit('CANCEL');
    const result = await sendVeuSignature(ctx.signer, 'HVS', ref);
    expect(result.code).toBe('000000');
    expect(statuses()).toEqual(['CANCELLED']);
    expect(balances()).toEqual([0, 0]);
    expect(ctx.store.listHacEvents({ orderId: result.orderId }).map((e) => [e.action, e.orderIdRef])).toEqual([['VEU_CANCEL_ORDER', orderId]]);
    expect(actions(orderId).at(-1)).toBe('ORDER_HAC_FINAL_POS');
  });

  it('admin VEU API lists the direct debit order and signs it on behalf of a user', async () => {
    const { orderId } = await heldDirectDebit('ADMIN');
    const list = (await (await ctx.app.request('/api/veu/orders')).json()) as any[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      kind: 'directDebit',
      orderId,
      paymentOrderIds: [],
      serviceName: 'SDD',
      msgName: 'pain.008',
      msgId: 'MSG-ADMIN',
      originatorUserId: USER_ID,
      creditorIban: ctx.account.iban,
      totalCents: 500,
      transactions: [],
      numSigRequired: 2,
    });
    expect(list[0].directDebits).toMatchObject([{ debtorIban: ctx.bob.iban, amountCents: 500, currency: 'EUR' }]);

    const signed = await ctx.app.request(`/api/veu/orders/${PARTNER_ID}/${orderId}/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: SECOND_USER }),
    });
    expect(await signed.json()).toMatchObject({ released: true, order: null });
    expect(balances()).toEqual([500, -500]);
  });
});
