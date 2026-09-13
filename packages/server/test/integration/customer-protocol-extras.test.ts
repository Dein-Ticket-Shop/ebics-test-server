import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp, postEbics, HOST_ID, PARTNER_ID, USER_ID } from '../helpers/test-server.js';
import {
  buildPain001Document,
  buildPain008Document,
  readBusinessReturnCode,
  readOrderId,
  type DownloadParams,
  type Pain001Payment,
} from '../helpers/test-client.js';
import { enrolSubscriber, uploadOrder, downloadOrder, sendReceipt, localTexts, type EbicsSession } from '../helpers/ebics-session.js';
import { parseXml, xpathString } from '../../src/protocol/xml-parser.js';
import { calculateIban } from '../../src/banking/iban.js';
import type { SqliteStore } from '../../src/store/sqlite-store.js';
import type { Account, HacEvent } from '../../src/store/types.js';

const FLAGS = [
  'EBICS_HAC_FORMAT',
  'EBICS_EDS_HOLD',
  'EBICS_VOP_DEFAULT',
  'EBICS_VOP_CONFIRMATION',
  'EBICS_HAC_DOWNLOAD_EVENTS',
  'EBICS_STRICT_VALIDATION',
] as const;

const TODAY = new Date().toISOString().slice(0, 10);
const PSR: DownloadParams = { serviceName: 'REP', scope: 'DE', serviceOption: 'SCI', containerType: 'ZIP', msgName: 'pain.002' };
const EVENT_LINE = /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2} /;

interface Ctx {
  app: ReturnType<typeof createTestApp>['app'];
  store: SqliteStore;
  session: EbicsSession;
  /** The partner's own account, created on activation */
  account: Account;
}

