import type { AppStore, DirectDebitOrder, MinimumSignatures, SignatureClass } from '../store/types.js';
import { recordEvent, recordFinal, type OrderContext } from './order-events.js';
import { PaymentOrderStateError, directDebitProtocolText } from './payments.js';
import { minimumSignaturesNote } from './signatures.js';
import { processPain008, validatePain008 } from './processors/pain008.js';

/**
 * Direct debits in the VEU (EBICS 3.0.2 chapter 8): a pain.008 upload with SignatureFlag and requestEDS whose
 * electronic signatures do not authorise it waits as a DirectDebitOrder until further signatures (HVE) release it or
 * it is cancelled (HVS). Nothing is booked while it waits.
 */

export interface DirectDebitUpload {
  rawContent: string;
  partnerId: string;
  userId: string;
  orderId: string;
  uploadedOrderId: number;
  serviceName: string;
  serviceOption?: string;
  msgName: string;
  /** Verified signers of the upload with the classes their signatures count as */
  signers: { userId: string; signatureClass: SignatureClass }[];
  minimumSignatures: MinimumSignatures;
}

export function directDebitContext(order: DirectDebitOrder): OrderContext {
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

/** Validates the file and holds it in the VEU: FILE_UPLOAD, ES_VERIFICATION and VEU_FORWARDING under the BTU order */
export function holdDirectDebits(store: AppStore, upload: DirectDebitUpload): DirectDebitOrder {
  validatePain008(upload.rawContent, store, upload.partnerId);
  for (const signer of upload.signers) {
    store.addOrderSignature({
      partnerId: upload.partnerId,
      orderId: upload.orderId,
      userId: signer.userId,
      kind: 'UPLOAD',
      signatureClass: signer.signatureClass,
    });
  }
  const order = store.createDirectDebitOrder({
    orderId: upload.orderId,
    uploadedOrderId: upload.uploadedOrderId,
    partnerId: upload.partnerId,
    userId: upload.userId,
    serviceName: upload.serviceName,
    serviceOption: upload.serviceOption,
    msgName: upload.msgName,
  });
  const ctx = directDebitContext(order);
  const classes = upload.signers.map((signer) => signer.signatureClass).join('+');
  recordEvent(store, ctx, 'FILE_UPLOAD', { reasonCode: 'TS01' });
  recordEvent(store, ctx, 'ES_VERIFICATION', { reasonCode: 'DS01' });
  recordEvent(store, ctx, 'VEU_FORWARDING', {
    reasonCode: 'DS06',
    additionalInfo: [`Unterschriftsklasse ${classes}${minimumSignaturesNote(upload.minimumSignatures)}: weitere Unterschrift erforderlich`],
  });
  return order;
}

function requirePendingDirectDebit(store: AppStore, id: number): DirectDebitOrder {
  const order = store.getDirectDebitOrder(id);
  if (!order) throw new PaymentOrderStateError(`Direct debit order ${id} not found`);
  if (order.status !== 'PENDING_EDS') {
    throw new PaymentOrderStateError(`Direct debit order ${id} is ${order.status}, only PENDING_EDS orders can be changed`);
  }
  return order;
}

function rawContentOf(store: AppStore, order: DirectDebitOrder): string {
  return store.getUploadedOrder(order.uploadedOrderId)?.rawContent ?? '';
}

/** The signatures authorise the order: book the direct debits and close the EBICS order */
export function releaseDirectDebitOrder(store: AppStore, id: number): DirectDebitOrder {
  const order = requirePendingDirectDebit(store, id);
  const rawContent = rawContentOf(store, order);
  const ctx = directDebitContext(order);
  recordEvent(store, ctx, 'VEU_VERIFICATION_END', { reasonCode: 'DS01' });
  processPain008(rawContent, store, order.partnerId);
  store.updateDirectDebitOrderStatus(order.id, 'EXECUTED');
  recordFinal(store, ctx, true, directDebitProtocolText(store, rawContent));
  return store.getDirectDebitOrder(id)!;
}

/**
 * Cancelled in the VEU (HVS): nothing is booked, the order ends positively.
 * `cancelledBy` names the user and the OrderID of the HVS; by default the uploader and a new OrderID.
 */
export function cancelDirectDebitOrder(
  store: AppStore,
  id: number,
  additionalInfo: string[] = [],
  cancelledBy?: { userId: string; orderId?: string },
): DirectDebitOrder {
  const order = requirePendingDirectDebit(store, id);
  store.updateDirectDebitOrderStatus(order.id, 'CANCELLED');
  recordEvent(
    store,
    {
      partnerId: order.partnerId,
      userId: cancelledBy?.userId ?? order.userId,
      orderId: cancelledBy?.orderId ?? store.nextOrderId(order.partnerId),
      adminOrderType: 'HVS',
    },
    'VEU_CANCEL_ORDER',
    { reasonCode: 'DS02', orderIdRef: order.orderId, adminOrderTypeRef: 'BTU', additionalInfo },
  );
  recordFinal(store, directDebitContext(order), true, directDebitProtocolText(store, rawContentOf(store, order)));
  return store.getDirectDebitOrder(id)!;
}
