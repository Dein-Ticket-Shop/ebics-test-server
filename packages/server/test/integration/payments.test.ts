import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp, postEbics, HOST_ID, PARTNER_ID, USER_ID } from '../helpers/test-server.js';
import {
  generateTestClientKeys,
  buildIniRequest,
  buildHiaRequest,
  buildHpbRequest,
  buildEbicsDownloadInitRequest,
  buildEbicsReceiptRequest,
  buildEbicsUploadInitRequest,
  buildEbicsUploadTransferRequest,
  encryptUploadContent,
  decryptDownloadResponse,
  decryptDownloadResponseBytes,
  buildPain001Document,
  readOrderId,
  readBusinessReturnCode,
  type BankCerts,
  type DateRange,
  type DownloadParams,
  type Pain001Payment,
  type TestClientKeys,
  type UploadOptions,
} from '../helpers/test-client.js';
import { parseXml, xpathSelect, xpathString } from '../../src/protocol/xml-parser.js';
import { extractPublicKeyFromCertBase64 } from '../../src/protocol/xml-signature.js';
import { readZip } from '../../src/protocol/zip.js';
import { calculateIban } from '../../src/banking/iban.js';
import type { SqliteStore } from '../../src/store/sqlite-store.js';
import type { Account } from '../../src/store/types.js';

const FLAGS = ['EBICS_HAC_FORMAT', 'EBICS_EDS_HOLD', 'EBICS_VOP_DEFAULT'] as const;
const SCI: UploadOptions = { scope: 'DE', serviceOption: 'VOI', requestEds: true };
const PSR: DownloadParams = { serviceName: 'REP', scope: 'DE', serviceOption: 'SCI', containerType: 'ZIP', msgName: 'pain.002' };
const VOP: DownloadParams = { serviceName: 'REP', scope: 'DE', serviceOption: 'VOP', containerType: 'ZIP', msgName: 'pain.002' };
const C54: DownloadParams = { serviceName: 'STM', scope: 'DE', serviceOption: 'SCI', containerType: 'ZIP', msgName: 'camt.054' };
const C52: DownloadParams = { serviceName: 'STM', scope: 'DE', containerType: 'ZIP', msgName: 'camt.052' };
const TODAY = new Date().toISOString().slice(0, 10);
const TODAY_RANGE: DateRange = { start: TODAY, end: TODAY };

function texts(xml: string, path: string): string[] {
  const expression = '//' + path.split('/').map((name) => `*[local-name()='${name}']`).join('/');
  return (xpathSelect(expression, parseXml(xml)) as unknown as Node[]).map((n) => n.textContent ?? '');
}

interface Ctx {
  app: ReturnType<typeof createTestApp>['app'];
  store: SqliteStore;
  keys: TestClientKeys;
  bankCerts: BankCerts;
  bankEncPubKey: string;
  iniBody: string;
  hiaBody: string;
  debtor: Account;
  creditor: Account;
  foreignIban: string;
}

async function setup(): Promise<Ctx> {
  const { app, store } = createTestApp();
  const keys = generateTestClientKeys();
  store.createSubscriber(PARTNER_ID, USER_ID);
  const iniBody = await (await postEbics(app, buildIniRequest(HOST_ID, PARTNER_ID, USER_ID, keys))).text();
  const hiaBody = await (await postEbics(app, buildHiaRequest(HOST_ID, PARTNER_ID, USER_ID, keys))).text();
  await app.request(`/api/subscribers/${PARTNER_ID}/${USER_ID}/activate`, { method: 'POST' });
  await postEbics(app, buildHpbRequest(HOST_ID, PARTNER_ID, USER_ID, keys));

  const host = store.getHostConfig()!;
  const bankCerts = { authCertPem: host.bankKeys.authenticationCertificate, encCertPem: host.bankKeys.encryptionCertificate };
  const bankEncPubKey = extractPublicKeyFromCertBase64(
    host.bankKeys.encryptionCertificate.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s/g, ''),
  );

  const debtor = store.listAccountsForPartner(PARTNER_ID)[0]!;
  store.createBooking({ accountId: debtor.id, amountCents: 1_000_000, currency: 'EUR', valueDate: '2025-01-01', bookingDate: '2025-01-01', transactionCode: 'NTRF' });

  const bob = store.createPerson({ name: 'Bob Mustermann', country: 'DE' });
  const accountNumber = store.getNextAccountSequence().toString().padStart(10, '0');
  const creditor = store.createAccount({ personId: bob.id, iban: calculateIban('10020030', accountNumber), accountNumber, currency: 'EUR', name: 'Bob Konto' });

  return { app, store, keys, bankCerts, bankEncPubKey, iniBody, hiaBody, debtor, creditor, foreignIban: calculateIban('37040044', '0532013000') };
}

