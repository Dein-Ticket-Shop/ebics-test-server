import { create } from 'xmlbuilder2';
import { addAccount, addEntry, type CamtAccountInput } from './camt-common.js';

const NS = 'urn:iso:std:iso:20022:tech:xsd:camt.054.001.08';

export type NotificationInput = Omit<CamtAccountInput, 'openingBalanceCents'>;

/**
 * camt.054 debit/credit notification (BTD STM camt.054):
 * one <Ntfctn> per account that has bookings to report.
 */
export function generateCamt054(notifications: NotificationInput[]): string {
  const now = new Date().toISOString();
  const stamp = Date.now();

  const doc = create({ version: '1.0', encoding: 'UTF-8' });
  const bkToCstmr = doc.ele(NS, 'Document').ele(NS, 'BkToCstmrDbtCdtNtfctn');

  const grpHdr = bkToCstmr.ele(NS, 'GrpHdr');
  grpHdr.ele(NS, 'MsgId').txt(`NTF${stamp}`);
  grpHdr.ele(NS, 'CreDtTm').txt(now);

  for (const input of notifications) {
    if (input.bookings.length === 0) continue;
    const ntfctn = bkToCstmr.ele(NS, 'Ntfctn');
    ntfctn.ele(NS, 'Id').txt(`NTF${stamp}A${input.account.id}`);
    ntfctn.ele(NS, 'CreDtTm').txt(now);
    addAccount(ntfctn, NS, input);
    for (const booking of input.bookings) {
      addEntry(ntfctn, NS, booking);
    }
  }

  return doc.end({ prettyPrint: true });
}
