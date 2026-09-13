import type { AppStore } from '../../store/types.js';
import { parseXml, xpathSelect } from '../../protocol/xml-parser.js';
import { logMoney, logError } from '../../logger.js';
import { validateOrderData, validateOrderingAccount } from '../validation.js';

/**
 * Process a pain.008 SEPA Direct Debit (SDD): the creditor collects money from
 * one or more debtors. Money flows debtor -> creditor, the mirror of pain.001.
 *
 * Version-tolerant: matched by local element name, so pain.008.001.02 / .08 /
 * etc. all work without hard-coding a namespace.
 */
export function processPain008(rawContent: string, store: AppStore, partnerId: string): void {
  // The whole file is validated first, so a refused file books nothing
  validatePain008(rawContent, store, partnerId);
  const doc = parseXml(rawContent);

  const pmtInfs = xpathSelect("//*[local-name()='PmtInf']", doc);
  if (!Array.isArray(pmtInfs)) return;

  for (const pmtInf of pmtInfs) {
    const node = pmtInf as Node;
    // Creditor sits at the PmtInf level and collects from every debit below it.
    // For a direct debit the creditor is the ordering party — it must be an
    // account held here that the uploading partner may collect into.
    const creditorName = lnText(node, "Cdtr/Nm");
    const creditorIban = lnText(node, "CdtrAcct/Id/IBAN");
    const creditorAccount = creditorIban ? store.getAccountByIban(creditorIban) : undefined;

    const txInfs = xpathSelect("./*[local-name()='DrctDbtTxInf']", node as any);
    if (!Array.isArray(txInfs)) continue;

    for (const txInf of txInfs) {
      try {
        processDebit(txInf as Node, creditorName, creditorIban, creditorAccount, store);
      } catch (err) {
        // skip individual failed transactions, but make the failure visible
        logError('pain.008 transaction', err);
      }
    }
  }
}

/** IBAN/BIC format of the file and, for every PmtInf, the creditor account the uploading partner collects into */
export function validatePain008(rawContent: string, store: AppStore, partnerId: string): void {
  const doc = parseXml(rawContent);
  validateOrderData(doc as unknown as Node);
  const pmtInfs = xpathSelect("//*[local-name()='PmtInf']", doc);
  for (const pmtInf of Array.isArray(pmtInfs) ? pmtInfs : []) {
    validateOrderingAccount(store, partnerId, lnText(pmtInf as Node, 'CdtrAcct/Id/IBAN'), 'creditor');
  }
}

export interface DirectDebitTransaction {
  endToEndId?: string;
  debtorName?: string;
  debtorIban?: string;
  debtorBic?: string;
  amountCents: number;
  currency: string;
  remittanceInfo?: string;
}

/** One PmtInf of a pain.008 file: the creditor collects every direct debit below it */
export interface DirectDebitInstruction {
  msgId: string;
  pmtInfId: string;
  creditorName?: string;
  creditorIban?: string;
  /** ReqdColltnDt */
  requestedCollectionDate?: string;
  transactions: DirectDebitTransaction[];
}