async function setup(beforeEnrol?: (store: SqliteStore) => void): Promise<Ctx> {
  const { app, store } = createTestApp();
  beforeEnrol?.(store);
  const session = await enrolSubscriber({
    post: async (xml) => (await postEbics(app, xml)).text(),
    activate: (partnerId, userId) => app.request(`/api/subscribers/${partnerId}/${userId}/activate`, { method: 'POST' }),
    store,
    partnerId: PARTNER_ID,
    userId: USER_ID,
  });
  return { app, store, session, account: store.listAccountsForPartner(PARTNER_ID)[0]! };
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

function technicalCode(body: string): string | undefined {
  return xpathString('//ebics:header/ebics:mutable/ebics:ReturnCode/text()', parseXml(body));
}

function eventLines(text: string): string[] {
  return text.split('\r\n').filter((line) => EVENT_LINE.test(line));
}

/** dd.mm.yyyy hh:mm:ss (UTC) as printed in the protocol */
function protocolTimestamp(iso: string): string {
  const [date, time] = iso.split('T');
  const [year, month, day] = date!.split('-');
  return `${day}.${month}.${year} ${time!.slice(0, 8)}`;
}

/** Fixed-width event line: timestamp, order type (11), OrderID (7), user (10), action text and reason code */
function expectedEventLine(event: HacEvent, actionText: string): string {
  const reason = event.reasonCode ? ` (${event.reasonCode})` : '';
  return `${protocolTimestamp(event.eventAt)} ${event.adminOrderType.padEnd(11)} ${event.orderId.padEnd(7)} ${(event.userId ?? '').padEnd(10)} ${actionText}${reason}`;
}

/** A second customer at this bank (creditor for credit transfers, debtor for direct debits) plus funds on the partner's account */
function prepareAccounts(ctx: Ctx): Account {
  ctx.store.createBooking({ accountId: ctx.account.id, amountCents: 1_000_000, currency: 'EUR', valueDate: '2025-01-01', bookingDate: '2025-01-01', transactionCode: 'NTRF' });
  const bob = ctx.store.createPerson({ name: 'Bob Mustermann', country: 'DE' });
  const accountNumber = ctx.store.getNextAccountSequence().toString().padStart(10, '0');
  return ctx.store.createAccount({ personId: bob.id, iban: calculateIban('10020030', accountNumber), accountNumber, currency: 'EUR', name: 'Bob Konto' });
}

function creditTransfer(ctx: Ctx, creditor: Account, id: string): string {
  const payment: Pain001Payment = {
    pmtInfId: `PMT-${id}`,
    debtorName: 'Musterfirma GmbH',
    debtorIban: ctx.account.iban,
    transactions: [{ endToEndId: `E2E-${id}`, creditorName: 'Bob Mustermann', creditorIban: creditor.iban, amount: '12.34', remittance: `Auszahlung ${id}` }],
  };
  return buildPain001Document({ msgId: `MSG-${id}`, payments: [payment] });
}

describe('Customer protocol extras', () => {
  let ctx: Ctx;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const flag of FLAGS) {
      saved[flag] = process.env[flag];
      delete process.env[flag];
    }
  });

  afterEach(() => {
    for (const flag of FLAGS) {
      if (saved[flag] === undefined) delete process.env[flag];
      else process.env[flag] = saved[flag];
    }
  });

  describe('PTK customer protocol text', () => {
    it('renders the HAC ledger as text with header, one line per event and CRLF line endings', async () => {
      ctx = await setup();
      const ptk = await downloadOrder(ctx.session, 'PTK');
      expect(ptk.code).toBe('000000');

      const text = ptk.data!.toString('latin1');
      expect(text.endsWith('\r\n')).toBe(true);
      expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);

      const lines = text.split('\r\n');
      expect(lines[0]).toBe('K U N D E N P R O T O K O L L');
      expect(lines[1]).toBe(`Host-ID    : ${HOST_ID}`);
      expect(lines[2]).toBe(`Kunden-ID  : ${PARTNER_ID}  ${PARTNER_ID} / ${USER_ID}`);
      expect(lines[3]).toMatch(/^Erstellt   : \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2} UTC$/);
      expect(lines[4]).toMatch(/^=+$/);
      expect(lines.at(-2)).toMatch(/^=+$/);
      expect(lines.at(-1)).toBe('');

      const events = ctx.store.listHacEvents({ partnerId: PARTNER_ID });
      expect(events.map((e) => e.action)).toEqual(['FILE_UPLOAD', 'FILE_UPLOAD', 'ORDER_HAC_FINAL_POS', 'ORDER_HAC_FINAL_POS']);
      expect(eventLines(text)).toEqual([
        expectedEventLine(events[0]!, 'Datei-Upload'),
        expectedEventLine(events[1]!, 'Datei-Upload'),
        expectedEventLine(events[2]!, 'Auftrag abgeschlossen (positiv)'),
        expectedEventLine(events[3]!, 'Auftrag abgeschlossen (positiv)'),
      ]);

      const iniOrderId = readOrderId(ctx.session.iniBody)!;
      expect(eventLines(text)[0]).toMatch(new RegExp(` INI {9}${iniOrderId} {4}${USER_ID} {6}Datei-Upload \\(TS01\\)$`));
      // FINAL events carry no user
      expect(eventLines(text)[2]).toMatch(new RegExp(` INI {9}${iniOrderId} {15}Auftrag abgeschlossen \\(positiv\\)$`));
    });

    it('prints BTF, Bezug and additional info lines below an event', async () => {
      ctx = await setup();
      process.env['EBICS_EDS_HOLD'] = 'true';
      const creditor = prepareAccounts(ctx);
      await uploadOrder(ctx.session, creditTransfer(ctx, creditor, 'PTK'));
      const [order] = ctx.store.listPaymentOrders();
      expect((await api(ctx, `/payments/${order!.id}/cancel`, { method: 'POST' })).status).toBe(200);

      const ptk = await downloadOrder(ctx.session, 'PTK');
      const lines = ptk.data!.toString('latin1').split('\r\n');
      const events = ctx.store.listHacEvents({ partnerId: PARTNER_ID });

      const upload = events.find((e) => e.action === 'FILE_UPLOAD' && e.orderId === order!.orderId)!;
      const uploadLine = lines.indexOf(expectedEventLine(upload, 'Datei-Upload'));
      expect(uploadLine).toBeGreaterThan(0);
      expect(lines[uploadLine + 1]).toMatch(/^ {4}BTF {6}: SCI( \/ DE)? \/ VOI \/ pain\.001$/);

      const cancel = events.find((e) => e.action === 'VEU_CANCEL_ORDER')!;
      const cancelLine = lines.indexOf(expectedEventLine(cancel, 'Storno in der VEU'));
      expect(cancelLine).toBeGreaterThan(uploadLine);
      expect(lines[cancelLine]).toMatch(/ HVS {9}[A-Z][A-Z0-9]{3} {4}USER1 {6}Storno in der VEU \(DS02\)$/);
      // The BTF line is only printed when the event carries service attributes
      const hasBtf = Boolean(cancel.serviceName || cancel.scope || cancel.serviceOption || cancel.containerType || cancel.msgName);
      if (hasBtf) expect(lines[cancelLine + 1]).toMatch(/^ {4}BTF {6}: /);
      expect(lines[cancelLine + (hasBtf ? 2 : 1)]).toBe(`    Bezug    : BTU ${order!.orderId}`);

      const finalPos = events.find((e) => e.action === 'ORDER_HAC_FINAL_POS' && e.orderId === order!.orderId)!;
      expect(finalPos.additionalInfo.length).toBeGreaterThan(0);
      const finalLine = lines.indexOf(expectedEventLine(finalPos, 'Auftrag abgeschlossen (positiv)'));
      expect(finalLine).toBeGreaterThan(cancelLine);
      const infoStart = finalLine + 2; // after the BTF line
      expect(lines.slice(infoStart, infoStart + finalPos.additionalInfo.length)).toEqual(finalPos.additionalInfo.map((l) => `    ${l}`));
    });

    it('encodes umlauts as ISO-8859-1', async () => {
      ctx = await setup();
      const info = 'Überweisung an Müller, Größe ß';
      const created = await api(ctx, '/hac-events', {
        method: 'POST',
        body: { partnerId: PARTNER_ID, userId: USER_ID, action: 'ADDITIONAL', adminOrderType: 'BTU', additionalInfo: [info] },
      });
      expect(created.status).toBe(201);

      const ptk = await downloadOrder(ctx.session, 'PTK');
      const data = ptk.data!;
      expect(data.includes(Buffer.from(`    ${info}\r\n`, 'latin1'))).toBe(true);
      expect(data.includes(Buffer.from('ü', 'utf8'))).toBe(false);
      expect(data.indexOf(0xfc)).toBeGreaterThan(-1); // ü
      expect(data.indexOf(0xdf)).toBeGreaterThan(-1); // ß
      expect(data.toString('latin1')).toContain(info);
      expect(eventLines(data.toString('latin1')).at(-1)).toMatch(/Zusatzinformation$/);
    });

    it('replaces characters outside ISO-8859-1 with "?"', async () => {
      ctx = await setup();
      const created = await api(ctx, '/hac-events', {
        method: 'POST',
        body: { partnerId: PARTNER_ID, userId: USER_ID, action: 'ADDITIONAL', adminOrderType: 'BTU', additionalInfo: ['Gebühr 5 € – bezahlt'] },
      });
      expect(created.status).toBe(201);

      const ptk = await downloadOrder(ctx.session, 'PTK');
      expect(ptk.data!.includes(Buffer.from('    Gebühr 5 ? ? bezahlt\r\n', 'latin1'))).toBe(true);
    });

    it('returns only events not yet delivered via PTK, marked on a positive receipt', async () => {
      ctx = await setup();
      const first = await downloadOrder(ctx.session, 'PTK');
      expect(eventLines(first.data!.toString('latin1'))).toHaveLength(4);

      // Negative receipt: nothing is marked delivered
      await sendReceipt(ctx.session, first.transactionId!, 1);
      const again = await downloadOrder(ctx.session, 'PTK');
      expect(again.code).toBe('000000');
      expect(eventLines(again.data!.toString('latin1'))).toHaveLength(4);

      await sendReceipt(ctx.session, again.transactionId!, 0);
      expect((await downloadOrder(ctx.session, 'PTK')).code).toBe('090005');

      const reset = await api(ctx, '/deliveries/reset', { method: 'POST', body: { partnerId: PARTNER_ID, kind: 'ptk' } });
      expect(reset.json).toEqual({ reset: 4 });
      const afterReset = await downloadOrder(ctx.session, 'PTK');
      expect(eventLines(afterReset.data!.toString('latin1'))).toHaveLength(4);
      await sendReceipt(ctx.session, afterReset.transactionId!, 0);
      expect((await downloadOrder(ctx.session, 'PTK')).code).toBe('090005');

      // HAC keeps its own delivery state
      process.env['EBICS_HAC_FORMAT'] = 'pain.002';
      const hac = await downloadOrder(ctx.session, 'HAC');
      expect(hac.code).toBe('000000');
      expect(localTexts(hac.data!.toString('utf8'), 'OrgnlPmtInfAndSts/OrgnlPmtInfId')).toHaveLength(4);

      await api(ctx, '/hac-events', { method: 'POST', body: { partnerId: PARTNER_ID, action: 'ADDITIONAL', adminOrderType: 'BTU', additionalInfo: ['neu'] } });
      const next = await downloadOrder(ctx.session, 'PTK');
      expect(next.code).toBe('000000');
      const lines = eventLines(next.data!.toString('latin1'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/Zusatzinformation$/);
    });

    it('returns all events of the requested days with a DateRange, regardless of deliveries', async () => {
      ctx = await setup((store) => {
        store.appendHacEvent({
          partnerId: PARTNER_ID,
          userId: USER_ID,
          orderId: 'Z999',
          action: 'ADDITIONAL',
          adminOrderType: 'BTU',
          additionalInfo: ['Altes Ereignis'],
          eventAt: '2025-01-15T08:30:00.000Z',
        });
      });

      const old = await downloadOrder(ctx.session, 'PTK', undefined, { dateRange: { start: '2025-01-15', end: '2025-01-15' } });
      expect(old.code).toBe('000000');
      const oldText = old.data!.toString('latin1');
      expect(eventLines(oldText)).toEqual([`15.01.2025 08:30:00 BTU${' '.repeat(9)}Z999${' '.repeat(4)}${USER_ID}${' '.repeat(6)}Zusatzinformation`]);
      expect(oldText.split('\r\n')).toContain('    Altes Ereignis');
      await sendReceipt(ctx.session, old.transactionId!, 0);

      const today = await downloadOrder(ctx.session, 'PTK', undefined, { dateRange: { start: TODAY, end: TODAY } });
      const todayLines = eventLines(today.data!.toString('latin1'));
      expect(todayLines).toHaveLength(4);
      expect(todayLines.some((l) => l.includes('Z999'))).toBe(false);
      await sendReceipt(ctx.session, today.transactionId!, 0);

      // Ranged downloads are not marked delivered
      const unranged = await downloadOrder(ctx.session, 'PTK');
      expect(eventLines(unranged.data!.toString('latin1'))).toHaveLength(5);

      expect((await downloadOrder(ctx.session, 'PTK', undefined, { dateRange: { start: '2020-01-01', end: '2020-01-02' } })).code).toBe('090005');
    });

    it('previews the protocol of a partner in the admin API', async () => {
      ctx = await setup();
      expect((await api(ctx, '/ptk/report')).status).toBe(400);

      const info = 'Prüfung für Müller';
      await api(ctx, '/hac-events', { method: 'POST', body: { partnerId: PARTNER_ID, action: 'ADDITIONAL', adminOrderType: 'BTU', additionalInfo: [info] } });

      const preview = await api(ctx, `/ptk/report?partnerId=${PARTNER_ID}`);
      expect(preview.status).toBe(200);
      expect(preview.contentType).toContain('text/plain');
      expect(preview.text.startsWith(`K U N D E N P R O T O K O L L\r\nHost-ID    : ${HOST_ID}\r\nKunden-ID  : ${PARTNER_ID}  ${PARTNER_ID} / ${USER_ID}\r\n`)).toBe(true);
      expect(eventLines(preview.text)).toHaveLength(5);
      expect(preview.text).toContain(`    ${info}\r\n`);

      // The preview ignores the delivery state
      const ptk = await downloadOrder(ctx.session, 'PTK');
      await sendReceipt(ctx.session, ptk.transactionId!, 0);
      expect((await downloadOrder(ctx.session, 'PTK')).code).toBe('090005');
      expect(eventLines((await api(ctx, `/ptk/report?partnerId=${PARTNER_ID}`)).text)).toHaveLength(5);

      const unknown = await api(ctx, '/ptk/report?partnerId=NOBODY');
      expect(unknown.status).toBe(200);
      expect(unknown.text.split('\r\n')[2]).toBe('Kunden-ID  : NOBODY  NOBODY');
      expect(eventLines(unknown.text)).toEqual([]);
    });
  });

  describe('protocol download permission per subscriber', () => {
    beforeEach(async () => {
      ctx = await setup();
    });

    const subscriberPath = `/subscribers/${PARTNER_ID}/${USER_ID}`;
    const setPermission = (allowed: unknown) => api(ctx, subscriberPath, { method: 'PATCH', body: { protocolDownloadsAllowed: allowed } });
    /** HAC/PTK entries in HKD/HTD: two OrderInfo entries of the partner plus two Permission entries per permitted user */
    const protocolOrderTypes = (xml: string) => xml.match(/AdminOrderType>(HAC|PTK)</g)?.length ?? 0;

    it('is allowed for new subscribers', async () => {
      process.env['EBICS_HAC_FORMAT'] = 'pain.002';
      expect((await api(ctx, subscriberPath)).json.protocolDownloadsAllowed).toBe(true);
      expect((await downloadOrder(ctx.session, 'HAC')).code).toBe('000000');
      expect((await downloadOrder(ctx.session, 'PTK')).code).toBe('000000');
      expect(protocolOrderTypes((await downloadOrder(ctx.session, 'HTD')).data!.toString('utf8'))).toBe(4);
    });

    it('answers HAC and PTK with 090003 when switched off and drops them from the user permissions', async () => {
      process.env['EBICS_HAC_DOWNLOAD_EVENTS'] = 'true';
      process.env['EBICS_HAC_FORMAT'] = 'pain.002';

      const updated = await setPermission(false);
      expect(updated.status).toBe(200);
      expect(updated.json).toMatchObject({ partnerId: PARTNER_ID, userId: USER_ID, protocolDownloadsAllowed: false });
      expect(ctx.store.getSubscriber(PARTNER_ID, USER_ID)!.protocolDownloadsAllowed).toBe(false);
      expect((await api(ctx, '/subscribers')).json[0].protocolDownloadsAllowed).toBe(false);

      const eventsBefore = ctx.store.listHacEvents().length;
      for (const orderType of ['HAC', 'PTK']) {
        const denied = await downloadOrder(ctx.session, orderType);
        expect(denied.code).toBe('090003');
        expect(technicalCode(denied.body)).toBe('000000');
        expect(xpathString('//ebics:header/ebics:static/ebics:TransactionID/text()', parseXml(denied.body))).toBeFalsy();
        // with a DateRange as well
        expect((await downloadOrder(ctx.session, orderType, undefined, { dateRange: { start: TODAY, end: TODAY } })).code).toBe('090003');
      }
      // A denied download is no download: no FILE_DOWNLOAD event
      expect(ctx.store.listHacEvents()).toHaveLength(eventsBefore);

      // Other order types are not affected; the partner still offers HAC/PTK, the user is no longer permitted
      const hkd = await downloadOrder(ctx.session, 'HKD');
      expect(hkd.code).toBe('000000');
      expect(protocolOrderTypes(hkd.data!.toString('utf8'))).toBe(2);
      expect(protocolOrderTypes((await downloadOrder(ctx.session, 'HTD')).data!.toString('utf8'))).toBe(2);

      // Switched on again
      expect((await setPermission(true)).json.protocolDownloadsAllowed).toBe(true);
      expect((await downloadOrder(ctx.session, 'PTK')).code).toBe('000000');
    });

    it('validates the admin update', async () => {
      expect((await setPermission('no')).status).toBe(400);
      expect((await api(ctx, subscriberPath, { method: 'PATCH' })).status).toBe(400);
      expect((await api(ctx, '/subscribers/NOPE/NOBODY', { method: 'PATCH', body: { protocolDownloadsAllowed: false } })).status).toBe(404);
      expect(ctx.store.getSubscriber(PARTNER_ID, USER_ID)!.protocolDownloadsAllowed).toBe(true);
    });
  });

  describe('FILE_DOWNLOAD events', () => {
    beforeEach(async () => {
      ctx = await setup();
    });

    const fileDownloads = () => ctx.store.listHacEvents({ partnerId: PARTNER_ID }).filter((e) => e.action === 'FILE_DOWNLOAD');

    it('are not recorded by default', async () => {
      expect((await downloadOrder(ctx.session, 'HKD')).code).toBe('000000');
      expect((await downloadOrder(ctx.session, 'BTD', { serviceName: 'EOP', msgName: 'camt.053' })).code).toBe('000000');
      expect(fileDownloads()).toEqual([]);
    });

    it('record every successful download except HAC and PTK with EBICS_HAC_DOWNLOAD_EVENTS=true', async () => {
      process.env['EBICS_HAC_DOWNLOAD_EVENTS'] = 'true';
      process.env['EBICS_HAC_FORMAT'] = 'pain.002';
      const creditor = prepareAccounts(ctx);
      const { orderId: uploadOrderId } = await uploadOrder(ctx.session, creditTransfer(ctx, creditor, 'DL'));
      expect(fileDownloads()).toEqual([]);

      expect((await downloadOrder(ctx.session, 'HKD')).code).toBe('000000');
      expect((await downloadOrder(ctx.session, 'BTD', PSR)).code).toBe('000000');
      expect((await downloadOrder(ctx.session, 'BTD', { serviceName: 'EOP', msgName: 'camt.053' })).code).toBe('000000');
      // No data, no download
      expect((await downloadOrder(ctx.session, 'BTD', { ...PSR, dateRange: { start: '2020-01-01', end: '2020-01-02' } })).code).toBe('090005');
      expect((await downloadOrder(ctx.session, 'HAC')).code).toBe('000000');
      expect((await downloadOrder(ctx.session, 'PTK')).code).toBe('000000');

      const events = fileDownloads();
      expect(events.map((e) => e.adminOrderType)).toEqual(['HKD', 'BTD', 'BTD']);
      expect(events[0]).toMatchObject({ userId: USER_ID, reasonCode: 'TS01', additionalInfo: [] });
      expect(events[0]!.serviceName).toBeUndefined();
      expect(events[1]).toMatchObject({
        userId: USER_ID, reasonCode: 'TS01', serviceName: 'REP', scope: 'DE', serviceOption: 'SCI', containerType: 'ZIP', msgName: 'pain.002',
      });
      expect(events[2]).toMatchObject({ serviceName: 'EOP', msgName: 'camt.053' });
      expect(events[2]!.scope).toBeUndefined();
      expect(events[2]!.serviceOption).toBeUndefined();
      expect(events[2]!.containerType).toBeUndefined();

      // Each download is an order of its own
      const otherOrderIds = new Set(ctx.store.listHacEvents({ partnerId: PARTNER_ID }).filter((e) => e.action !== 'FILE_DOWNLOAD').map((e) => e.orderId));
      expect(otherOrderIds.has(uploadOrderId!)).toBe(true);
      const downloadOrderIds = events.map((e) => e.orderId);
      expect(new Set(downloadOrderIds).size).toBe(3);
      for (const orderId of downloadOrderIds) {
        expect(orderId).toMatch(/^[A-Z][A-Z0-9]{3}$/);
        expect(otherOrderIds.has(orderId)).toBe(false);
      }

      // Listed in the customer protocol
      const ptk = await downloadOrder(ctx.session, 'PTK', undefined, { dateRange: { start: TODAY, end: TODAY } });
      const lines = ptk.data!.toString('latin1').split('\r\n');
      expect(eventLines(lines.join('\r\n')).filter((l) => l.endsWith('Datei-Download (TS01)'))).toHaveLength(3);
      expect(lines).toContain('    BTF      : REP / DE / SCI / ZIP / pain.002');
      expect(fileDownloads()).toHaveLength(3);
    });
  });

  describe('pain.008 protocol text', () => {
    beforeEach(async () => {
      ctx = await setup();
    });

    it('adds the direct debit summary to ORDER_HAC_FINAL_POS', async () => {
      const debtor = prepareAccounts(ctx);
      const creditor = ctx.account;
      const document = buildPain008Document({
        msgId: 'MSG-SDD',
        payments: [
          {
            pmtInfId: 'PMT-SDD-1',
            creditorName: 'Musterfirma GmbH',
            creditorIban: creditor.iban,
            collectionDate: '2026-10-01',
            transactions: [
              { endToEndId: 'E2E-SDD-1', debtorName: 'Bob Mustermann', debtorIban: debtor.iban, amount: '1234.50', mandateId: 'MNDT-1' },
              { endToEndId: 'E2E-SDD-2', debtorName: 'Erika Musterfrau', debtorIban: 'DE02120300000000202051', amount: '0.55', mandateId: 'MNDT-2' },
            ],
          },
          {
            pmtInfId: 'PMT-SDD-2',
            creditorName: 'Musterfirma GmbH',
            creditorIban: creditor.iban,
            collectionDate: '2026-12-24',
            transactions: [{ endToEndId: 'E2E-SDD-3', debtorName: 'Bob Mustermann', debtorIban: debtor.iban, amount: '10.00', mandateId: 'MNDT-1' }],
          },
        ],
      });

      const { transferBody, orderId } = await uploadOrder(ctx.session, document, { serviceName: 'SDD', msgName: 'pain.008', upload: { scope: 'DE' } });
      expect(readBusinessReturnCode(transferBody)).toBe('000000');

      const events = ctx.store.listHacEvents({ partnerId: PARTNER_ID, orderId: orderId! });
      expect(events.map((e) => e.action)).toEqual(['FILE_UPLOAD', 'ES_VERIFICATION', 'ORDER_HAC_FINAL_POS']);
      expect(events[0]).toMatchObject({ adminOrderType: 'BTU', serviceName: 'SDD', msgName: 'pain.008' });

      const text = events[2]!.additionalInfo;
      const bic = ctx.store.getBankConfig()!.bic;
      expect(text[0]).toMatch(/^=+$/);
      expect(text.slice(1, 3)).toEqual(['L A S T S C H R I F T E N', 'Datei-ID   : MSG-SDD']);
      expect(text[3]).toMatch(/^Datum\/Zeit : \d{2}\.\d{2}\.\d{4}\/\d{2}:\d{2}:\d{2}/);
      const section = (pmtInfId: string, count: number, sum: string, due: string) => [
        `Sammlerreferenz          : ${pmtInfId}`,
        `Bank-Code                : ${bic}`,
        `Kontonummer              : ${creditor.iban}`,
        'Auftraggeberdaten        : Musterfirma GmbH',
        `Anzahl der Zahlungssaetze: ${count}`,
        `Summe der Betraege (EUR) : ${sum}`,
        `Faelligkeitsdatum        : ${due}`,
      ];
      expect(text[4]).toMatch(/^-+$/);
      expect(text.slice(5, 12)).toEqual(section('PMT-SDD-1', 2, '1235,05', '01.10.2026'));
      expect(text[12]).toMatch(/^-+$/);
      expect(text.slice(13, 20)).toEqual(section('PMT-SDD-2', 1, '10,00', '24.12.2026'));
      expect(text[20]).toMatch(/^=+$/);
      expect(text).toHaveLength(21);

      // Shows up in both customer protocols
      const ptk = (await downloadOrder(ctx.session, 'PTK')).data!.toString('latin1');
      expect(ptk).toContain('    L A S T S C H R I F T E N\r\n');
      expect(ptk).toContain('    Summe der Betraege (EUR) : 1235,05\r\n');

      process.env['EBICS_HAC_FORMAT'] = 'pain.002';
      const hac = (await downloadOrder(ctx.session, 'HAC')).data!.toString('utf8');
      expect(localTexts(hac, 'StsRsnInf/AddtlInf')).toEqual(expect.arrayContaining(['Faelligkeitsdatum        : 24.12.2026', 'Datei-ID   : MSG-SDD']));
    });

    it('does not add it to a rejected direct debit', async () => {
      const document = buildPain008Document({
        msgId: 'MSG-SDD-REJ',
        payments: [
          {
            pmtInfId: 'PMT-SDD-REJ',
            creditorName: 'Fremde Bank Kunde',
            creditorIban: calculateIban('37040044', '0532013000'),
            transactions: [{ endToEndId: 'E2E-REJ', debtorName: 'Bob', debtorIban: ctx.account.iban, amount: '1.00', mandateId: 'M' }],
          },
        ],
      });
      const { transferBody, orderId } = await uploadOrder(ctx.session, document, { serviceName: 'SDD', msgName: 'pain.008', upload: { scope: 'DE' } });
      expect(readBusinessReturnCode(transferBody)).toBe('091302');

      const events = ctx.store.listHacEvents({ partnerId: PARTNER_ID, orderId: orderId! });
      expect(events.map((e) => e.action)).toEqual(['FILE_UPLOAD', 'ES_VERIFICATION', 'ORDER_HAC_FINAL_NEG']);
      expect(events[2]!.additionalInfo.join('\n')).toMatch(/creditor account/);
      expect(events[2]!.additionalInfo).not.toContain('L A S T S C H R I F T E N');
    });
  });
});
