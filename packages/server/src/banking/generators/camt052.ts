import { create } from 'xmlbuilder2';
import { addAccount, addBalance, addEntry, type CamtAccountInput } from './camt-common.js';

const NS = 'urn:iso:std:iso:20022:tech:xsd:camt.052.001.08';

/**
 * camt.052 intraday account report (BTD STM camt.052):
 * one <Rpt> per account with opening and interim booked balance and the bookings of the period.
 */
export function generateCamt052(reports: CamtAccountInput[], fromDate: string, toDate: string): string {
  const now = new Date().toISOString();
  const stamp = Date.now();

  const doc = create({ version: '1.0', encoding: 'UTF-8' });
  const bkToCstmr = doc.ele(NS, 'Document').ele(NS, 'BkToCstmrAcctRpt');

  const grpHdr = bkToCstmr.ele(NS, 'GrpHdr');
  grpHdr.ele(NS, 'MsgId').txt(`RPT${stamp}`);
  grpHdr.ele(NS, 'CreDtTm').txt(now);

  for (const input of reports) {
    const { account, bookings, openingBalanceCents } = input;
    const interimBalanceCents = openingBalanceCents + bookings.reduce((sum, b) => sum + b.amountCents, 0);

    const rpt = bkToCstmr.ele(NS, 'Rpt');
    rpt.ele(NS, 'Id').txt(`RPT${stamp}A${account.id}`);
    rpt.ele(NS, 'ElctrncSeqNb').txt('1');
    rpt.ele(NS, 'CreDtTm').txt(now);
    const frTo = rpt.ele(NS, 'FrToDt');
    frTo.ele(NS, 'FrDtTm').txt(`${fromDate}T00:00:00Z`);
    frTo.ele(NS, 'ToDtTm').txt(`${toDate}T23:59:59Z`);

    addAccount(rpt, NS, input);
    addBalance(rpt, NS, 'OPBD', openingBalanceCents, account.currency, fromDate);
    addBalance(rpt, NS, 'ITBD', interimBalanceCents, account.currency, toDate);

    for (const booking of bookings) {
      addEntry(rpt, NS, booking);
    }
  }

  return doc.end({ prettyPrint: true });
}
