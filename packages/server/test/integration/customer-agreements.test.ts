import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp, postEbics, PARTNER_ID, USER_ID } from '../helpers/test-server.js';
import { buildPain001Document, readBusinessReturnCode, type UploadOptions } from '../helpers/test-client.js';
import { enrolSubscriber, sessionSigner, uploadOrder, type EbicsSession } from '../helpers/ebics-session.js';
import { calculateIban } from '../../src/banking/iban.js';
import type { Account } from '../../src/store/types.js';
import type { SqliteStore } from '../../src/store/sqlite-store.js';

const SECOND_USER = 'USER2';
const FLAGS = ['EBICS_VOP_CONFIRMATION', 'EBICS_VOP_DEFAULT', 'EBICS_HAC_FORMAT', 'EBICS_HAC_DOWNLOAD_EVENTS'] as const;
const REQUEST_EDS: UploadOptions = { scope: 'DE', serviceOption: 'VOI', requestEds: true };
const SIGNED: UploadOptions = { scope: 'DE', serviceOption: 'VOI', signatureFlag: true };
const WITHOUT_FLAG: UploadOptions = { scope: 'DE', serviceOption: 'VOI' };
const AGREEMENTS_PATH = `/api/banking/partners/${PARTNER_ID}/agreements`;

type App = ReturnType<typeof createTestApp>['app'];

interface Ctx {
  app: App;
  store: SqliteStore;
  /** USER1, class A */
  first: EbicsSession;
  /** USER2, class E */
  second: EbicsSession;
  debtor: Account;
  creditor: Account;
}

async function setup(): Promise<Ctx> {
  const { app, store } = createTestApp();
  const post = async (xml: string) => (await postEbics(app, xml)).text();
  const activate = (partnerId: string, userId: string) => app.request(`/api/subscribers/${partnerId}/${userId}/activate`, { method: 'POST' });
  const first = await enrolSubscriber({ post, activate, store, partnerId: PARTNER_ID, userId: USER_ID, signatureClass: 'A' });
  const second = await enrolSubscriber({ post, activate, store, partnerId: PARTNER_ID, userId: SECOND_USER, signatureClass: 'E' });
  const debtor = store.listAccountsForPartner(PARTNER_ID)[0]!;
  store.createBooking({ accountId: debtor.id, amountCents: 1_000_000, currency: 'EUR', valueDate: '2025-01-01', bookingDate: '2025-01-01', transactionCode: 'NTRF' });
  const bob = store.createPerson({ name: 'Bob Mustermann', country: 'DE' });
  const accountNumber = store.getNextAccountSequence().toString().padStart(10, '0');
  const creditor = store.createAccount({ personId: bob.id, iban: calculateIban('10020030', accountNumber), accountNumber, currency: 'EUR', name: 'Bob Konto' });
  return { app, store, first, second, debtor, creditor };
}

describe('Customer agreements (EBICS 3.0.2 chapter 3.14)', () => {
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

  const pain001 = (id: string) =>
    buildPain001Document({
      msgId: `MSG-${id}`,
      payments: [
        {
          pmtInfId: `PMT-${id}`,
          debtorName: 'Musterfirma GmbH',
          debtorIban: ctx.debtor.iban,
          transactions: [{ endToEndId: `E2E-${id}`, creditorName: 'Bob Mustermann', creditorIban: ctx.creditor.iban, amount: '12.34' }],
        },
      ],
    });
  const patch = async (body: unknown) => {
    const res = await ctx.app.request(AGREEMENTS_PATH, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const statuses = (orderId: string) => ctx.store.listPaymentOrders({ partnerId: PARTNER_ID, orderId }).map((o) => o.status);
  const protocol = (orderId: string) => ctx.store.listHacEvents({ orderId }).map((e) => [e.action, e.reasonCode, e.additionalInfo[0]]);

  it('admin API: both agreements by default, each can be withdrawn', async () => {
    expect(await (await ctx.app.request(AGREEMENTS_PATH)).json()).toEqual({ partnerId: PARTNER_ID, veu: true, signingOutsideEbics: true });
    expect(await patch({ veu: false })).toEqual({ status: 200, json: { partnerId: PARTNER_ID, veu: false, signingOutsideEbics: true } });
    expect(await patch({ signingOutsideEbics: false })).toEqual({ status: 200, json: { partnerId: PARTNER_ID, veu: false, signingOutsideEbics: false } });
    expect((await patch({ veu: 'no' })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
  });

  it('without VEU agreement: a requested VEU with insufficient signatures is refused with 091007, sufficient signatures execute', async () => {
    await patch({ veu: false });

    const refused = await uploadOrder(ctx.first, pain001('NO-VEU'), { upload: REQUEST_EDS });
    expect(readBusinessReturnCode(refused.transferBody)).toBe('091007');
    expect(ctx.store.listPaymentOrders()).toEqual([]);
    const message = `Unterschriftsklasse A von ${USER_ID} reicht nicht aus und keine VEU vereinbart`;
    expect(protocol(refused.orderId!)).toEqual([
      ['FILE_UPLOAD', 'TS01', undefined],
      ['ES_VERIFICATION', 'DS0A', message],
      ['ORDER_HAC_FINAL_NEG', undefined, message],
    ]);

    const executed = await uploadOrder(ctx.first, pain001('NO-VEU-AB'), {
      upload: REQUEST_EDS,
      signatures: [sessionSigner(ctx.first), sessionSigner(ctx.second)],
    });
    expect(readBusinessReturnCode(executed.transferBody)).toBe('000000');
    expect(statuses(executed.orderId!)).toEqual(['EXECUTED']);
  });

  it('without agreement on authorisation outside EBICS: an upload without SignatureFlag is refused with 090003', async () => {
    const before = await uploadOrder(ctx.second, pain001('OUTSIDE'), { upload: WITHOUT_FLAG });
    expect(readBusinessReturnCode(before.transferBody)).toBe('000000');

    await patch({ signingOutsideEbics: false });
    const refused = await uploadOrder(ctx.second, pain001('NOT-OUTSIDE'), { upload: WITHOUT_FLAG });
    expect(readBusinessReturnCode(refused.transferBody)).toBe('090003');
    expect(statuses(refused.orderId!)).toEqual([]);
    const message = 'Auftrag ohne Signatur-Flag, eine Autorisierung ausserhalb von EBICS ist nicht vereinbart';
    expect(protocol(refused.orderId!)).toEqual([
      ['FILE_UPLOAD', 'TS01', undefined],
      ['ES_VERIFICATION', 'DS0A', message],
      ['ORDER_HAC_FINAL_NEG', undefined, message],
    ]);

    const signed = await uploadOrder(ctx.second, pain001('SIGNED'), { upload: SIGNED });
    expect(readBusinessReturnCode(signed.transferBody)).toBe('000000');
    expect(statuses(signed.orderId!)).toEqual(['EXECUTED']);
  });
});
