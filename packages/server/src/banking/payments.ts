import type {
  AppStore,
  PaymentOrder,
  PaymentStatusCode,
  PaymentTransaction,
  VopStatus,
} from '../store/types.js';
import { parseXml } from '../protocol/xml-parser.js';
import { edsHold } from '../config/feature-flags.js';
import { bookCreditTransfer, parsePain001, validatePain001 } from './processors/pain001.js';
import { verifyPayee } from './vop.js';
import { recordEvent, recordFinal, type OrderContext } from './order-events.js';
import { logError } from '../logger.js';

export interface CreditTransferUpload {
  rawContent: string;
  partnerId: string;
  userId: string;
  orderId: string;
  uploadedOrderId?: number;
  serviceName: string;
  serviceOption?: string;
  msgName: string;
  requestEds: boolean;
}

/** Thrown for admin actions that do not fit the order's current state */
export class PaymentOrderStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentOrderStateError';
  }
}

function orderContext(order: Pick<PaymentOrder, 'partnerId' | 'userId' | 'orderId' | 'serviceName' | 'serviceOption' | 'msgName' | 'uploadedOrderId'>): OrderContext {
  return {
    partnerId: order.partnerId,
    userId: order.userId,
    orderId: order.orderId,
    adminOrderType: 'BTU',
    serviceName: order.serviceName,
    serviceOption: order.serviceOption,
    msgName: order.msgName,
    uploadedOrderId: order.uploadedOrderId,
  };
}

function executedStatus(order: PaymentOrder): PaymentStatusCode {
  // SEPA Instant settles immediately; a regular SCT is accepted for settlement
  return order.serviceName === 'SCI' ? 'ACSC' : 'ACSP';
}

function formatEuro(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}

function formatDate(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split('-');
  return `${day}.${month}.${year}`;
}

/** German bank protocol text (Sparkasse layout) sent with ORDER_HAC_FINAL_POS, one section per PmtInf */
export function creditTransferProtocolText(store: AppStore, orders: PaymentOrder[]): string[] {
  if (orders.length === 0) return [];
  const bic = store.getBankConfig()?.bic ?? '';
  const first = orders[0]!;
  const title = first.serviceName === 'SCI' ? 'E C H T Z E I T U E B E R W E I S U N G E N' : 'U E B E R W E I S U N G E N';
  const createdAt = first.createdAt;
  const lines = [
    '============================================================',
    title,
    `Datei-ID   : ${first.msgId}`,
    `Datum/Zeit : ${formatDate(createdAt)}/${createdAt.slice(11)}`,
  ];
  for (const order of orders) {
    const transactions = store.listPaymentTransactions(order.id);
    const total = transactions.reduce((sum, tx) => sum + tx.amountCents, 0);
    lines.push(
      '------------------------------------------------------------',
      `Sammlerreferenz          : ${order.pmtInfId}`,
      `Bank-Code                : ${bic}`,
      `Kontonummer              : ${order.debtorIban ?? ''}`,
      `Auftraggeberdaten        : ${order.debtorName ?? ''}`,
      `Anzahl der Zahlungssaetze: ${transactions.length}`,
      `Summe der Betraege (EUR) : ${formatEuro(total)}`,
      `Ausfuehrungsdatum        : ${formatDate(new Date().toISOString())}`,
    );
  }
  lines.push('============================================================');
  return lines;
}

/**
 * Registers a validated pain.001 upload as payment orders (one per PmtInf) with VoP results and an
 * ACTC status. Executes it immediately unless it requests EDS and EBICS_EDS_HOLD is on, in which
 * case it waits in the VEU for release. Throws OrderDataError / OrderAuthError before anything is
 * stored when the file is refused.
 */
export function receiveCreditTransfers(store: AppStore, upload: CreditTransferUpload): PaymentOrder[] {
  const doc = parseXml(upload.rawContent);
  const instructions = parsePain001(doc);
  validatePain001(doc, instructions, store, upload.partnerId);

  const hold = upload.requestEds && edsHold();
  const orders = instructions.map((instruction) =>
    store.createPaymentOrder(
      {
        orderId: upload.orderId,
        uploadedOrderId: upload.uploadedOrderId,
        partnerId: upload.partnerId,
        userId: upload.userId,
        serviceName: upload.serviceName,
        serviceOption: upload.serviceOption,
        msgName: upload.msgName,
        msgId: instruction.msgId,
        pmtInfId: instruction.pmtInfId,
        debtorName: instruction.debtorName,
        debtorIban: instruction.debtorIban,
        requestedEds: upload.requestEds,
        status: 'PENDING_EDS',
      },
      instruction.transactions.map((tx) => {
        const vop = verifyPayee(store, tx.creditorIban, tx.creditorName);
        return { ...tx, vopStatus: vop.status, vopCorrectedName: vop.correctedName };
      }),
    ),
  );
  for (const order of orders) {
    store.appendPaymentStatusEvent({ paymentOrderId: order.id, status: 'ACTC' });
  }

  const ctx = orderContext(upload);
  recordEvent(store, ctx, 'FILE_UPLOAD', { reasonCode: 'TS01' });
  recordEvent(store, ctx, 'ES_VERIFICATION', { reasonCode: 'DS01' });

  if (hold) {
    recordEvent(store, ctx, 'VEU_FORWARDING', { reasonCode: 'DS06' });
  } else {
    executeOrders(store, orders);
    recordFinal(store, ctx, true, creditTransferProtocolText(store, orders));
  }

  return orders.map((order) => store.getPaymentOrder(order.id)!);
}