async function upload(ctx: Ctx, content: string, options: UploadOptions = SCI, serviceName = 'SCI') {
  const enc = encryptUploadContent(content, ctx.bankEncPubKey, PARTNER_ID, USER_ID);
  const initBody = await (
    await postEbics(ctx.app, buildEbicsUploadInitRequest(HOST_ID, PARTNER_ID, USER_ID, ctx.keys, ctx.bankCerts, serviceName, 'pain.001', enc, options))
  ).text();
  const transactionId = xpathString('//ebics:header/ebics:static/ebics:TransactionID/text()', parseXml(initBody))!;
  const transferBody = await (
    await postEbics(ctx.app, buildEbicsUploadTransferRequest(HOST_ID, ctx.keys, transactionId, 1, true, enc.segments[0]!))
  ).text();
  return { initBody, transferBody, transactionId };
}

async function download(ctx: Ctx, orderType: string, params?: DownloadParams, standard?: { dateRange?: DateRange }) {
  const body = await (
    await postEbics(ctx.app, buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, USER_ID, ctx.keys, ctx.bankCerts, orderType, params, standard))
  ).text();
  const code = readBusinessReturnCode(body);
  if (code !== '000000') return { code, body };
  const { data, transactionId } = decryptDownloadResponseBytes(body, ctx.keys.encKeyPair.privateKey);
  return { code, body, data, transactionId };
}

async function receipt(ctx: Ctx, transactionId: string, code: 0 | 1 = 0) {
  return (await postEbics(ctx.app, buildEbicsReceiptRequest(HOST_ID, ctx.keys, transactionId, code))).text();
}

function payment(ctx: Ctx, id: string, transactions?: Pain001Payment['transactions']): Pain001Payment {
  return {
    pmtInfId: `PMT-${id}`,
    debtorName: 'Musterfirma GmbH',
    debtorIban: ctx.debtor.iban,
    transactions: transactions ?? [
      { endToEndId: `E2E-${id}`, creditorName: 'Bob Mustermann', creditorIban: ctx.creditor.iban, amount: '12.34', remittance: `Auszahlung ${id}` },
    ],
  };
}

