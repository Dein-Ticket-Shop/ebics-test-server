import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp, postEbics, PARTNER_ID, USER_ID } from '../helpers/test-server.js';
import { buildPain001Document, hvzOrderParams, readBusinessReturnCode, type UploadOptions } from '../helpers/test-client.js';
import {
  downloadOrder,
  downloadWithOrderParams,
  enrolSubscriber,
  localAttribute,
  localTexts,
  sessionSigner,
  uploadOrder,
  type EbicsSession,
} from '../helpers/ebics-session.js';
import { calculateIban } from '../../src/banking/iban.js';
import type { Account } from '../../src/store/types.js';
import type { SqliteStore } from '../../src/store/sqlite-store.js';

const SECOND_USER = 'USER2';
const FLAGS = ['EBICS_VOP_CONFIRMATION', 'EBICS_VOP_DEFAULT', 'EBICS_HAC_FORMAT', 'EBICS_HAC_DOWNLOAD_EVENTS'] as const;
const REQUEST_EDS: UploadOptions = { scope: 'DE', serviceOption: 'VOI', requestEds: true };
const SIGNED: UploadOptions = { scope: 'DE', serviceOption: 'VOI', signatureFlag: true };
const RULES_PATH = `/banking/partners/${PARTNER_ID}/minimum-signatures`;

type App = ReturnType<typeof createTestApp>['app'];

interface Ctx {
  app: App;
  store: SqliteStore;
  /** USER1, class E */
  first: EbicsSession;
  /** USER2, class B */
  second: EbicsSession;
  debtor: Account;
  creditor: Account;
}

async function setup(): Promise<Ctx> {
  const { app, store } = createTestApp();
  const post = async (xml: string) => (await postEbics(app, xml)).text();
  const activate = (partnerId: string, userId: string) => app.request(`/api/subscribers/${partnerId}/${userId}/activate`, { method: 'POST' });
  const first = await enrolSubscriber({ post, activate, store, partnerId: PARTNER_ID, userId: USER_ID, signatureClass: 'E' });
  const second = await enrolSubscriber({ post, activate, store, partnerId: PARTNER_ID, userId: SECOND_USER, signatureClass: 'B' });

  const debtor = store.listAccountsForPartner(PARTNER_ID)[0]!;
  store.createBooking({ accountId: debtor.id, amountCents: 1_000_000, currency: 'EUR', valueDate: '2025-01-01', bookingDate: '2025-01-01', transactionCode: 'NTRF' });
  const bob = store.createPerson({ name: 'Bob Mustermann', country: 'DE' });
  const accountNumber = store.getNextAccountSequence().toString().padStart(10, '0');
  const creditor = store.createAccount({ personId: bob.id, iban: calculateIban('10020030', accountNumber), accountNumber, currency: 'EUR', name: 'Bob Konto' });
  return { app, store, first, second, debtor, creditor };
}

async function api<T = any>(app: App, path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; json: T }> {
  const res = await app.request(`/api${path}`, {
    method: init?.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

describe('Minimum number of bank-technical signatures (EBICS 3.0.2 chapters 3.5, 11.2.3)', () => {
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
  const statuses = (orderId: string) => ctx.store.listPaymentOrders({ partnerId: PARTNER_ID, orderId }).map((o) => o.status);

  it('admin API: reads and sets the rule of the customer and the rules of BTF services', async () => {
    expect((await api(ctx.app, RULES_PATH)).json).toEqual({ partnerId: PARTNER_ID, minimumSignatures: 1, services: {} });

    expect((await api(ctx.app, RULES_PATH, { method: 'PUT', body: { minimumSignatures: 2 } })).json).toEqual({
      partnerId: PARTNER_ID,
      minimumSignatures: 2,
      services: {},
    });
    expect((await api(ctx.app, RULES_PATH, { method: 'PUT', body: { serviceName: 'SCI', minimumSignatures: 1 } })).json).toEqual({
      partnerId: PARTNER_ID,
      minimumSignatures: 2,
      services: { SCI: 1 },
    });
    expect((await api(ctx.app, RULES_PATH, { method: 'PUT', body: { serviceName: 'SCI', minimumSignatures: null } })).json.services).toEqual({});

    expect((await api(ctx.app, RULES_PATH, { method: 'PUT', body: { minimumSignatures: 3 } })).status).toBe(400);
    expect((await api(ctx.app, RULES_PATH, { method: 'PUT', body: {} })).status).toBe(400);
    expect((await api(ctx.app, RULES_PATH, { method: 'PUT', body: { serviceName: 5, minimumSignatures: 2 } })).status).toBe(400);
  });

  it('HKD and HTD report the minimum as NumSigRequired of the BTU order types', async () => {
    const numSigRequired = async (orderType: 'HKD' | 'HTD') => {
      const result = await downloadOrder(ctx.first, orderType);
      expect(result.code, orderType).toBe('000000');
      return localTexts(result.data!.toString('utf8'), 'PartnerInfo/OrderInfo/NumSigRequired');
    };
    // SCT, SDD (CORE), SDD (B2B) and SCI
    expect(await numSigRequired('HTD')).toEqual(['1', '1', '1', '1']);

    await api(ctx.app, RULES_PATH, { method: 'PUT', body: { serviceName: 'SCI', minimumSignatures: 2 } });
    expect(await numSigRequired('HTD')).toEqual(['1', '1', '1', '2']);
    expect(await numSigRequired('HKD')).toEqual(['1', '1', '1', '2']);
  });

  it('uploads with a minimum of two: E alone waits in the VEU or is rejected, E + B executes', async () => {
    await api(ctx.app, RULES_PATH, { method: 'PUT', body: { serviceName: 'SCI', minimumSignatures: 2 } });

    const held = await uploadOrder(ctx.first, pain001('HELD'), { upload: REQUEST_EDS });
    expect(readBusinessReturnCode(held.transferBody)).toBe('000000');
    expect(statuses(held.orderId!)).toEqual(['PENDING_EDS']);
    const hvz = await downloadWithOrderParams(ctx.second, 'HVZ', hvzOrderParams());
    expect(hvz.code).toBe('000000');
    expect(localAttribute(hvz.data!.toString('utf8'), 'SigningInfo', 'NumSigRequired')).toBe('2');

    const rejected = await uploadOrder(ctx.first, pain001('REJECTED'), { upload: SIGNED });
    expect(readBusinessReturnCode(rejected.transferBody)).toBe('090003');

    const executed = await uploadOrder(ctx.first, pain001('EXECUTED'), { upload: SIGNED, signatures: [sessionSigner(ctx.first), sessionSigner(ctx.second)] });
    expect(readBusinessReturnCode(executed.transferBody)).toBe('000000');
    expect(statuses(executed.orderId!)).toEqual(['EXECUTED']);
  });
});
