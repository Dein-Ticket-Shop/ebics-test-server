import { create } from 'xmlbuilder2';
import type { Account, Person, BankConfig, Booking } from '../../store/types.js';

const NS = 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.08';

function formatAmount(cents: number): string {
  return (Math.abs(cents) / 100).toFixed(2);
}

function cdtDbt(cents: number): 'CRDT' | 'DBIT' {
  return cents >= 0 ? 'CRDT' : 'DBIT';
}

function addBalance(
  parent: any,
  code: 'OPBD' | 'CLBD',
  cents: number,
  currency: string,
  date: string,
) {
  const bal = parent.ele(NS, 'Bal');
  bal.ele(NS, 'Tp').ele(NS, 'CdOrPrtry').ele(NS, 'Cd').txt(code);
  bal.ele(NS, 'Amt').att('Ccy', currency).txt(formatAmount(cents));
  bal.ele(NS, 'CdtDbtInd').txt(cdtDbt(cents));
  bal.ele(NS, 'Dt').ele(NS, 'Dt').txt(date);
}

function addEntry(parent: any, booking: Booking) {
  const isCredit = booking.amountCents >= 0;
  const ntry = parent.ele(NS, 'Ntry');
  ntry.ele(NS, 'Amt').att('Ccy', booking.currency).txt(formatAmount(booking.amountCents));
  ntry.ele(NS, 'CdtDbtInd').txt(isCredit ? 'CRDT' : 'DBIT');
  ntry.ele(NS, 'Sts').ele(NS, 'Cd').txt('BOOK');
  ntry.ele(NS, 'BookgDt').ele(NS, 'Dt').txt(booking.bookingDate);
  ntry.ele(NS, 'ValDt').ele(NS, 'Dt').txt(booking.valueDate);

  const txCd = ntry.ele(NS, 'BkTxCd');
  const domn = txCd.ele(NS, 'Domn');
  domn.ele(NS, 'Cd').txt('PMNT');
  const fmly = domn.ele(NS, 'Fmly');
  fmly.ele(NS, 'Cd').txt(isCredit ? 'RCDT' : 'ICDT');
  fmly.ele(NS, 'SubFmlyCd').txt('ESCT');

  const dtls = ntry.ele(NS, 'NtryDtls').ele(NS, 'TxDtls');

  const parties = dtls.ele(NS, 'RltdPties');
  if (isCredit && booking.counterpartyName) {
    parties.ele(NS, 'Dbtr').ele(NS, 'Pty').ele(NS, 'Nm').txt(booking.counterpartyName);
    if (booking.counterpartyIban) {
      parties.ele(NS, 'DbtrAcct').ele(NS, 'Id').ele(NS, 'IBAN').txt(booking.counterpartyIban);
    }
  } else if (!isCredit && booking.counterpartyName) {
    parties.ele(NS, 'Cdtr').ele(NS, 'Pty').ele(NS, 'Nm').txt(booking.counterpartyName);
    if (booking.counterpartyIban) {
      parties.ele(NS, 'CdtrAcct').ele(NS, 'Id').ele(NS, 'IBAN').txt(booking.counterpartyIban);
    }
  }

  if (booking.remittanceInfo) {
    dtls.ele(NS, 'RmtInf').ele(NS, 'Ustrd').txt(booking.remittanceInfo);
  }

  if (booking.endToEndId) {
    const refs = dtls.ele(NS, 'Refs');
    refs.ele(NS, 'EndToEndId').txt(booking.endToEndId);
  }
}

export function generateCamt053(
  account: Account,
  person: Person,
  bankConfig: BankConfig,
  bookings: Booking[],
  openingBalanceCents: number,
  fromDate: string,
  toDate: string,
): string {
  const closingBalanceCents = openingBalanceCents + bookings.reduce((s, b) => s + b.amountCents, 0);
  const msgId = `STMT-${account.iban}-${Date.now()}`;
  const now = new Date().toISOString();

  const doc = create({ version: '1.0', encoding: 'UTF-8' });
  const root = doc.ele(NS, 'Document');
  const stmt = root.ele(NS, 'BkToCstmrStmt');

  const grpHdr = stmt.ele(NS, 'GrpHdr');
  grpHdr.ele(NS, 'MsgId').txt(msgId);
  grpHdr.ele(NS, 'CreDtTm').txt(now);

  const s = stmt.ele(NS, 'Stmt');
  s.ele(NS, 'Id').txt(msgId);
  s.ele(NS, 'ElctrncSeqNb').txt('1');
  s.ele(NS, 'CreDtTm').txt(now);

  const frTo = s.ele(NS, 'FrToDt');
  frTo.ele(NS, 'FrDtTm').txt(`${fromDate}T00:00:00Z`);
  frTo.ele(NS, 'ToDtTm').txt(`${toDate}T23:59:59Z`);

  const acct = s.ele(NS, 'Acct');
  acct.ele(NS, 'Id').ele(NS, 'IBAN').txt(account.iban);
  acct.ele(NS, 'Ccy').txt(account.currency);
  acct.ele(NS, 'Ownr').ele(NS, 'Nm').txt(person.name);
  acct.ele(NS, 'Svcr').ele(NS, 'FinInstnId').ele(NS, 'BICFI').txt(bankConfig.bic);

  addBalance(s, 'OPBD', openingBalanceCents, account.currency, fromDate);
  addBalance(s, 'CLBD', closingBalanceCents, account.currency, toDate);

  for (const booking of bookings) {
    addEntry(s, booking);
  }

  return doc.end({ prettyPrint: true });
}