async function api<T = any>(ctx: Ctx, path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; json: T; text: string; contentType: string | null }> {
  const res = await ctx.app.request(`/api${path}`, {
    method: init?.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, contentType: res.headers.get('content-type') };
}

describe('Payments, reports and customer protocol', () => {
  let ctx: Ctx;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const flag of FLAGS) {
      saved[flag] = process.env[flag];
      delete process.env[flag];
    }
    ctx = await setup();
  });

  afterEach(() => {
    for (const flag of FLAGS) {
      if (saved[flag] === undefined) delete process.env[flag];
      else process.env[flag] = saved[flag];
    }
  });

  describe('order IDs', () => {
    it('returns OrderIDs for INI and HIA', () => {
      expect(readOrderId(ctx.iniBody)).toMatch(/^[A-Z][A-Z0-9]{3}$/);
      expect(readOrderId(ctx.hiaBody)).toMatch(/^[A-Z][A-Z0-9]{3}$/);
      expect(readOrderId(ctx.hiaBody)).not.toBe(readOrderId(ctx.iniBody));
    });

    it('echoes the same OrderID on upload Initialisation and final Transfer', async () => {
      const { initBody, transferBody } = await upload(ctx, buildPain001Document({ msgId: 'MSG-OID', payments: [payment(ctx, 'OID')] }));
      const orderId = readOrderId(initBody);
      expect(orderId).toMatch(/^[A-Z][A-Z0-9]{3}$/);
      expect(readOrderId(transferBody)).toBe(orderId);
      expect(readBusinessReturnCode(transferBody)).toBe('000000');
      expect(ctx.store.listUploadedOrders()[0]!.orderId).toBe(orderId);
    });
  });

  describe('SEPA Instant without EDS hold', () => {
    it('books immediately and reports ACTC then ACSC per PmtInfId', async () => {
      const { initBody } = await upload(ctx, buildPain001Document({ msgId: 'MSG-NOW', payments: [payment(ctx, 'NOW')] }));

      const [order] = ctx.store.listPaymentOrders();
      expect(order).toMatchObject({ status: 'EXECUTED', orderId: readOrderId(initBody), msgId: 'MSG-NOW', pmtInfId: 'PMT-NOW', serviceName: 'SCI', serviceOption: 'VOI', requestedEds: true });
      expect(ctx.store.getAccount(ctx.debtor.id)!.currentBalanceCents).toBe(1_000_000 - 1234);
      expect(ctx.store.getAccount(ctx.creditor.id)!.currentBalanceCents).toBe(1234);

      const psr = await download(ctx, 'BTD', PSR);
      expect(psr.code).toBe('000000');
      const files = readZip(psr.data!);
      expect(files).toHaveLength(2);
      const reports = files.map((f) => f.content.toString('utf8'));
      expect(reports.map((r) => texts(r, 'OrgnlGrpInfAndSts/OrgnlMsgId')[0])).toEqual(['MSG-NOW', 'MSG-NOW']);
      expect(reports.map((r) => texts(r, 'OrgnlPmtInfAndSts/OrgnlPmtInfId')[0])).toEqual(['PMT-NOW', 'PMT-NOW']);
      expect(reports.map((r) => texts(r, 'OrgnlPmtInfAndSts/PmtInfSts')[0])).toEqual(['ACTC', 'ACSC']);

      await receipt(ctx, psr.transactionId!);
      expect((await download(ctx, 'BTD', PSR)).code).toBe('090005');
      // A DateRange ignores the delivery state
      expect(readZip((await download(ctx, 'BTD', { ...PSR, dateRange: TODAY_RANGE })).data!)).toHaveLength(2);
    });

    it('delivers camt.054 notifications once after a positive receipt', async () => {
      await upload(ctx, buildPain001Document({ msgId: 'MSG-C54', payments: [payment(ctx, 'C54')] }));

      const first = await download(ctx, 'BTD', C54);
      expect(first.code).toBe('000000');
      const files = readZip(first.data!);
      expect(files.map((f) => f.name)).toEqual(['camt.054.xml']);
      const xml = files[0]!.content.toString('utf8');
      expect(texts(xml, 'Ntfctn/Ntry/NtryDtls/TxDtls/Refs/EndToEndId')).toContain('E2E-C54');
      expect(texts(xml, 'Ntfctn/Ntry/NtryDtls/TxDtls/RmtInf/Ustrd')).toContain('Auszahlung C54');

      // Negative receipt: nothing is marked delivered
      await receipt(ctx, first.transactionId!, 1);
      const again = await download(ctx, 'BTD', C54);
      expect(again.code).toBe('000000');

      await receipt(ctx, again.transactionId!, 0);
      expect((await download(ctx, 'BTD', C54)).code).toBe('090005');
    });

    it('serves camt.052 for today and 090005 for a range without bookings', async () => {
      await upload(ctx, buildPain001Document({ msgId: 'MSG-C52', payments: [payment(ctx, 'C52')] }));

      const report = await download(ctx, 'BTD', C52);
      expect(report.code).toBe('000000');
      const xml = readZip(report.data!)[0]!.content.toString('utf8');
      expect(texts(xml, 'Rpt/Acct/Id/IBAN')).toContain(ctx.debtor.iban);
      expect(texts(xml, 'Rpt/Ntry/NtryDtls/TxDtls/Refs/EndToEndId')).toContain('E2E-C52');
      expect(texts(xml, 'Rpt/Ntry/AcctSvcrRef').length).toBeGreaterThan(0);

      expect((await download(ctx, 'BTD', { ...C52, dateRange: { start: '2020-01-01', end: '2020-01-02' } })).code).toBe('090005');
    });
  });

  describe('SEPA Instant with EDS hold', () => {
    beforeEach(() => {
      process.env['EBICS_EDS_HOLD'] = 'true';
    });

    it('holds the order until release, then books and reports ACSC', async () => {
      await upload(ctx, buildPain001Document({ msgId: 'MSG-HOLD', payments: [payment(ctx, 'HOLD')] }));
      const [order] = ctx.store.listPaymentOrders();
      expect(order!.status).toBe('PENDING_EDS');
      expect(ctx.store.getAccount(ctx.debtor.id)!.currentBalanceCents).toBe(1_000_000);
      expect(ctx.store.listHacEvents({ orderId: order!.orderId }).map((e) => e.action)).toEqual(['FILE_UPLOAD', 'ES_VERIFICATION', 'VEU_FORWARDING']);

      const released = await api(ctx, `/payments/${order!.id}/release`, { method: 'POST' });
      expect(released.status).toBe(200);
      expect(released.json.status).toBe('EXECUTED');
      expect(released.json.statusEvents.map((e: any) => e.status)).toEqual(['ACTC', 'ACSC']);
      expect(released.json.transactions[0].debitBookingId).toBeTypeOf('number');
      expect(ctx.store.getAccount(ctx.debtor.id)!.currentBalanceCents).toBe(1_000_000 - 1234);

      const events = ctx.store.listHacEvents({ orderId: order!.orderId });
      expect(events.map((e) => e.action)).toEqual(['FILE_UPLOAD', 'ES_VERIFICATION', 'VEU_FORWARDING', 'VEU_VERIFICATION_END', 'ORDER_HAC_FINAL_POS']);
      expect(events.at(-1)!.userId).toBeUndefined();
      expect(events.at(-1)!.additionalInfo.some((l) => l.startsWith('Sammlerreferenz') && l.endsWith('PMT-HOLD'))).toBe(true);

      const again = await api(ctx, `/payments/${order!.id}/release`, { method: 'POST' });
      expect(again.status).toBe(400);
      expect(again.json.error).toMatch(/PENDING_EDS/);
    });

    it('cancels in the VEU with VEU_CANCEL_ORDER and a positive final for the original order', async () => {
      await upload(ctx, buildPain001Document({ msgId: 'MSG-CANCEL', payments: [payment(ctx, 'CANCEL')] }));
      const [order] = ctx.store.listPaymentOrders();

      const cancelled = await api(ctx, `/payments/${order!.id}/cancel`, { method: 'POST', body: { additionalInfo: ['by test'] } });
      expect(cancelled.json.status).toBe('CANCELLED');
      expect(cancelled.json.statusEvents.at(-1)).toMatchObject({ status: 'RJCT', reasonCode: 'DS02', additionalInfo: ['by test'] });
      expect(ctx.store.getAccount(ctx.debtor.id)!.currentBalanceCents).toBe(1_000_000);

      const events = ctx.store.listHacEvents({ partnerId: PARTNER_ID });
      const cancel = events.find((e) => e.action === 'VEU_CANCEL_ORDER')!;
      expect(cancel).toMatchObject({ adminOrderType: 'HVS', orderIdRef: order!.orderId, adminOrderTypeRef: 'BTU', reasonCode: 'DS02', userId: USER_ID });
      expect(cancel.orderId).not.toBe(order!.orderId);

      const finalPos = events.find((e) => e.action === 'ORDER_HAC_FINAL_POS' && e.orderId === order!.orderId)!;
      const reference = finalPos.additionalInfo.find((l) => l.trim().startsWith('Sammlerreferenz'))!;
      expect(reference.split(':')[1]!.trim()).toBe('PMT-CANCEL');
    });

    it('rejects with a negative final and RJCT', async () => {
      await upload(ctx, buildPain001Document({ msgId: 'MSG-REJECT', payments: [payment(ctx, 'REJECT')] }));
      const [order] = ctx.store.listPaymentOrders();

      const rejected = await api(ctx, `/payments/${order!.id}/reject`, { method: 'POST', body: { reasonCode: 'AM04' } });
      expect(rejected.json.status).toBe('REJECTED');
      expect(rejected.json.statusEvents.at(-1)).toMatchObject({ status: 'RJCT', reasonCode: 'AM04' });
      const last = ctx.store.listHacEvents({ orderId: order!.orderId }).at(-1)!;
      expect(last.action).toBe('ORDER_HAC_FINAL_NEG');
      expect(last.additionalInfo.length).toBeGreaterThan(0);

      const defaultReason = await (async () => {
        await upload(ctx, buildPain001Document({ msgId: 'MSG-REJECT2', payments: [payment(ctx, 'REJECT2')] }));
        const pending = ctx.store.listPaymentOrders({ status: 'PENDING_EDS' })[0]!;
        return (await api(ctx, `/payments/${pending.id}/reject`, { method: 'POST' })).json;
      })();
      expect(defaultReason.statusEvents.at(-1)).toMatchObject({ status: 'RJCT', reasonCode: 'DS04' });
    });

    it('executes uploads without requestEDS immediately even with the hold on', async () => {
      await upload(ctx, buildPain001Document({ msgId: 'MSG-NOEDS', payments: [payment(ctx, 'NOEDS')] }), { scope: 'DE', serviceOption: 'VOI' });
      expect(ctx.store.listPaymentOrders()[0]!.status).toBe('EXECUTED');
    });
  });

  describe('Verification of Payee report', () => {
    it('reports group and transaction status with the corrected name', async () => {
      await upload(
        ctx,
        buildPain001Document({
          msgId: 'MSG-VOP',
          payments: [
            payment(ctx, 'VOP', [
              { endToEndId: 'E2E-CLOSE', creditorName: 'Mustermann Bob', creditorIban: ctx.creditor.iban, amount: '1.00' },
              { endToEndId: 'E2E-FOREIGN', creditorName: 'Irgendwer', creditorIban: ctx.foreignIban, amount: '2.00' },
            ]),
          ],
        }),
      );

      const report = await download(ctx, 'BTD', VOP);
      expect(report.code).toBe('000000');
      const xml = readZip(report.data!)[0]!.content.toString('utf8');
      expect(texts(xml, 'OrgnlGrpInfAndSts/OrgnlMsgId')).toEqual(['MSG-VOP']);
      expect(texts(xml, 'OrgnlGrpInfAndSts/GrpSts')).toEqual(['RVMC']);
      expect(texts(xml, 'TxInfAndSts/OrgnlEndToEndId')).toEqual(['E2E-CLOSE', 'E2E-FOREIGN']);
      expect(texts(xml, 'TxInfAndSts/TxSts')).toEqual(['RVMC', 'RCVC']);
      expect(texts(xml, 'TxInfAndSts/StsRsnInf/AddtlInf')).toEqual(['RVMC Bob Mustermann']);

      const order = ctx.store.listPaymentOrders()[0]!;
      const close = ctx.store.listPaymentTransactions(order.id)[0]!;

      const invalid = await api(ctx, `/payments/${order.id}/transactions/${close.id}/vop`, { method: 'PATCH', body: { status: 'RVMC' } });
      expect(invalid.status).toBe(400);
      const unknown = await api(ctx, `/payments/${order.id}/transactions/${close.id}/vop`, { method: 'PATCH', body: { status: 'XXXX' } });
      expect(unknown.status).toBe(400);

      const overridden = await api(ctx, `/payments/${order.id}/transactions/${close.id}/vop`, { method: 'PATCH', body: { status: 'RCVC' } });
      expect(overridden.status).toBe(200);
      expect(overridden.json.vopGroupStatus).toBe('RCVC');

      await receipt(ctx, report.transactionId!);
      expect((await download(ctx, 'BTD', VOP)).code).toBe('090005');
      const ranged = await download(ctx, 'BTD', { ...VOP, dateRange: TODAY_RANGE });
      const rangedXml = readZip(ranged.data!)[0]!.content.toString('utf8');
      expect(texts(rangedXml, 'OrgnlGrpInfAndSts/GrpSts')).toEqual(['RCVC']);
      expect(texts(rangedXml, 'TxInfAndSts/StsRsnInf/AddtlInf')).toEqual([]);
    });
  });

  describe('HAC customer protocol', () => {
    it('keeps the legacy format by default', async () => {
      const hac = await download(ctx, 'HAC');
      expect(hac.code).toBe('000000');
      expect(decryptDownloadResponse(hac.body, ctx.keys.encKeyPair.privateKey).orderData).toContain('HACResponseOrderData');
    });

    it('returns the pain.002 customer protocol with EBICS_HAC_FORMAT=pain.002', async () => {
      process.env['EBICS_HAC_FORMAT'] = 'pain.002';
      const { initBody } = await upload(ctx, buildPain001Document({ msgId: 'MSG-HAC', payments: [payment(ctx, 'HAC')] }));
      const orderId = readOrderId(initBody)!;

      const hac = await download(ctx, 'HAC');
      expect(hac.code).toBe('000000');
      const xml = hac.data!.toString('utf8');
      expect(xml).toContain('urn:iso:std:iso:20022:tech:xsd:pain.002.001.03');
      expect(texts(xml, 'OrgnlPmtInfAndSts/OrgnlPmtInfId')).toEqual([
        'FILE_UPLOAD', 'FILE_UPLOAD', 'ORDER_HAC_FINAL_POS', 'ORDER_HAC_FINAL_POS', // INI, HIA, activation
        'FILE_UPLOAD', 'ES_VERIFICATION', 'ORDER_HAC_FINAL_POS', // the upload
      ]);
      const doc = parseXml(xml);
      const blocks = Array.from(doc.getElementsByTagNameNS('*', 'OrgnlPmtInfAndSts'));
      const attributes = (block: (typeof blocks)[number]) =>
        Object.fromEntries(Array.from(block.getElementsByTagNameNS('*', 'Othr')).map((o) => [
          o.getElementsByTagNameNS('*', 'Prtry').item(0)!.textContent,
          o.getElementsByTagNameNS('*', 'Id').item(0)!.textContent,
        ]));
      expect(attributes(blocks[0]!)).toMatchObject({ PartnerID: PARTNER_ID, AdminOrderType: 'INI', OrderID: readOrderId(ctx.iniBody), UserID: USER_ID });
      expect(attributes(blocks[4]!)).toMatchObject({ AdminOrderType: 'BTU', ServiceName: 'SCI', ServiceOption: 'VOI', MsgName: 'pain.001', OrderID: orderId, UserID: USER_ID });
      expect(attributes(blocks[6]!)).not.toHaveProperty('UserID');
      expect(texts(xml, 'StsRsnInf/Rsn/Cd')).toEqual(['TS01', 'TS01', 'TS01', 'DS01']);
      expect(texts(xml, 'StsRsnInf/Orgtr/Nm')[0]).toBe(`${PARTNER_ID} / ${USER_ID}`);

      await receipt(ctx, hac.transactionId!);
      expect((await download(ctx, 'HAC')).code).toBe('090005');

      const ranged = await download(ctx, 'HAC', undefined, { dateRange: TODAY_RANGE });
      expect(texts(ranged.data!.toString('utf8'), 'OrgnlPmtInfAndSts/OrgnlPmtInfId')).toHaveLength(7);
    });
  });

  describe('ZIP container for existing statements', () => {
    it('zips camt.053 only when the request asks for a container', async () => {
      ctx.store.createBooking({ accountId: ctx.debtor.id, amountCents: 700, currency: 'EUR', valueDate: TODAY, bookingDate: TODAY, counterpartyName: 'Stripe', endToEndId: 'E2E-STMT', transactionCode: 'NTRF' });
      const zipped = await download(ctx, 'BTD', { serviceName: 'EOP', scope: 'DE', containerType: 'ZIP', msgName: 'camt.053' });
      expect(zipped.code).toBe('000000');
      const files = readZip(zipped.data!);
      expect(files.map((f) => f.name)).toEqual(['camt.053.xml']);
      const xml = files[0]!.content.toString('utf8');
      expect(texts(xml, 'BkToCstmrStmt/Stmt/Acct/Id/IBAN')).toContain(ctx.debtor.iban);
      expect(texts(xml, 'Stmt/Ntry/NtryDtls/TxDtls/Refs/TxId').length).toBeGreaterThan(0);

      const plain = await download(ctx, 'BTD', { serviceName: 'EOP', msgName: 'camt.053' });
      const plainXml = plain.data!.toString('utf8');
      expect(plainXml.trimStart().startsWith('<?xml')).toBe(true);
      expect(plainXml).toContain('BkToCstmrStmt');
    });

    it('zips seeded static data as well', async () => {
      ctx.store.upsertDownloadData('STA', 'mt940', ':20:STATIC', 'text');
      const zipped = await download(ctx, 'BTD', { serviceName: 'STA', containerType: 'ZIP', msgName: 'mt940' });
      const files = readZip(zipped.data!);
      expect(files).toEqual([{ name: 'mt940.txt', content: Buffer.from(':20:STATIC') }]);
    });
  });

  describe('rejected uploads', () => {
    it('returns 091302 and records a negative final when the debtor account is not accessible', async () => {
      const foreignDebtor = { ...payment(ctx, 'AUTH'), debtorIban: ctx.foreignIban };
      const { initBody, transferBody } = await upload(ctx, buildPain001Document({ msgId: 'MSG-AUTH', payments: [foreignDebtor] }));
      expect(readBusinessReturnCode(transferBody)).toBe('091302');
      expect(ctx.store.listPaymentOrders()).toHaveLength(0);

      const events = ctx.store.listHacEvents({ orderId: readOrderId(initBody)! });
      expect(events.map((e) => [e.action, e.reasonCode])).toEqual([
        ['FILE_UPLOAD', 'TS01'],
        ['ES_VERIFICATION', 'TD03'],
        ['ORDER_HAC_FINAL_NEG', undefined],
      ]);
      expect(events[2]!.additionalInfo[0]).toMatch(/debtor account/);
    });
  });

  describe('admin API', () => {
    it('exposes the feature flags', async () => {
      expect((await api(ctx, '/config/flags')).json).toEqual({
        hacFormat: 'legacy', edsHold: false, vopDefault: 'RCVC', strictValidation: true, allowPreActivation: false,
      });
      process.env['EBICS_HAC_FORMAT'] = 'pain.002';
      process.env['EBICS_EDS_HOLD'] = 'true';
      process.env['EBICS_VOP_DEFAULT'] = 'RVNA';
      expect((await api(ctx, '/config/flags')).json).toMatchObject({ hacFormat: 'pain.002', edsHold: true, vopDefault: 'RVNA' });
    });

    it('lists, filters and reports payment orders', async () => {
      process.env['EBICS_EDS_HOLD'] = 'true';
      await upload(ctx, buildPain001Document({ msgId: 'MSG-API', payments: [payment(ctx, 'API1'), payment(ctx, 'API2')] }));

      const all = await api(ctx, '/payments');
      expect(all.json).toHaveLength(2);
      expect(all.json[0]).toMatchObject({ status: 'PENDING_EDS', vopGroupStatus: 'RCVC', totalCents: 1234 });
      expect(all.json[0].transactions).toHaveLength(1);
      expect((await api(ctx, '/payments?status=EXECUTED')).json).toEqual([]);
      expect((await api(ctx, `/payments?partnerId=${PARTNER_ID}&status=PENDING_EDS`)).json).toHaveLength(2);
      expect((await api(ctx, '/payments?status=NOPE')).status).toBe(400);
      expect((await api(ctx, '/payments/9999')).status).toBe(404);

      // Release acts on the whole EBICS order (both PmtInfs)
      const id = all.json[0].id;
      await api(ctx, `/payments/${id}/release`, { method: 'POST' });
      expect((await api(ctx, '/payments?status=EXECUTED')).json).toHaveLength(2);

      const added = await api(ctx, `/payments/${id}/status-events`, { method: 'POST', body: { status: 'RJCT', reasonCode: 'AC04', additionalInfo: ['closed', ''] } });
      expect(added.status).toBe(200);
      expect(added.json.statusEvents.at(-1)).toMatchObject({ status: 'RJCT', reasonCode: 'AC04', additionalInfo: ['closed'] });
      expect(added.json.status).toBe('EXECUTED');
      expect((await api(ctx, `/payments/${id}/status-events`, { method: 'POST', body: { status: 'NOPE' } })).status).toBe(400);

      const statusReport = await api(ctx, `/payments/${id}/status-report`);
      expect(statusReport.contentType).toContain('application/xml');
      expect(texts(statusReport.text, 'OrgnlPmtInfAndSts/PmtInfSts')).toEqual(['RJCT']);

      const vopReport = await api(ctx, `/payments/${id}/vop-report`);
      expect(texts(vopReport.text, 'OrgnlPmtInfAndSts/OrgnlPmtInfId').sort()).toEqual(['PMT-API1', 'PMT-API2']);
    });

    it('reads and appends HAC events and previews the report', async () => {
      const events = await api(ctx, `/hac-events?partnerId=${PARTNER_ID}`);
      expect(events.json.map((e: any) => e.action)).toEqual(['FILE_UPLOAD', 'FILE_UPLOAD', 'ORDER_HAC_FINAL_POS', 'ORDER_HAC_FINAL_POS']);
      expect(events.json.every((e: any) => e.delivered === false)).toBe(true);

      const created = await api(ctx, '/hac-events', { method: 'POST', body: { partnerId: PARTNER_ID, action: 'ADDITIONAL', adminOrderType: 'BTU', additionalInfo: ['Hinweis', ''] } });
      expect(created.status).toBe(201);
      expect(created.json.orderId).toMatch(/^[A-Z][A-Z0-9]{3}$/);
      expect(created.json.additionalInfo).toEqual(['Hinweis']);
      expect((await api(ctx, `/hac-events?orderId=${created.json.orderId}&partnerId=${PARTNER_ID}`)).json).toHaveLength(1);
      expect((await api(ctx, '/hac-events', { method: 'POST', body: { partnerId: PARTNER_ID } })).status).toBe(400);

      expect((await api(ctx, '/hac/report')).status).toBe(400);
      const report = await api(ctx, `/hac/report?partnerId=${PARTNER_ID}`);
      expect(report.contentType).toContain('application/xml');
      expect(texts(report.text, 'OrgnlPmtInfAndSts/OrgnlPmtInfId')).toHaveLength(5);

      process.env['EBICS_HAC_FORMAT'] = 'pain.002';
      const hac = await download(ctx, 'HAC');
      await receipt(ctx, hac.transactionId!);
      expect((await api(ctx, `/hac-events?partnerId=${PARTNER_ID}`)).json.every((e: any) => e.delivered)).toBe(true);

      expect((await api(ctx, '/deliveries/reset', { method: 'POST', body: { kind: 'nope' } })).status).toBe(400);
      const reset = await api(ctx, '/deliveries/reset', { method: 'POST', body: { partnerId: PARTNER_ID, kind: 'hac' } });
      expect(reset.json).toEqual({ reset: 5 });
      expect((await download(ctx, 'HAC')).code).toBe('000000');
      expect((await api(ctx, '/deliveries/reset', { method: 'POST' })).json).toEqual({ reset: 0 });
    });

    it('previews camt.052 and camt.054 statements', async () => {
      await upload(ctx, buildPain001Document({ msgId: 'MSG-PREVIEW', payments: [payment(ctx, 'PREVIEW')] }));
      const c52 = await api(ctx, `/banking/accounts/${ctx.debtor.id}/statement?format=camt.052&from=${TODAY}&to=${TODAY}`);
      expect(c52.contentType).toContain('application/xml');
      expect(c52.text).toContain('BkToCstmrAcctRpt');
      const c54 = await api(ctx, `/banking/accounts/${ctx.debtor.id}/statement?format=camt.054`);
      expect(c54.text).toContain('BkToCstmrDbtCdtNtfctn');
      expect(texts(c54.text, 'Ntry/NtryDtls/TxDtls/Refs/EndToEndId')).toContain('E2E-PREVIEW');
    });
  });

  describe('advertised order types', () => {
    it('lists the new services in HKD', async () => {
      const hkd = await download(ctx, 'HKD');
      const xml = hkd.data!.toString('utf8');
      for (const [service, msg] of [['SCI', 'pain.001'], ['STM', 'camt.052'], ['STM', 'camt.054'], ['REP', 'pain.002'], ['EOP', 'camt.053']]) {
        expect(xml).toMatch(new RegExp(`<ServiceName>${service}</ServiceName>[\\s\\S]*?<MsgName>${msg}</MsgName>`));
      }
      expect(xml).toContain('<ServiceOption>VOP</ServiceOption>');
    });
  });
});
