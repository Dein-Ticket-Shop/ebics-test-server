import { create } from 'xmlbuilder2';
import { randomBytes } from 'node:crypto';
import type {
  HacEvent,
  PaymentOrder,
  PaymentStatusEvent,
  PaymentTransaction,
  VopStatus,
} from '../../store/types.js';

const NS_10 = 'urn:iso:std:iso:20022:tech:xsd:pain.002.001.10';
const NS_03 = 'urn:iso:std:iso:20022:tech:xsd:pain.002.001.03';
const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const ORIGINAL_MESSAGE_NAME = 'pain.001.001.09';

/** AddtlInf is Max105Text: long lines are split, one element per chunk */
function additionalInfoLines(lines: string[]): string[] {
  return lines.flatMap((line) => (line.length <= 105 ? [line] : line.match(/.{1,105}/g) ?? []));
}

function messageId(prefix: string): string {
  return `${prefix}${Date.now()}${randomBytes(4).toString('hex').toUpperCase()}`.slice(0, 35);
}

function startDocument(ns: string, schemaFile: string) {
  const doc = create({ version: '1.0', encoding: 'UTF-8' });
  const root = doc
    .ele(ns, 'Document')
    .att(XSI, 'xsi:schemaLocation', `${ns} ${schemaFile}`);
  return { doc, report: root.ele(ns, 'CstmrPmtStsRpt') };
}

/**
 * Payment status report (BTD REP pain.002) for one
 * status change of one payment order. Banks send a new report per status change; clients read
 * them in order, so the last report per PmtInfId is the current status.
 */
export function generatePaymentStatusReport(
  order: PaymentOrder,
  transactions: PaymentTransaction[],
  event: PaymentStatusEvent,
  bankBic?: string,
): string {
  const { doc, report } = startDocument(NS_10, 'pain.002.001.10.xsd');

  const grpHdr = report.ele(NS_10, 'GrpHdr');
  grpHdr.ele(NS_10, 'MsgId').txt(messageId('PSR'));
  grpHdr.ele(NS_10, 'CreDtTm').txt(event.createdAt);
  if (bankBic) {
    grpHdr.ele(NS_10, 'DbtrAgt').ele(NS_10, 'FinInstnId').ele(NS_10, 'BICFI').txt(bankBic);
  }

  const grp = report.ele(NS_10, 'OrgnlGrpInfAndSts');
  grp.ele(NS_10, 'OrgnlMsgId').txt(order.msgId);
  grp.ele(NS_10, 'OrgnlMsgNmId').txt(ORIGINAL_MESSAGE_NAME);

  const pmt = report.ele(NS_10, 'OrgnlPmtInfAndSts');
  pmt.ele(NS_10, 'OrgnlPmtInfId').txt(order.pmtInfId);
  pmt.ele(NS_10, 'OrgnlNbOfTxs').txt(String(transactions.length));
  pmt.ele(NS_10, 'OrgnlCtrlSum').txt((transactions.reduce((sum, tx) => sum + tx.amountCents, 0) / 100).toFixed(2));
  pmt.ele(NS_10, 'PmtInfSts').txt(event.status);
  if (event.reasonCode || event.additionalInfo.length > 0) {
    const reason = pmt.ele(NS_10, 'StsRsnInf');
    if (event.reasonCode) reason.ele(NS_10, 'Rsn').ele(NS_10, 'Cd').txt(event.reasonCode);
    for (const line of additionalInfoLines(event.additionalInfo)) reason.ele(NS_10, 'AddtlInf').txt(line);
  }
  for (const tx of transactions) {
    const txSts = pmt.ele(NS_10, 'TxInfAndSts');
    if (tx.endToEndId) txSts.ele(NS_10, 'OrgnlEndToEndId').txt(tx.endToEndId);
    txSts.ele(NS_10, 'TxSts').txt(event.status);
  }

  return doc.end({ prettyPrint: true });
}

export interface VopReportOrder {
  order: PaymentOrder;
  transactions: PaymentTransaction[];
}

/** Worst result wins: no match > close match > not applicable > match */
export function vopGroupStatus(statuses: VopStatus[]): VopStatus {
  for (const status of ['RVNM', 'RVMC', 'RVNA'] as const) {
    if (statuses.includes(status)) return status;
  }
  return 'RCVC';
}

const VOP_GROUP_TEXT: Record<VopStatus, string> = {
  RCVC: 'Die Empfaengerueberpruefung hat fuer alle Zahlungen eine Uebereinstimmung ergeben.',
  RVMC: 'Die Empfaengerueberpruefung hat fuer mindestens eine Zahlung eine teilweise Uebereinstimmung ergeben.',
  RVNM: 'Die Empfaengerueberpruefung hat fuer mindestens eine Zahlung keine Uebereinstimmung ergeben.',
  RVNA: 'Die Empfaengerueberpruefung konnte nicht fuer alle Zahlungen durchgefuehrt werden.',
};

/**
 * Verification of Payee report (BTD REP/VOP pain.002) for one
 * uploaded pain.001 message. `GrpSts` and `TxSts` carry the VoP codes RCVC/RVMC/RVNM/RVNA; a close
 * match names the account holder in `StsRsnInf/AddtlInf` as `RVMC <name>`.
 */
