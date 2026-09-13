import { describe, it, expect } from 'vitest';
import { parseXml, xpathSelect } from '../../src/protocol/xml-parser.js';
import { generateCamt052 } from '../../src/banking/generators/camt052.js';
import { generateCamt053Multi } from '../../src/banking/generators/camt053.js';
import { generateCamt054 } from '../../src/banking/generators/camt054.js';
import {
  generateHacReport,
  generatePaymentStatusReport,
  generateVopReport,
  vopGroupStatus,
} from '../../src/banking/generators/pain002.js';
import type { Account, BankConfig, Booking, HacEvent, PaymentOrder, PaymentTransaction, Person } from '../../src/store/types.js';

/** Elements for a path of local names, e.g. `Rpt/Ntry` (matched anywhere in the document) */
function nodes(xml: string, path: string): Element[] {
  const expression = '//' + path.split('/').map((name) => `*[local-name()='${name}']`).join('/');
  return xpathSelect(expression, parseXml(xml)) as unknown as Element[];
}

function texts(xml: string, path: string): string[] {
  return nodes(xml, path).map((n) => n.textContent ?? '');
}

function childNames(element: Element): string[] {
  const names: string[] = [];
  for (let i = 0; i < element.childNodes.length; i++) {
    const child = element.childNodes.item(i) as Element;
    if (child.nodeType === 1) names.push(child.localName);
  }
  return names;
}

const bankConfig: BankConfig = { blz: '10020030', name: 'Test Bank', bic: 'ETBADE2AXXX' };
const person: Person = { id: 1, name: 'Musterfirma GmbH', country: 'DE', createdAt: '' };
const account: Account = { id: 3, personId: 1, iban: 'DE89370400440532013000', accountNumber: '1', currency: 'EUR', name: 'Konto', currentBalanceCents: 0, createdAt: '' };
const otherAccount: Account = { ...account, id: 4, iban: 'DE02120300000000202051' };
const debit: Booking = { id: 7, accountId: 3, amountCents: -1234, currency: 'EUR', valueDate: '2026-09-12', bookingDate: '2026-09-12', counterpartyName: 'Max Mustermann', counterpartyIban: 'DE02120300000000202051', remittanceInfo: 'Auszahlung 42', endToEndId: 'E2E0001', transactionCode: 'NTRF', createdAt: '' };
const credit: Booking = { id: 8, accountId: 3, amountCents: 5000, currency: 'EUR', valueDate: '2026-09-12', bookingDate: '2026-09-12', counterpartyName: 'Stripe', remittanceInfo: 'po_1', transactionCode: 'NTRF', createdAt: '' };

