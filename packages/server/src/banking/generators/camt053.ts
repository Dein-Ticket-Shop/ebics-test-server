import { create } from 'xmlbuilder2';
import type { Account, Person, BankConfig, Booking } from '../../store/types.js';
import { addAccount, addBalance, addEntry, type CamtAccountInput } from './camt-common.js';

const NS = 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.08';

/** Input for one camt.053 <Stmt> block (one account). */
export type StatementInput = CamtAccountInput;

/** Appends one <Stmt> (single account) under the BkToCstmrStmt parent. */
function addStatement(parent: any, input: StatementInput, fromDate: string, toDate: string, now: string) {
  const { account, bookings, openingBalanceCents } = input;
  const closingBalanceCents = openingBalanceCents + bookings.reduce((sum, b) => sum + b.amountCents, 0);
  // Max35Text: timestamp plus account id stays well below 35 characters
  const stmtId = `STMT${Date.now()}A${account.id}`;

  const s = parent.ele(NS, 'Stmt');
  s.ele(NS, 'Id').txt(stmtId);
  s.ele(NS, 'ElctrncSeqNb').txt('1');
  s.ele(NS, 'CreDtTm').txt(now);

  const frTo = s.ele(NS, 'FrToDt');
  frTo.ele(NS, 'FrDtTm').txt(`${fromDate}T00:00:00Z`);
  frTo.ele(NS, 'ToDtTm').txt(`${toDate}T23:59:59Z`);

  addAccount(s, NS, input);

  addBalance(s, NS, 'OPBD', openingBalanceCents, account.currency, fromDate);
  addBalance(s, NS, 'CLBD', closingBalanceCents, account.currency, toDate);

  for (const booking of bookings) {
    addEntry(s, NS, booking);
  }
}

/**
 * Generate a camt.053 document containing one <Stmt> per account. A single
 * BkToCstmrStmt legitimately carries multiple statements, so all accounts the
 * subscriber can see are reported in one valid document.
 */
export function generateCamt053Multi(
  statements: StatementInput[],
  fromDate: string,
  toDate: string,
): string {
  const now = new Date().toISOString();

  const doc = create({ version: '1.0', encoding: 'UTF-8' });
  const root = doc.ele(NS, 'Document');
  const bkToCstmr = root.ele(NS, 'BkToCstmrStmt');

  const grpHdr = bkToCstmr.ele(NS, 'GrpHdr');
  grpHdr.ele(NS, 'MsgId').txt(`STMT-${Date.now()}`);
  grpHdr.ele(NS, 'CreDtTm').txt(now);

  for (const input of statements) {
    addStatement(bkToCstmr, input, fromDate, toDate, now);
  }

  return doc.end({ prettyPrint: true });
}

/** Generate a camt.053 document for a single account. */
export function generateCamt053(
  account: Account,
  person: Person,
  bankConfig: BankConfig,
  bookings: Booking[],
  openingBalanceCents: number,
  fromDate: string,
  toDate: string,
): string {
  return generateCamt053Multi(
    [{ account, person, bankConfig, bookings, openingBalanceCents }],
    fromDate,
    toDate,
  );
}
