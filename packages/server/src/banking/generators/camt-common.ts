import type { Account, Person, BankConfig, Booking } from '../../store/types.js';

/** One account block (camt.052 Rpt, camt.053 Stmt, camt.054 Ntfctn) */
export interface CamtAccountInput {
  account: Account;
  person: Person;
  bankConfig: BankConfig;
  bookings: Booking[];
  openingBalanceCents: number;
}

export function formatAmount(cents: number): string {
  return (Math.abs(cents) / 100).toFixed(2);
}

export function cdtDbt(cents: number): 'CRDT' | 'DBIT' {
  return cents >= 0 ? 'CRDT' : 'DBIT';
}

/** Bank reference of a booking (`AcctSvcrRef`). Stable across camt.052, camt.053 and camt.054. */
export function accountServicerReference(booking: Booking): string {
  return `ETB${String(booking.id).padStart(12, '0')}`;
}

/** Transaction ID of a booking (`TxDtls/Refs/TxId`). Stable across camt.052, camt.053 and camt.054. */
export function bookingTransactionId(booking: Booking): string {
  return `TX${String(booking.id).padStart(12, '0')}`;
}

export function addBalance(parent: any, ns: string, code: string, cents: number, currency: string, date: string) {
  const bal = parent.ele(ns, 'Bal');
  bal.ele(ns, 'Tp').ele(ns, 'CdOrPrtry').ele(ns, 'Cd').txt(code);
  bal.ele(ns, 'Amt').att('Ccy', currency).txt(formatAmount(cents));
  bal.ele(ns, 'CdtDbtInd').txt(cdtDbt(cents));
  bal.ele(ns, 'Dt').ele(ns, 'Dt').txt(date);
}

export function addAccount(parent: any, ns: string, input: Pick<CamtAccountInput, 'account' | 'person' | 'bankConfig'>) {
  const acct = parent.ele(ns, 'Acct');
  acct.ele(ns, 'Id').ele(ns, 'IBAN').txt(input.account.iban);
  acct.ele(ns, 'Ccy').txt(input.account.currency);
  acct.ele(ns, 'Ownr').ele(ns, 'Nm').txt(input.person.name);
  acct.ele(ns, 'Svcr').ele(ns, 'FinInstnId').ele(ns, 'BICFI').txt(input.bankConfig.bic);
}

/** Appends one `<Ntry>` in ReportEntry10 / EntryTransaction10 element order (shared by camt.052/053/054 .08). */
export function addEntry(parent: any, ns: string, booking: Booking) {
  const isCredit = booking.amountCents >= 0;
  const ntry = parent.ele(ns, 'Ntry');
  ntry.ele(ns, 'Amt').att('Ccy', booking.currency).txt(formatAmount(booking.amountCents));
  ntry.ele(ns, 'CdtDbtInd').txt(isCredit ? 'CRDT' : 'DBIT');
  ntry.ele(ns, 'Sts').ele(ns, 'Cd').txt('BOOK');
  ntry.ele(ns, 'BookgDt').ele(ns, 'Dt').txt(booking.bookingDate);
  ntry.ele(ns, 'ValDt').ele(ns, 'Dt').txt(booking.valueDate);
  ntry.ele(ns, 'AcctSvcrRef').txt(accountServicerReference(booking));

  const txCd = ntry.ele(ns, 'BkTxCd');
  const domn = txCd.ele(ns, 'Domn');
  domn.ele(ns, 'Cd').txt('PMNT');
  const fmly = domn.ele(ns, 'Fmly');
  fmly.ele(ns, 'Cd').txt(isCredit ? 'RCDT' : 'ICDT');
  fmly.ele(ns, 'SubFmlyCd').txt('ESCT');

  const dtls = ntry.ele(ns, 'NtryDtls').ele(ns, 'TxDtls');

  const refs = dtls.ele(ns, 'Refs');
  refs.ele(ns, 'AcctSvcrRef').txt(accountServicerReference(booking));
  if (booking.endToEndId) {
    refs.ele(ns, 'EndToEndId').txt(booking.endToEndId);
  }
  refs.ele(ns, 'TxId').txt(bookingTransactionId(booking));

  const parties = dtls.ele(ns, 'RltdPties');
  if (isCredit && booking.counterpartyName) {
    parties.ele(ns, 'Dbtr').ele(ns, 'Pty').ele(ns, 'Nm').txt(booking.counterpartyName);
    if (booking.counterpartyIban) {
      parties.ele(ns, 'DbtrAcct').ele(ns, 'Id').ele(ns, 'IBAN').txt(booking.counterpartyIban);
    }
  } else if (!isCredit && booking.counterpartyName) {
    parties.ele(ns, 'Cdtr').ele(ns, 'Pty').ele(ns, 'Nm').txt(booking.counterpartyName);
    if (booking.counterpartyIban) {
      parties.ele(ns, 'CdtrAcct').ele(ns, 'Id').ele(ns, 'IBAN').txt(booking.counterpartyIban);
    }
  }

  if (booking.remittanceInfo) {
    dtls.ele(ns, 'RmtInf').ele(ns, 'Ustrd').txt(booking.remittanceInfo);
  }
}
