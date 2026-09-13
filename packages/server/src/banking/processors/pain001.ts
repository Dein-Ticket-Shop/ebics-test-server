import type { AppStore } from '../../store/types.js';
import { parseXml, xpathSelect, type XmlDocument } from '../../protocol/xml-parser.js';
import { logMoney, logError } from '../../logger.js';
import { validateOrderData, validateOrderingAccount } from '../validation.js';

export interface CreditTransferTransaction {
  endToEndId?: string;
  creditorName?: string;
  creditorIban?: string;
  creditorBic?: string;
  amountCents: number;
  currency: string;
  remittanceInfo?: string;
}

/** One PmtInf (Sammler) of a pain.001 credit transfer file */
export interface CreditTransferInstruction {
  msgId: string;
  pmtInfId: string;
  debtorName?: string;
  debtorIban?: string;
  requestedExecutionDate?: string;
  /** PmtTpInf/LclInstrm/Cd = INST (SEPA Instant) */
  instant: boolean;
  transactions: CreditTransferTransaction[];
}

export interface BookedTransfer {
  debitBookingId?: number;
  creditBookingId?: number;
}

function select(node: Node | XmlDocument, expression: string): Node[] {
  const result = xpathSelect(expression, node as XmlDocument);
  return Array.isArray(result) ? (result as Node[]) : [];
}

/** Text of a relative element path matched by local name, e.g. `DbtrAcct/Id/IBAN` */
function lnText(node: Node, path: string): string | undefined {
  const expression = `./${path.split('/').map((name) => `*[local-name()='${name}']`).join('/')}`;
  const value = select(node, expression)[0]?.textContent?.trim();
  return value ? value : undefined;
}

/**
 * Parses every PmtInf of a pain.001 document. Version-tolerant: elements are matched by local
 * name, so pain.001.001.03 / .09 and other versions work without hard-coding a namespace.
 * Transactions without a positive amount are skipped.
 */
export function parsePain001(doc: XmlDocument): CreditTransferInstruction[] {
  const msgId = select(doc, "//*[local-name()='GrpHdr']/*[local-name()='MsgId']")[0]?.textContent?.trim() ?? '';

  return select(doc, "//*[local-name()='PmtInf']").map((pmtInf) => {
    const transactions: CreditTransferTransaction[] = [];
    for (const txInf of select(pmtInf, "./*[local-name()='CdtTrfTxInf']")) {
      const amountNode = select(txInf, "./*[local-name()='Amt']/*[local-name()='InstdAmt']")[0] as Element | undefined;
      const amountCents = Math.round(parseFloat(amountNode?.textContent ?? '') * 100);
      if (isNaN(amountCents) || amountCents <= 0) continue;
      transactions.push({
        endToEndId: lnText(txInf, 'PmtId/EndToEndId'),
        creditorName: lnText(txInf, 'Cdtr/Nm'),
        creditorIban: lnText(txInf, 'CdtrAcct/Id/IBAN'),
        creditorBic: lnText(txInf, 'CdtrAgt/FinInstnId/BICFI') ?? lnText(txInf, 'CdtrAgt/FinInstnId/BIC'),
        amountCents,
        currency: amountNode?.getAttribute('Ccy') || 'EUR',
        remittanceInfo: lnText(txInf, 'RmtInf/Ustrd'),
      });
    }

    return {
      msgId,
      pmtInfId: lnText(pmtInf, 'PmtInfId') ?? '',
      debtorName: lnText(pmtInf, 'Dbtr/Nm'),
      debtorIban: lnText(pmtInf, 'DbtrAcct/Id/IBAN'),
      requestedExecutionDate:
        lnText(pmtInf, 'ReqdExctnDt/DtTm') ?? lnText(pmtInf, 'ReqdExctnDt/Dt') ?? lnText(pmtInf, 'ReqdExctnDt'),
      instant: lnText(pmtInf, 'PmtTpInf/LclInstrm/Cd') === 'INST',
      transactions,
    };
  });
}

/**
 * Bank-side checks of a credit transfer upload: IBAN/BIC formats, and the debtor (ordering party)
 * account must be held here and accessible to the uploading partner. Throws OrderDataError /
 * OrderAuthError; no-op unless strict validation is enabled. All PmtInfs are checked before
 * anything is booked.
 */
export function validatePain001(
  doc: XmlDocument,
  instructions: CreditTransferInstruction[],
  store: AppStore,
  partnerId: string,
): void {
  validateOrderData(doc as unknown as Node);
  for (const instruction of instructions) {
    validateOrderingAccount(store, partnerId, instruction.debtorIban, 'debtor');
  }
}

/** Books one credit transfer: debit on the debtor account and credit on the creditor account, when held here. */
export function bookCreditTransfer(
  store: AppStore,
  instruction: Pick<CreditTransferInstruction, 'debtorIban'>,
  tx: CreditTransferTransaction,
): BookedTransfer {
  const today = new Date().toISOString().slice(0, 10);
  const debtorAccount = instruction.debtorIban ? store.getAccountByIban(instruction.debtorIban) : undefined;
  const debtorName = debtorAccount ? store.getPerson(debtorAccount.personId)?.name : undefined;
  const booked: BookedTransfer = {};

  if (debtorAccount) {
    booked.debitBookingId = store.createBooking({
      accountId: debtorAccount.id,
      amountCents: -tx.amountCents,
      currency: debtorAccount.currency,
      valueDate: today,
      bookingDate: today,
      counterpartyName: tx.creditorName,
      counterpartyIban: tx.creditorIban,
      counterpartyBic: tx.creditorBic,
      remittanceInfo: tx.remittanceInfo,
      endToEndId: tx.endToEndId,
      transactionCode: 'NTRF',
    }).id;
  }

  const creditorAccount = tx.creditorIban ? store.getAccountByIban(tx.creditorIban) : undefined;
  if (creditorAccount) {
    booked.creditBookingId = store.createBooking({
      accountId: creditorAccount.id,
      amountCents: tx.amountCents,
      currency: creditorAccount.currency,
      valueDate: today,
      bookingDate: today,
      counterpartyName: debtorName,
      counterpartyIban: instruction.debtorIban,
      remittanceInfo: tx.remittanceInfo,
      endToEndId: tx.endToEndId,
      transactionCode: 'NTRF',
    }).id;
  }

  logMoney({
    amountCents: tx.amountCents,
    currency: debtorAccount?.currency ?? creditorAccount?.currency ?? 'EUR',
    from: debtorName ?? instruction.debtorIban,
    to: tx.creditorName,
    toIban: tx.creditorIban,
    remittance: tx.remittanceInfo,
    internal: Boolean(debtorAccount || creditorAccount),
  });

  return booked;
}

/** Validates and books a pain.001 upload immediately (BTU pain.001 without an EDS hold). */
export function processPain001(
  rawContent: string,
  store: AppStore,
  partnerId: string,
): { instruction: CreditTransferInstruction; bookings: BookedTransfer[] }[] {
  const doc = parseXml(rawContent);
  const instructions = parsePain001(doc);
  validatePain001(doc, instructions, store, partnerId);

  return instructions.map((instruction) => ({
    instruction,
    bookings: instruction.transactions.map((tx) => {
      try {
        return bookCreditTransfer(store, instruction, tx);
      } catch (err) {
        // skip individual failed transactions, but make the failure visible
        logError('pain.001 transaction', err);
        return {};
      }
    }),
  }));
}