export function generateVopReport(msgId: string, orders: VopReportOrder[], createdAt: string): string {
  const { doc, report } = startDocument(NS_10, 'pain.002.001.10.xsd');
  const allStatuses = orders.flatMap((o) => o.transactions.map((tx) => tx.vopStatus));
  const groupStatus = vopGroupStatus(allStatuses);

  const grpHdr = report.ele(NS_10, 'GrpHdr');
  grpHdr.ele(NS_10, 'MsgId').txt(messageId('VOP'));
  grpHdr.ele(NS_10, 'CreDtTm').txt(createdAt);

  const grp = report.ele(NS_10, 'OrgnlGrpInfAndSts');
  grp.ele(NS_10, 'OrgnlMsgId').txt(msgId);
  grp.ele(NS_10, 'OrgnlMsgNmId').txt(ORIGINAL_MESSAGE_NAME);
  grp.ele(NS_10, 'OrgnlNbOfTxs').txt(String(allStatuses.length));
  grp.ele(NS_10, 'GrpSts').txt(groupStatus);
  grp.ele(NS_10, 'StsRsnInf').ele(NS_10, 'AddtlInf').txt(VOP_GROUP_TEXT[groupStatus]);

  for (const { order, transactions } of orders) {
    const pmt = report.ele(NS_10, 'OrgnlPmtInfAndSts');
    pmt.ele(NS_10, 'OrgnlPmtInfId').txt(order.pmtInfId);
    for (const tx of transactions) {
      const txSts = pmt.ele(NS_10, 'TxInfAndSts');
      if (tx.endToEndId) txSts.ele(NS_10, 'OrgnlEndToEndId').txt(tx.endToEndId);
      txSts.ele(NS_10, 'TxSts').txt(tx.vopStatus);
      if (tx.vopStatus === 'RVMC' && tx.vopCorrectedName) {
        txSts.ele(NS_10, 'StsRsnInf').ele(NS_10, 'AddtlInf').txt(`RVMC ${tx.vopCorrectedName}`.slice(0, 105));
      }
    }
  }

  return doc.end({ prettyPrint: true });
}

/** Othr/SchmeNm/Prtry attributes of an event, in the order Sparkasse sends them */
function eventAttributes(event: HacEvent): [string, string | undefined][] {
  return [
    ['PartnerID', event.partnerId],
    ['AdminOrderType', event.adminOrderType],
    ['ServiceName', event.serviceName],
    ['Scope', event.scope],
    ['ServiceOption', event.serviceOption],
    ['ContainerType', event.containerType],
    ['MsgName', event.msgName],
    ['OrderID', event.orderId],
    ['OrderIDRef', event.orderIdRef],
    ['AdminOrderTypeRef', event.adminOrderTypeRef],
    ['UserID', event.userId],
    ['TimeStamp', event.eventAt],
  ];
}

/**
 * HAC customer protocol in the pain.002.001.03 format banks send (docs/HAC_PLAN.md): one
 * OrgnlPmtInfAndSts block per bank-side order event, chronological.
 */
export function generateHacReport(
  events: HacEvent[],
  options: { bankBic?: string; customerName: (partnerId: string) => string; now?: Date },
): string {
  const { doc, report } = startDocument(NS_03, 'pain.002.001.03.xsd');

  const grpHdr = report.ele(NS_03, 'GrpHdr');
  grpHdr.ele(NS_03, 'MsgId').txt(randomBytes(21).toString('base64url'));
  grpHdr.ele(NS_03, 'CreDtTm').txt((options.now ?? new Date()).toISOString());
  if (options.bankBic) {
    grpHdr.ele(NS_03, 'InitgPty').ele(NS_03, 'Id').ele(NS_03, 'OrgId').ele(NS_03, 'Othr').ele(NS_03, 'Id').txt(options.bankBic);
  }

  const grp = report.ele(NS_03, 'OrgnlGrpInfAndSts');
  grp.ele(NS_03, 'OrgnlMsgId').txt('EBICS');
  grp.ele(NS_03, 'OrgnlMsgNmId').txt('EBICS');

  for (const event of events) {
    const block = report.ele(NS_03, 'OrgnlPmtInfAndSts');
    block.ele(NS_03, 'OrgnlPmtInfId').txt(event.action);
    const reason = block.ele(NS_03, 'StsRsnInf');
    const originator = reason.ele(NS_03, 'Orgtr');
    originator.ele(NS_03, 'Nm').txt(options.customerName(event.partnerId));
    const orgId = originator.ele(NS_03, 'Id').ele(NS_03, 'OrgId');
    for (const [key, value] of eventAttributes(event)) {
      if (!value) continue;
      const othr = orgId.ele(NS_03, 'Othr');
      othr.ele(NS_03, 'Id').txt(value);
      othr.ele(NS_03, 'SchmeNm').ele(NS_03, 'Prtry').txt(key);
    }
    if (event.reasonCode) {
      reason.ele(NS_03, 'Rsn').ele(NS_03, 'Cd').txt(event.reasonCode);
    }
    for (const line of additionalInfoLines(event.additionalInfo)) {
      reason.ele(NS_03, 'AddtlInf').txt(line);
    }
  }

  return doc.end({ prettyPrint: true });
}