/** The PmtInfs and direct debits (DrctDbtTxInf with a positive amount) of a pain.008 file */
export function parsePain008(rawContent: string): DirectDebitInstruction[] {
  const doc = parseXml(rawContent);
  const msgIdNodes = xpathSelect("//*[local-name()='GrpHdr']/*[local-name()='MsgId']/text()", doc);
  const msgId = Array.isArray(msgIdNodes) && msgIdNodes.length > 0 ? ((msgIdNodes[0] as { nodeValue?: string | null }).nodeValue ?? '') : '';
  const pmtInfs = xpathSelect("//*[local-name()='PmtInf']", doc);
  return (Array.isArray(pmtInfs) ? pmtInfs : []).map((pmtInf) => {
    const node = pmtInf as Node;
    const txInfs = xpathSelect("./*[local-name()='DrctDbtTxInf']", node as any);
    const transactions = (Array.isArray(txInfs) ? txInfs : []).flatMap((txInf): DirectDebitTransaction[] => {
      const tx = txInf as Node;
      const amountCents = Math.round(parseFloat(lnText(tx, 'InstdAmt') ?? lnText(tx, 'Amt/InstdAmt') ?? '') * 100);
      if (isNaN(amountCents) || amountCents <= 0) return [];
      const currencyNodes = xpathSelect("./*[local-name()='InstdAmt']/@Ccy | ./*[local-name()='Amt']/*[local-name()='InstdAmt']/@Ccy", tx as any);
      const currency = Array.isArray(currencyNodes) && currencyNodes.length > 0 ? ((currencyNodes[0] as Attr).value || 'EUR') : 'EUR';
      return [
        {
          endToEndId: lnText(tx, 'PmtId/EndToEndId'),
          debtorName: lnText(tx, 'Dbtr/Nm'),
          debtorIban: lnText(tx, 'DbtrAcct/Id/IBAN'),
          debtorBic: lnText(tx, 'DbtrAgt/FinInstnId/BICFI') ?? lnText(tx, 'DbtrAgt/FinInstnId/BIC'),
          amountCents,
          currency,
          remittanceInfo: lnText(tx, 'RmtInf/Ustrd'),
        },
      ];
    });
    return {
      msgId,
      pmtInfId: lnText(node, 'PmtInfId') ?? '',
      creditorName: lnText(node, 'Cdtr/Nm'),
      creditorIban: lnText(node, 'CdtrAcct/Id/IBAN'),
      requestedCollectionDate: lnText(node, 'ReqdColltnDt'),
      transactions,
    };
  });
}

function processDebit(
  txInf: Node,
  creditorName: string | undefined,
  creditorIban: string | undefined,
  creditorAccount: ReturnType<AppStore['getAccountByIban']>,
  store: AppStore,
): void {
  const amountStr = lnText(txInf, "InstdAmt") ?? lnText(txInf, "Amt/InstdAmt");
  if (!amountStr) return;

  const amountCents = Math.round(parseFloat(amountStr) * 100);
  if (isNaN(amountCents) || amountCents <= 0) return;

  const debtorName = lnText(txInf, "Dbtr/Nm");
  const debtorIban = lnText(txInf, "DbtrAcct/Id/IBAN");
  const debtorBic = lnText(txInf, "DbtrAgt/FinInstnId/BICFI") ?? lnText(txInf, "DbtrAgt/FinInstnId/BIC");
  const endToEndId = lnText(txInf, "PmtId/EndToEndId");
  const remittanceInfo = lnText(txInf, "RmtInf/Ustrd");
  const today = new Date().toISOString().slice(0, 10);

  const debtorAccount = debtorIban ? store.getAccountByIban(debtorIban) : undefined;

  // Debtor pays: balance decreases.
  if (debtorAccount) {
    store.createBooking({
      accountId: debtorAccount.id,
      amountCents: -amountCents,
      currency: debtorAccount.currency,
      valueDate: today,
      bookingDate: today,
      counterpartyName: creditorName,
      counterpartyIban: creditorIban,
      remittanceInfo,
      endToEndId,
      transactionCode: 'NDDT',
    });
  }

  // Creditor collects: balance increases.
  if (creditorAccount) {
    store.createBooking({
      accountId: creditorAccount.id,
      amountCents: amountCents,
      currency: creditorAccount.currency,
      valueDate: today,
      bookingDate: today,
      counterpartyName: debtorName,
      counterpartyIban: debtorIban,
      counterpartyBic: debtorBic,
      remittanceInfo,
      endToEndId,
      transactionCode: 'NDDT',
    });
  }

  const currency = debtorAccount?.currency ?? creditorAccount?.currency ?? 'EUR';
  logMoney({
    amountCents,
    currency,
    from: debtorName ?? debtorIban,
    to: creditorName ?? creditorIban,
    toIban: creditorIban,
    remittance: remittanceInfo,
    internal: Boolean(debtorAccount || creditorAccount),
  });
}

/** Extract text at a slash path, matched by local element name (namespace-agnostic). */
function lnText(node: Node, path: string): string | undefined {
  const expr = './' + path.split('/').map((p) => `*[local-name()='${p}']`).join('/') + '/text()';
  const result = xpathSelect(expr, node as any);
  if (Array.isArray(result) && result.length > 0) {
    return (result[0] as { nodeValue?: string | null }).nodeValue ?? undefined;
  }
  return undefined;
}