function executeOrders(store: AppStore, orders: PaymentOrder[]): void {
  for (const order of orders) {
    for (const tx of store.listPaymentTransactions(order.id)) {
      try {
        const booked = bookCreditTransfer(store, order, tx);
        store.updatePaymentTransaction(tx.id, booked);
      } catch (err) {
        logError('credit transfer booking', err);
      }
    }
    store.updatePaymentOrderStatus(order.id, 'EXECUTED');
    store.appendPaymentStatusEvent({ paymentOrderId: order.id, status: executedStatus(order) });
  }
}

/** All PmtInfs of the same EBICS order as `order` */
function ordersOfSameUpload(store: AppStore, order: PaymentOrder): PaymentOrder[] {
  return store.listPaymentOrders({ partnerId: order.partnerId, orderId: order.orderId }).reverse();
}

function requirePending(store: AppStore, id: number): PaymentOrder {
  const order = store.getPaymentOrder(id);
  if (!order) throw new PaymentOrderStateError(`Payment order ${id} not found`);
  if (order.status !== 'PENDING_EDS') {
    throw new PaymentOrderStateError(`Payment order ${id} is ${order.status}, only PENDING_EDS orders can be changed`);
  }
  return order;
}

/** Second signature arrived: execute and close the EBICS order */
export function releasePaymentOrder(store: AppStore, id: number): PaymentOrder {
  const order = requirePending(store, id);
  const orders = ordersOfSameUpload(store, order).filter((o) => o.status === 'PENDING_EDS');
  const ctx = orderContext(order);
  recordEvent(store, ctx, 'VEU_VERIFICATION_END', { reasonCode: 'DS01' });
  executeOrders(store, orders);
  recordFinal(store, ctx, true, creditTransferProtocolText(store, orders));
  return store.getPaymentOrder(id)!;
}

/** Cancelled by an authorised user in the VEU (HVS): nothing is booked, the order ends positively */
export function cancelPaymentOrder(store: AppStore, id: number, additionalInfo: string[] = []): PaymentOrder {
  const order = requirePending(store, id);
  const orders = ordersOfSameUpload(store, order).filter((o) => o.status === 'PENDING_EDS');
  for (const o of orders) {
    store.updatePaymentOrderStatus(o.id, 'CANCELLED');
    store.appendPaymentStatusEvent({ paymentOrderId: o.id, status: 'RJCT', reasonCode: 'DS02', additionalInfo });
  }
  const ctx = orderContext(order);
  recordEvent(
    store,
    { partnerId: order.partnerId, userId: order.userId, orderId: store.nextOrderId(order.partnerId), adminOrderType: 'HVS' },
    'VEU_CANCEL_ORDER',
    { reasonCode: 'DS02', orderIdRef: order.orderId, adminOrderTypeRef: 'BTU', additionalInfo },
  );
  recordFinal(store, ctx, true, creditTransferProtocolText(store, orders));
  return store.getPaymentOrder(id)!;
}

/** Refused by the bank: nothing is booked, the order ends negatively */
export function rejectPaymentOrder(
  store: AppStore,
  id: number,
  reasonCode = 'DS04',
  additionalInfo: string[] = [],
): PaymentOrder {
  const order = requirePending(store, id);
  const orders = ordersOfSameUpload(store, order).filter((o) => o.status === 'PENDING_EDS');
  for (const o of orders) {
    store.updatePaymentOrderStatus(o.id, 'REJECTED');
    store.appendPaymentStatusEvent({ paymentOrderId: o.id, status: 'RJCT', reasonCode, additionalInfo });
  }
  recordFinal(
    store,
    orderContext(order),
    false,
    additionalInfo.length > 0 ? additionalInfo : ['Der Auftrag wurde von der Bank abgelehnt.'],
  );
  return store.getPaymentOrder(id)!;
}

/** Appends a payment status (e.g. a later RJCT) without changing the order state */
export function addPaymentStatusEvent(
  store: AppStore,
  id: number,
  status: PaymentStatusCode,
  reasonCode?: string,
  additionalInfo: string[] = [],
): PaymentOrder {
  const order = store.getPaymentOrder(id);
  if (!order) throw new PaymentOrderStateError(`Payment order ${id} not found`);
  store.appendPaymentStatusEvent({ paymentOrderId: id, status, reasonCode, additionalInfo });
  return order;
}

/** Overrides the VoP result of one transaction */
export function overrideVop(
  store: AppStore,
  id: number,
  transactionId: number,
  status: VopStatus,
  correctedName?: string,
): PaymentTransaction {
  const tx = store.getPaymentTransaction(transactionId);
  if (!tx || tx.paymentOrderId !== id) {
    throw new PaymentOrderStateError(`Transaction ${transactionId} does not belong to payment order ${id}`);
  }
  store.updatePaymentTransaction(transactionId, {
    vopStatus: status,
    vopCorrectedName: status === 'RVMC' ? correctedName : undefined,
  });
  return store.getPaymentTransaction(transactionId)!;
}
