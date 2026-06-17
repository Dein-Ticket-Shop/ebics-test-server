import type { AppStore } from '../../store/types.js';
import { parseXml, xpathSelect } from '../../protocol/xml-parser.js';
import { logMoney, logError } from '../../logger.js';
import { validateOrderData } from '../validation.js';

/**
 * Process a pain.008 SEPA Direct Debit (SDD): the creditor collects money from
 * one or more debtors. Money flows debtor -> creditor, the mirror of pain.001.
 *
 * Version-tolerant: matched by local element name, so pain.008.001.02 / .08 /
 * etc. all work without hard-coding a namespace.
 */
export function processPain008(rawContent: string, store: AppStore): void {
  const doc = parseXml(rawContent);
  validateOrderData(doc as unknown as Node);

  const pmtInfs = xpathSelect("//*[local-name()='PmtInf']", doc);
  if (!Array.isArray(pmtInfs)) return;

  for (const pmtInf of pmtInfs) {
    const node = pmtInf as Node;
    // Creditor sits at the PmtInf level and collects from every debit below it.
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
