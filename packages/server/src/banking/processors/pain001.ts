import type { AppStore } from '../../store/types.js';
import { parseXml, xpathSelect, xpathString } from '../../protocol/xml-parser.js';

export function processPain001(rawContent: string, store: AppStore): void {
  const doc = parseXml(rawContent);

  const pmtInfs = xpathSelect('//pain:PmtInf', doc, {
    pain: 'urn:iso:std:iso:20022:tech:xsd:pain.001.001.09',
  });

  if (!Array.isArray(pmtInfs) || pmtInfs.length === 0) {
    const pmtInfsV3 = xpathSelect('//pain:PmtInf', doc, {
      pain: 'urn:iso:std:iso:20022:tech:xsd:pain.001.001.03',
    });
    if (Array.isArray(pmtInfsV3) && pmtInfsV3.length > 0) {
      processPmtInfs(pmtInfsV3 as Node[], store, 'urn:iso:std:iso:20022:tech:xsd:pain.001.001.03');
      return;
    }
    return;
  }

  processPmtInfs(pmtInfs as Node[], store, 'urn:iso:std:iso:20022:tech:xsd:pain.001.001.09');
}

function processPmtInfs(pmtInfs: Node[], store: AppStore, ns: string): void {
  for (const pmtInf of pmtInfs) {
    const debtorIban = extractText(pmtInf, 'pain:DbtrAcct/pain:Id/pain:IBAN', ns);
    const debtorAccount = debtorIban ? store.getAccountByIban(debtorIban) : undefined;

    const txInfs = xpathSelect('pain:CdtTrfTxInf', pmtInf as any, { pain: ns });
    if (!Array.isArray(txInfs)) continue;

    for (const txInf of txInfs) {
      try {
        processTransaction(txInf as Node, debtorIban, debtorAccount, store, ns);
      } catch {
        // skip individual failed transactions
      }
    }
  }
}

function processTransaction(
  txInf: Node,
  debtorIban: string | undefined,
  debtorAccount: ReturnType<AppStore['getAccountByIban']>,
  store: AppStore,
  ns: string,
): void {
  const amountStr = extractText(txInf, 'pain:Amt/pain:InstdAmt', ns);
  if (!amountStr) return;

  const amountCents = Math.round(parseFloat(amountStr) * 100);
  if (isNaN(amountCents) || amountCents <= 0) return;

  const creditorName = extractText(txInf, 'pain:Cdtr/pain:Nm', ns);
  const creditorIban = extractText(txInf, 'pain:CdtrAcct/pain:Id/pain:IBAN', ns);
  const creditorBic = extractText(txInf, 'pain:CdtrAgt/pain:FinInstnId/pain:BICFI', ns);
  const endToEndId = extractText(txInf, 'pain:PmtId/pain:EndToEndId', ns);
  const remittanceInfo = extractText(txInf, 'pain:RmtInf/pain:Ustrd', ns);
  const today = new Date().toISOString().slice(0, 10);

  if (debtorAccount) {
    store.createBooking({
      accountId: debtorAccount.id,
      amountCents: -amountCents,
      currency: debtorAccount.currency,
      valueDate: today,
      bookingDate: today,
      counterpartyName: creditorName,
      counterpartyIban: creditorIban,
      counterpartyBic: creditorBic,
      remittanceInfo,
      endToEndId,
      transactionCode: 'NTRF',
    });
  }

  if (creditorIban) {
    const creditorAccount = store.getAccountByIban(creditorIban);
    if (creditorAccount) {
      store.createBooking({
        accountId: creditorAccount.id,
        amountCents: amountCents,
        currency: creditorAccount.currency,
        valueDate: today,
        bookingDate: today,
        counterpartyName: debtorAccount ? store.getPerson(debtorAccount.personId)?.name : undefined,
        counterpartyIban: debtorIban,
        remittanceInfo,
        endToEndId,
        transactionCode: 'NTRF',
      });
    }
  }
}

function extractText(node: Node, xpath: string, ns: string): string | undefined {
  const result = xpathSelect(xpath + '/text()', node as any, { pain: ns });
  if (Array.isArray(result) && result.length > 0) {
    return (result[0] as any).nodeValue ?? undefined;
  }
  return undefined;
}
