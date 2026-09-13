import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/logger.js')>();
  return { ...actual, logError: vi.fn() };
});

import { logError } from '../../src/logger.js';
import { validatePayload, isValidatablePayload } from '../../src/protocol/xml-validator.js';
import { generateCamt052 } from '../../src/banking/generators/camt052.js';
import { generateCamt053, generateCamt053Multi } from '../../src/banking/generators/camt053.js';
import { generateCamt054 } from '../../src/banking/generators/camt054.js';
import { generateHacReport, generatePaymentStatusReport, generateVopReport } from '../../src/banking/generators/pain002.js';
import { calculateIban } from '../../src/banking/iban.js';
import { createTestApp, postEbics, PARTNER_ID, USER_ID } from '../helpers/test-server.js';
import { buildPain001Document, type DownloadParams } from '../helpers/test-client.js';
import { enrolSubscriber, uploadOrder, downloadOrder, sendReceipt } from '../helpers/ebics-session.js';
import { readZip } from '../../src/protocol/zip.js';
import type {
  Account,
  BankConfig,
  Booking,
  HacEvent,
  PaymentOrder,
  PaymentStatusCode,
  PaymentStatusEvent,
  PaymentTransaction,
  Person,
  VopStatus,
} from '../../src/store/types.js';

const bankConfig: BankConfig = { blz: '10020030', name: 'EBICS Test Bank AG', bic: 'ETBADE2AXXX' };
const person: Person = { id: 1, name: 'Musterfirma GmbH & Co. KG <Test>', country: 'DE', createdAt: '' };
const account: Account = { id: 3, personId: 1, iban: 'DE89370400440532013000', accountNumber: '0532013000', currency: 'EUR', name: 'Konto', currentBalanceCents: 0, createdAt: '' };
const emptyAccount: Account = { ...account, id: 4, iban: 'DE02120300000000202051' };

function booking(overrides: Partial<Booking>): Booking {
  return { id: 1, accountId: 3, amountCents: 100, currency: 'EUR', valueDate: '2026-09-12', bookingDate: '2026-09-12', transactionCode: 'NTRF', createdAt: '', ...overrides };
}

const bookings: Booking[] = [
  booking({ id: 1, amountCents: -1234, counterpartyName: 'Max Mustermann', counterpartyIban: 'DE02120300000000202051', remittanceInfo: 'Auszahlung 42', endToEndId: 'E2E0001' }),
  booking({ id: 2, amountCents: 5000, counterpartyName: 'Stripe', remittanceInfo: 'po_1' }),
  // no counterparty, no remittance information, no end-to-end ID
  booking({ id: 3, amountCents: 700 }),
  booking({ id: 4, amountCents: -1 }),
  booking({ id: 5, amountCents: 0, transactionCode: 'NDDT' }),
  booking({ id: 6, amountCents: 250, counterpartyName: 'Jörg Übermaß & Söhne <GmbH>', counterpartyIban: 'DE89370400440532013000', counterpartyBic: 'COBADEFFXXX', remittanceInfo: 'Rechnung "42" & mehr' }),
  booking({ id: 7, amountCents: -99_999_999, counterpartyIban: 'DE02120300000000202051', endToEndId: 'NOTPROVIDED' }),
];

const order: PaymentOrder = {
  id: 1, orderId: 'A001', partnerId: 'P1', userId: 'U1', serviceName: 'SCI', serviceOption: 'VOI', msgName: 'pain.001',
  msgId: 'MSG-0001', pmtInfId: 'PMT-0001', debtorName: 'Shop', debtorIban: account.iban, requestedEds: true,
  vopConfirmationRequired: false, status: 'EXECUTED',
  createdAt: '2026-09-12T10:00:00.000Z', updatedAt: '2026-09-12T10:00:00.000Z',
};

function transaction(overrides: Partial<PaymentTransaction>): PaymentTransaction {
  return { id: 1, paymentOrderId: 1, endToEndId: 'E1', creditorName: 'Max', creditorIban: 'DE02120300000000202051', amountCents: 1234, currency: 'EUR', vopStatus: 'RCVC', ...overrides };
}

function statusEvent(overrides: Partial<PaymentStatusEvent>): PaymentStatusEvent {
  return { id: 5, paymentOrderId: 1, status: 'ACSC', additionalInfo: [], createdAt: '2026-09-12T10:00:01.000Z', ...overrides };
}

function hacEvent(overrides: Partial<HacEvent>): HacEvent {
  return { id: 1, partnerId: 'P1', orderId: 'A001', action: 'FILE_UPLOAD', adminOrderType: 'BTU', additionalInfo: [], eventAt: '2026-09-12T10:00:00.000Z', ...overrides };
}