describe('report generators', () => {
  describe('camt.053', () => {
    const xml = generateCamt053Multi([{ account, person, bankConfig, bookings: [debit, credit], openingBalanceCents: 10000 }], '2026-09-01', '2026-09-12');

    it('adds AcctSvcrRef between ValDt and BkTxCd', () => {
      const entry = nodes(xml, 'Stmt/Ntry')[0]!;
      const names = childNames(entry);
      expect(names.indexOf('AcctSvcrRef')).toBe(names.indexOf('ValDt') + 1);
      expect(names.indexOf('BkTxCd')).toBe(names.indexOf('AcctSvcrRef') + 1);
      expect(texts(xml, 'Stmt/Ntry/AcctSvcrRef')).toEqual(['ETB000000000007', 'ETB000000000008']);
    });

    it('puts Refs first in TxDtls with AcctSvcrRef, EndToEndId and TxId', () => {
      const [debitDetails, creditDetails] = nodes(xml, 'NtryDtls/TxDtls');
      expect(childNames(debitDetails!)[0]).toBe('Refs');
      expect(childNames(nodes(xml, 'TxDtls/Refs')[0]!)).toEqual(['AcctSvcrRef', 'EndToEndId', 'TxId']);
      expect(childNames(nodes(xml, 'TxDtls/Refs')[1]!)).toEqual(['AcctSvcrRef', 'TxId']);
      expect(childNames(creditDetails!)).toEqual(['Refs', 'RltdPties', 'RmtInf']);
      expect(texts(xml, 'Refs/TxId')).toEqual(['TX000000000007', 'TX000000000008']);
    });
  });

  describe('camt.052', () => {
    it('reports one Rpt per account with opening and interim booked balance', () => {
      const xml = generateCamt052(
        [
          { account, person, bankConfig, bookings: [debit, credit], openingBalanceCents: 10000 },
          { account: otherAccount, person, bankConfig, bookings: [], openingBalanceCents: 0 },
        ],
        '2026-09-12',
        '2026-09-12',
      );
      expect(nodes(xml, 'Document/BkToCstmrAcctRpt')).toHaveLength(1);
      expect(xml).toContain('urn:iso:std:iso:20022:tech:xsd:camt.052.001.08');
      expect(texts(xml, 'Rpt/Acct/Id/IBAN')).toEqual([account.iban, otherAccount.iban]);
      expect(texts(xml, 'Rpt/Bal/Tp/CdOrPrtry/Cd')).toEqual(['OPBD', 'ITBD', 'OPBD', 'ITBD']);
      expect(texts(xml, 'Rpt/Bal/Amt').slice(0, 2)).toEqual(['100.00', '137.66']);
      expect(texts(xml, 'Rpt/Ntry/CdtDbtInd')).toEqual(['DBIT', 'CRDT']);
      expect(texts(xml, 'Rpt/Ntry/NtryDtls/TxDtls/Refs/EndToEndId')).toEqual(['E2E0001']);
      expect(texts(xml, 'Rpt/Id').every((id) => id.length <= 35)).toBe(true);
    });
  });

  describe('camt.054', () => {
    it('emits one Ntfctn per account with bookings', () => {
      const xml = generateCamt054([
        { account, person, bankConfig, bookings: [debit] },
        { account: otherAccount, person, bankConfig, bookings: [] },
      ]);
      expect(xml).toContain('urn:iso:std:iso:20022:tech:xsd:camt.054.001.08');
      expect(nodes(xml, 'BkToCstmrDbtCdtNtfctn/Ntfctn')).toHaveLength(1);
      expect(texts(xml, 'Ntfctn/Acct/Id/IBAN')).toEqual([account.iban]);
      expect(texts(xml, 'Ntfctn/Ntry/Sts/Cd')).toEqual(['BOOK']);
      expect(texts(xml, 'Ntfctn/Ntry/NtryDtls/TxDtls/RltdPties/Cdtr/Pty/Nm')).toEqual(['Max Mustermann']);
    });
  });

  const order: PaymentOrder = {
    id: 1, orderId: 'A001', partnerId: 'P1', userId: 'U1', serviceName: 'SCI', serviceOption: 'VOI', msgName: 'pain.001',
    msgId: 'MSG-0001', pmtInfId: 'PMT-0001', debtorName: 'Shop', debtorIban: account.iban, requestedEds: true,
    status: 'EXECUTED', createdAt: '2026-09-12T10:00:00.000Z', updatedAt: '2026-09-12T10:00:00.000Z',
  };
  const transactions: PaymentTransaction[] = [
    { id: 1, paymentOrderId: 1, endToEndId: 'E1', creditorName: 'Max', creditorIban: 'DE1', amountCents: 1234, currency: 'EUR', vopStatus: 'RCVC' },
    { id: 2, paymentOrderId: 1, endToEndId: 'E2', creditorName: 'Mustermann', amountCents: 66, currency: 'EUR', vopStatus: 'RVMC', vopCorrectedName: 'Erika Mustermann' },
  ];

  describe('pain.002 payment status report', () => {
    it('reports the status of one PmtInf', () => {
      const xml = generatePaymentStatusReport(order, transactions, { id: 5, paymentOrderId: 1, status: 'ACSC', additionalInfo: [], createdAt: '2026-09-12T10:00:01.000Z' }, 'ETBADE2AXXX');
      expect(xml).toContain('urn:iso:std:iso:20022:tech:xsd:pain.002.001.10');
      expect(texts(xml, 'GrpHdr/CreDtTm')).toEqual(['2026-09-12T10:00:01.000Z']);
      expect(texts(xml, 'GrpHdr/DbtrAgt/FinInstnId/BICFI')).toEqual(['ETBADE2AXXX']);
      expect(texts(xml, 'OrgnlGrpInfAndSts/OrgnlMsgId')).toEqual(['MSG-0001']);
      expect(texts(xml, 'OrgnlGrpInfAndSts/OrgnlMsgNmId')).toEqual(['pain.001.001.09']);
      expect(texts(xml, 'OrgnlPmtInfAndSts/OrgnlPmtInfId')).toEqual(['PMT-0001']);
      expect(texts(xml, 'OrgnlPmtInfAndSts/OrgnlNbOfTxs')).toEqual(['2']);
      expect(texts(xml, 'OrgnlPmtInfAndSts/OrgnlCtrlSum')).toEqual(['13.00']);
      expect(texts(xml, 'OrgnlPmtInfAndSts/PmtInfSts')).toEqual(['ACSC']);
      expect(nodes(xml, 'OrgnlPmtInfAndSts/StsRsnInf')).toHaveLength(0);
      expect(texts(xml, 'TxInfAndSts/OrgnlEndToEndId')).toEqual(['E1', 'E2']);
      expect(texts(xml, 'TxInfAndSts/TxSts')).toEqual(['ACSC', 'ACSC']);
      expect(texts(xml, 'GrpHdr/MsgId')[0]!.length).toBeLessThanOrEqual(35);
    });

    it('adds reason code and additional info for a rejection', () => {
      const xml = generatePaymentStatusReport(order, transactions, { id: 6, paymentOrderId: 1, status: 'RJCT', reasonCode: 'DS02', additionalInfo: ['Cancelled in VEU'], createdAt: '2026-09-12T10:00:02.000Z' });
      expect(texts(xml, 'OrgnlPmtInfAndSts/StsRsnInf/Rsn/Cd')).toEqual(['DS02']);
      expect(texts(xml, 'OrgnlPmtInfAndSts/StsRsnInf/AddtlInf')).toEqual(['Cancelled in VEU']);
      expect(nodes(xml, 'GrpHdr/DbtrAgt')).toHaveLength(0);
    });
  });

  describe('pain.002 VoP report', () => {
    it('picks the worst VoP result as group status', () => {
      expect(vopGroupStatus(['RCVC', 'RCVC'])).toBe('RCVC');
      expect(vopGroupStatus(['RCVC', 'RVNA'])).toBe('RVNA');
      expect(vopGroupStatus(['RVNA', 'RVMC'])).toBe('RVMC');
      expect(vopGroupStatus(['RVMC', 'RVNM', 'RCVC'])).toBe('RVNM');
      expect(vopGroupStatus([])).toBe('RCVC');
    });

    it('reports per transaction with the corrected name of a close match', () => {
      const xml = generateVopReport('MSG-0001', [{ order, transactions }], order.createdAt);
      expect(texts(xml, 'OrgnlGrpInfAndSts/OrgnlMsgId')).toEqual(['MSG-0001']);
      expect(texts(xml, 'OrgnlGrpInfAndSts/OrgnlNbOfTxs')).toEqual(['2']);
      expect(texts(xml, 'OrgnlGrpInfAndSts/GrpSts')).toEqual(['RVMC']);
      expect(texts(xml, 'OrgnlGrpInfAndSts/StsRsnInf/AddtlInf')).toHaveLength(1);
      expect(texts(xml, 'OrgnlPmtInfAndSts/OrgnlPmtInfId')).toEqual(['PMT-0001']);
      expect(texts(xml, 'TxInfAndSts/TxSts')).toEqual(['RCVC', 'RVMC']);
      expect(texts(xml, 'TxInfAndSts/StsRsnInf/AddtlInf')).toEqual(['RVMC Erika Mustermann']);
    });
  });

  describe('pain.002.001.03 customer protocol (HAC)', () => {
    const full: HacEvent = {
      id: 1, partnerId: 'P1', userId: 'U1', orderId: 'A002', action: 'VEU_CANCEL_ORDER', adminOrderType: 'HVS',
      serviceName: 'SCI', scope: 'DE', serviceOption: 'VOI', containerType: 'XML', msgName: 'pain.001',
      orderIdRef: 'A001', adminOrderTypeRef: 'BTU', reasonCode: 'DS02', additionalInfo: ['x'.repeat(250), 'short'],
      eventAt: '2026-09-12T10:00:00.000Z',
    };
    const final: HacEvent = { id: 2, partnerId: 'P1', orderId: 'A001', action: 'ORDER_HAC_FINAL_POS', adminOrderType: 'BTU', additionalInfo: [], eventAt: '2026-09-12T10:00:00.001Z' };
    const xml = generateHacReport([full, final], { bankBic: 'ETBADE2AXXX', customerName: (p) => `Customer ${p}`, now: new Date('2026-09-12T11:00:00.000Z') });

    it('renders the envelope real banks send', () => {
      expect(xml).toContain('urn:iso:std:iso:20022:tech:xsd:pain.002.001.03');
      expect(texts(xml, 'GrpHdr/CreDtTm')).toEqual(['2026-09-12T11:00:00.000Z']);
      expect(texts(xml, 'GrpHdr/InitgPty/Id/OrgId/Othr/Id')).toEqual(['ETBADE2AXXX']);
      expect(texts(xml, 'OrgnlGrpInfAndSts/OrgnlMsgId')).toEqual(['EBICS']);
      expect(texts(xml, 'OrgnlGrpInfAndSts/OrgnlMsgNmId')).toEqual(['EBICS']);
      expect(texts(xml, 'OrgnlPmtInfAndSts/OrgnlPmtInfId')).toEqual(['VEU_CANCEL_ORDER', 'ORDER_HAC_FINAL_POS']);
      expect(texts(xml, 'StsRsnInf/Orgtr/Nm')).toEqual(['Customer P1', 'Customer P1']);
    });

    it('lists order attributes in bank order and skips missing ones', () => {
      const [cancel, finalBlock] = nodes(xml, 'OrgnlPmtInfAndSts');
      const keys = (block: Element) =>
        Array.from(block.getElementsByTagNameNS('*', 'Prtry')).map((n) => n.textContent);
      expect(keys(cancel!)).toEqual([
        'PartnerID', 'AdminOrderType', 'ServiceName', 'Scope', 'ServiceOption', 'ContainerType',
        'MsgName', 'OrderID', 'OrderIDRef', 'AdminOrderTypeRef', 'UserID', 'TimeStamp',
      ]);
      expect(keys(finalBlock!)).toEqual(['PartnerID', 'AdminOrderType', 'OrderID', 'TimeStamp']);
      expect(childNames(nodes(xml, 'OrgnlPmtInfAndSts/StsRsnInf')[0]!)).toEqual(['Orgtr', 'Rsn', 'AddtlInf', 'AddtlInf', 'AddtlInf', 'AddtlInf']);
    });

    it('splits additional info at 105 characters', () => {
      const lines = Array.from(nodes(xml, 'OrgnlPmtInfAndSts')[0]!.getElementsByTagNameNS('*', 'AddtlInf')).map((n) => n.textContent!);
      expect(lines.map((l) => l.length)).toEqual([105, 105, 40, 5]);
      expect(texts(xml, 'StsRsnInf/Rsn/Cd')).toEqual(['DS02']);
    });
  });
});