function expectValid(xml: string): void {
  expect(isValidatablePayload(xml)).toBe(true);
  expect(() => validatePayload(xml)).not.toThrow();
}

const LONG_LINE = 'Lorem ipsum dolor sit amet, consetetur sadipscing elitr, sed diam nonumy eirmod tempor invidunt ut labore et dolore magna aliquyam erat, sed diam voluptua.';

describe('ISO 20022 payload validation', () => {
  describe('camt generators', () => {
    it('camt.052 with all booking variants, a negative opening balance and an account without bookings', () => {
      expectValid(
        generateCamt052(
          [
            { account, person, bankConfig, bookings, openingBalanceCents: -5000 },
            { account: emptyAccount, person, bankConfig, bookings: [], openingBalanceCents: 0 },
          ],
          '2026-09-01',
          '2026-09-12',
        ),
      );
    });

    it('camt.053 with several statements and a statement without bookings', () => {
      expectValid(
        generateCamt053Multi(
          [
            { account, person, bankConfig, bookings, openingBalanceCents: 10_000 },
            { account: emptyAccount, person, bankConfig, bookings: [], openingBalanceCents: -1 },
          ],
          '2026-09-01',
          '2026-09-12',
        ),
      );
      expectValid(generateCamt053(emptyAccount, person, bankConfig, [], 0, '2026-09-12', '2026-09-12'));
    });

    it('camt.054 with all booking variants, skipping accounts without bookings', () => {
      expectValid(
        generateCamt054([
          { account: emptyAccount, person, bankConfig, bookings: [] },
          { account, person, bankConfig, bookings },
        ]),
      );
      for (const single of bookings) {
        expectValid(generateCamt054([{ account, person, bankConfig, bookings: [single] }]));
      }
    });
  });

  describe('pain.002 generators', () => {
    const transactions = [transaction({ id: 1 }), transaction({ id: 2, endToEndId: undefined, creditorName: undefined, creditorIban: undefined, amountCents: 1 })];

    it('payment status reports for every status, with and without bank BIC', () => {
      const statuses: PaymentStatusCode[] = ['ACTC', 'ACCP', 'ACSP', 'ACSC', 'ACWC', 'RJCT'];
      for (const status of statuses) {
        expectValid(generatePaymentStatusReport(order, transactions, statusEvent({ status }), 'ETBADE2AXXX'));
        expectValid(generatePaymentStatusReport(order, transactions, statusEvent({ status })));
      }
    });

    it('payment status reports with reason code, long additional info and transactions without end-to-end ID', () => {
      const long = `${LONG_LINE} ${LONG_LINE}`;
      expect(long.length).toBeGreaterThan(210);
      expectValid(generatePaymentStatusReport(order, transactions, statusEvent({ status: 'RJCT', reasonCode: 'AM04', additionalInfo: [long, 'kurz', 'x'.repeat(105), 'y'.repeat(106)] })));
      expectValid(generatePaymentStatusReport(order, transactions, statusEvent({ status: 'RJCT', additionalInfo: ['Storniert in der VEU'] })));
      expectValid(generatePaymentStatusReport(order, transactions, statusEvent({ status: 'RJCT', reasonCode: 'DS02' })));
      expectValid(generatePaymentStatusReport(order, [transaction({ endToEndId: undefined })], statusEvent({})));
    });

    it('VoP reports for every group status, RVMC with corrected names and several PmtInfs', () => {
      const statuses: VopStatus[] = ['RCVC', 'RVMC', 'RVNM', 'RVNA'];
      for (const status of statuses) {
        expectValid(generateVopReport('MSG-0001', [{ order, transactions: [transaction({ vopStatus: status, vopCorrectedName: status === 'RVMC' ? 'Erika Mustermann' : undefined })] }], order.createdAt));
      }

      const second: PaymentOrder = { ...order, id: 2, pmtInfId: 'PMT-0002' };
      expectValid(
        generateVopReport(
          'MSG-0001',
          [
            {
              order,
              transactions: [
                transaction({ id: 1, vopStatus: 'RVMC', vopCorrectedName: 'Jörg Müller-Lüdenscheidt' }),
                transaction({ id: 2, vopStatus: 'RVMC', vopCorrectedName: 'N'.repeat(140) }),
                transaction({ id: 3, vopStatus: 'RVMC' }),
                transaction({ id: 4, vopStatus: 'RVNM', endToEndId: undefined }),
              ],
            },
            { order: second, transactions: [transaction({ id: 5, paymentOrderId: 2, vopStatus: 'RVNA' })] },
          ],
          order.createdAt,
        ),
      );
    });

    it('HAC customer protocol with all attributes, long additional info and FINAL events without user', () => {
      const events: HacEvent[] = [
        hacEvent({
          id: 1, userId: 'U1', orderId: 'A002', action: 'VEU_CANCEL_ORDER', adminOrderType: 'HVS',
          serviceName: 'SCI', scope: 'DE', serviceOption: 'VOI', containerType: 'ZIP', msgName: 'pain.001',
          orderIdRef: 'A001', adminOrderTypeRef: 'BTU', reasonCode: 'DS02',
          additionalInfo: [LONG_LINE, 'x'.repeat(105), 'y'.repeat(106), 'Überweisung für Müller & Söhne <GmbH>'],
        }),
        hacEvent({ id: 2, action: 'ORDER_HAC_FINAL_POS', additionalInfo: ['='.repeat(60), 'L A S T S C H R I F T E N'], eventAt: '2026-09-12T10:00:00.001Z' }),
        hacEvent({ id: 3, userId: 'U1', action: 'FILE_DOWNLOAD', adminOrderType: 'BTD', serviceName: 'REP', msgName: 'pain.002', reasonCode: 'TS01', eventAt: '2026-09-12T10:00:00.002Z' }),
        hacEvent({ id: 4, action: 'VEU_VERIFICATION_END', eventAt: '2026-09-12T10:00:00.003Z' }),
      ];
      expectValid(generateHacReport(events, { bankBic: 'ETBADE2AXXX', customerName: (p) => `Kunde ${p}` }));
      expectValid(generateHacReport(events, { customerName: () => 'Jörg & Söhne' }));
    });

    it('HAC customer protocol without events', () => {
      expectValid(generateHacReport([], { bankBic: 'ETBADE2AXXX', customerName: (p) => p }));
    });
  });

  describe('schema violations', () => {
    const camt054 = generateCamt054([{ account, person, bankConfig, bookings }]);

    it('throws for a document missing a mandatory element', () => {
      const broken = camt054.replace(/<CreDtTm>[^<]*<\/CreDtTm>/, '');
      expect(broken).not.toBe(camt054);
      expect(() => validatePayload(broken)).toThrow();
    });

    it('throws for an invalid code value', () => {
      const report = generatePaymentStatusReport(order, [transaction({})], statusEvent({ status: 'ACSC' }));
      const broken = report.replace('<PmtInfSts>ACSC</PmtInfSts>', '<PmtInfSts>ACCEPTED</PmtInfSts>');
      expect(broken).not.toBe(report);
      expect(() => validatePayload(broken)).toThrow();
    });

    it('throws for an unexpected element in the HAC protocol', () => {
      const report = generateHacReport([hacEvent({})], { customerName: (p) => p });
      const broken = report.replace('<OrgnlGrpInfAndSts>', '<Unexpected/><OrgnlGrpInfAndSts>');
      expect(broken).not.toBe(report);
      expect(() => validatePayload(broken)).toThrow();
    });

    it('throws for additional info longer than 105 characters', () => {
      const report = generateHacReport([hacEvent({ additionalInfo: ['short'] })], { customerName: (p) => p });
      expect(() => validatePayload(report.replace('>short<', `>${'z'.repeat(106)}<`))).toThrow();
    });

    it('throws for a wrong root element or a document that is not well-formed', () => {
      expect(() => validatePayload('<Foo xmlns="urn:iso:std:iso:20022:tech:xsd:camt.052.001.08"/>')).toThrow();
      expect(() => validatePayload('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>')).toThrow();
    });

    it('detects prefixed root elements, a BOM and leading comments', () => {
      const prefixed = '﻿<?xml version="1.0" encoding="UTF-8"?>\n<!-- generated -->\n<ns:Document xmlns:ns="urn:iso:std:iso:20022:tech:xsd:camt.054.001.08"><ns:Broken/></ns:Document>';
      expect(isValidatablePayload(prefixed)).toBe(true);
      expect(() => validatePayload(prefixed.replace(/^﻿/, ''))).toThrow();
    });
  });

  describe('documents in other formats', () => {
    it('are ignored', () => {
      const others = [
        buildPain001Document({ msgId: 'M', payments: [] }).replace('<GrpHdr>', '<Garbage/><GrpHdr>'),
        '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><Garbage/></Document>',
        '<ebicsRequest xmlns="urn:org:ebics:H005"><nonsense/></ebicsRequest>',
        '<Wrapper><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><Garbage/></Document></Wrapper>',
        '<Document><Garbage/></Document>',
        ':20:STATIC\r\n:25:10020030/0532013000',
        '{"URL":"http://localhost/realtime","TOKEN":"x"}',
        '',
      ];
      for (const document of others) {
        expect(isValidatablePayload(document)).toBe(false);
        expect(() => validatePayload(document)).not.toThrow();
      }
    });
  });

  describe('dispatcher', () => {
    const FLAGS = ['EBICS_HAC_FORMAT', 'EBICS_VOP_DEFAULT', 'EBICS_VOP_CONFIRMATION', 'EBICS_STRICT_VALIDATION', 'EBICS_HAC_DOWNLOAD_EVENTS'] as const;
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const flag of FLAGS) {
        saved[flag] = process.env[flag];
        delete process.env[flag];
      }
      vi.mocked(logError).mockClear();
    });

    afterEach(() => {
      for (const flag of FLAGS) {
        if (saved[flag] === undefined) delete process.env[flag];
        else process.env[flag] = saved[flag];
      }
    });

    async function enrolled() {
      const { app, store } = createTestApp();
      const session = await enrolSubscriber({
        post: async (xml) => (await postEbics(app, xml)).text(),
        activate: (partnerId, userId) => app.request(`/api/subscribers/${partnerId}/${userId}/activate`, { method: 'POST' }),
        store,
        partnerId: PARTNER_ID,
        userId: USER_ID,
      });
      return { app, store, session };
    }

    const payloadErrors = () => vi.mocked(logError).mock.calls.filter(([context]) => context.includes('payload XSD validation'));

    it('logs schema violations of served documents but still delivers them', async () => {
      const { store, session } = await enrolled();
      const broken = generateCamt053Multi([{ account, person, bankConfig, bookings: [], openingBalanceCents: 0 }], '2026-09-12', '2026-09-12').replace(/<CreDtTm>[^<]*<\/CreDtTm>/, '');
      store.upsertDownloadData('EOP', 'camt.053', broken, 'text');

      const result = await downloadOrder(session, 'BTD', { serviceName: 'EOP', msgName: 'camt.053' });
      expect(result.code).toBe('000000');
      expect(result.data!.toString('utf8')).toBe(broken);
      expect(payloadErrors()).toHaveLength(1);
      expect(payloadErrors()[0]![0]).toBe('BTD payload XSD validation (server bug)');
    });

    it('serves schema-valid documents for a complete payment flow', async () => {
      process.env['EBICS_HAC_FORMAT'] = 'pain.002';
      const { store, session } = await enrolled();
      const debtor = store.listAccountsForPartner(PARTNER_ID)[0]!;
      store.createBooking({ accountId: debtor.id, amountCents: 1_000_000, currency: 'EUR', valueDate: '2025-01-01', bookingDate: '2025-01-01', transactionCode: 'NTRF' });
      const bob = store.createPerson({ name: 'Bob Mustermann', country: 'DE' });
      const accountNumber = store.getNextAccountSequence().toString().padStart(10, '0');
      const creditor = store.createAccount({ personId: bob.id, iban: calculateIban('10020030', accountNumber), accountNumber, currency: 'EUR', name: 'Bob Konto' });

      const long = `Verwendungszweck ${'X'.repeat(120)}`.slice(0, 140);
      await uploadOrder(
        session,
        buildPain001Document({
          msgId: 'MSG-XSD',
          payments: [
            {
              pmtInfId: 'PMT-XSD',
              debtorName: 'Musterfirma GmbH',
              debtorIban: debtor.iban,
              transactions: [
                { endToEndId: 'E2E-XSD-1', creditorName: 'Mustermann Bob', creditorIban: creditor.iban, amount: '12.34', remittance: long },
                { endToEndId: 'E2E-XSD-2', creditorName: 'Irgendwer', creditorIban: calculateIban('37040044', '0532013000'), amount: '0.01' },
              ],
            },
          ],
        }),
      );

      const today = new Date().toISOString().slice(0, 10);
      const zipped: DownloadParams[] = [
        { serviceName: 'REP', scope: 'DE', serviceOption: 'SCI', containerType: 'ZIP', msgName: 'pain.002' },
        { serviceName: 'REP', scope: 'DE', serviceOption: 'VOP', containerType: 'ZIP', msgName: 'pain.002' },
        { serviceName: 'STM', scope: 'DE', serviceOption: 'SCI', containerType: 'ZIP', msgName: 'camt.054' },
        { serviceName: 'STM', scope: 'DE', containerType: 'ZIP', msgName: 'camt.052' },
      ];
      for (const params of zipped) {
        const result = await downloadOrder(session, 'BTD', params);
        expect(result.code, params.msgName).toBe('000000');
        for (const file of readZip(result.data!)) expectValid(file.content.toString('utf8'));
        await sendReceipt(session, result.transactionId!);
      }
      const statement = await downloadOrder(session, 'BTD', { serviceName: 'EOP', msgName: 'camt.053', dateRange: { start: today, end: today } });
      expectValid(statement.data!.toString('utf8'));
      const hac = await downloadOrder(session, 'HAC');
      expectValid(hac.data!.toString('utf8'));

      expect(payloadErrors()).toEqual([]);
    });
  });
});
