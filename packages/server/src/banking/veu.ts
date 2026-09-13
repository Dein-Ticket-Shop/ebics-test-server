import { createHash } from 'node:crypto';
import type { AppStore, OrderSignature, PaymentOrder, SignatureClass } from '../store/types.js';
import { ReturnCode } from '../protocol/return-codes.js';
import { cancelPaymentOrder, releasePaymentOrder } from './payments.js';
import { recordEvent } from './order-events.js';
import { isAuthorised, isBankTechnical } from './signatures.js';

/** An EBICS order (partner + OrderID) waiting in the VEU (distributed electronic signature) */
export interface VeuOrder {
  partnerId: string;
  orderId: string;
  /** PmtInfs of the order, oldest first */
  orders: PaymentOrder[];
  /** Bank-technical signatures (E, A, B) in signing order; transport signatures are not VEU signatures */
  signatures: OrderSignature[];
  /**
   * The upload requested EDS, so the VEU signatures must authorise it. Without requestEDS a waiting order was
   * authorised outside EBICS (no SignatureFlag) or by its class E uploader, and only waits for a VoP confirmation.
   */
  signaturesNeeded: boolean;
  vopConfirmationRequired: boolean;
  /** An HVE signature confirmed the VoP result */
  vopConfirmed: boolean;
  /** The uploaded pain.001 file */
  rawContent: string;
  /** A006 DataDigest: base64 SHA-256 of the order data without line breaks */
  dataDigest: string;
}

export class VeuError extends Error {
  constructor(
    readonly returnCode: ReturnCode,
    message: string,
  ) {
    super(message);
    this.name = 'VeuError';
  }
}

export function orderDataDigest(rawContent: string): string {
  return createHash('sha256').update(rawContent.replace(/\r?\n/g, '')).digest('base64');
}

function toVeuOrder(store: AppStore, orders: PaymentOrder[]): VeuOrder {
  const first = orders[0]!;
  const signatures = store.listOrderSignatures(first.partnerId, first.orderId).filter((s) => isBankTechnical(s.signatureClass));
  const rawContent = first.uploadedOrderId ? (store.getUploadedOrder(first.uploadedOrderId)?.rawContent ?? '') : '';
  return {
    partnerId: first.partnerId,
    orderId: first.orderId,
    orders,
    signatures,
    signaturesNeeded: orders.some((o) => o.requestedEds),
    vopConfirmationRequired: orders.some((o) => o.vopConfirmationRequired),
    vopConfirmed: signatures.some((s) => s.kind === 'HVE'),
    rawContent,
    dataDigest: orderDataDigest(rawContent),
  };
}

/** Orders waiting for signatures, oldest first; optionally only for one partner */
export function listVeuOrders(store: AppStore, partnerId?: string): VeuOrder[] {
  const byOrder = new Map<string, PaymentOrder[]>();
  for (const order of store.listPaymentOrders({ partnerId, status: 'PENDING_EDS' }).reverse()) {
    const key = `${order.partnerId}|${order.orderId}`;
    byOrder.set(key, [...(byOrder.get(key) ?? []), order]);
  }
  return [...byOrder.values()].map((orders) => toVeuOrder(store, orders));
}

export function getVeuOrder(store: AppStore, partnerId: string, orderId: string): VeuOrder | undefined {
  const orders = store.listPaymentOrders({ partnerId, orderId, status: 'PENDING_EDS' }).reverse();
  return orders.length > 0 ? toVeuOrder(store, orders) : undefined;
}

export function distinctSigners(veu: VeuOrder): number {
  return new Set(veu.signatures.map((s) => s.userId)).size;
}

/** One class per distinct signer, as of their first signature */
function signerClasses(veu: VeuOrder): SignatureClass[] {
  const byUser = new Map<string, SignatureClass>();
  for (const signature of veu.signatures) {
    if (!byUser.has(signature.userId)) byUser.set(signature.userId, signature.signatureClass);
  }
  return [...byUser.values()];
}

/** The order needs no VEU signatures, or they authorise it: one E, or two users with at least one E or A */
export function hasRequiredSignatures(veu: VeuOrder): boolean {
  return !veu.signaturesNeeded || isAuthorised(signerClasses(veu));
}

export function isReleasable(veu: VeuOrder): boolean {
  return hasRequiredSignatures(veu) && (!veu.vopConfirmationRequired || veu.vopConfirmed);
}

/** NumSigRequired as reported in HVZ: an order still waiting in the VEU needs at least one more signature */
export function numSigRequired(veu: VeuOrder): number {
  return veu.signatures.length + (isReleasable(veu) ? 0 : 1);
}

/** Whether a subscriber may sign: class E, A or B and not signed yet, unless confirming a pending VoP result */
export function canSign(veu: VeuOrder, signer: { userId: string; signatureClass: SignatureClass }): boolean {
  if (!isBankTechnical(signer.signatureClass)) return false;
  const confirmationPending = veu.vopConfirmationRequired && !veu.vopConfirmed;
  return confirmationPending || !veu.signatures.some((s) => s.userId === signer.userId);
}

function requireVeuOrder(store: AppStore, partnerId: string, orderId: string): VeuOrder {
  const veu = getVeuOrder(store, partnerId, orderId);
  if (!veu) throw new VeuError(ReturnCode.EBICS_ORDERID_UNKNOWN, `No order ${orderId} waiting for signatures`);
  return veu;
}

/** Signing and cancelling in the VEU need a bank-technical signature class (E, A or B) */
function requireSignatureClass(store: AppStore, request: { partnerId: string; userId: string }): SignatureClass {
  const subscriber = store.getSubscriber(request.partnerId, request.userId);
  if (!subscriber) throw new VeuError(ReturnCode.EBICS_SIGNER_UNKNOWN, `Unknown user ${request.userId}`);
  if (!isBankTechnical(subscriber.signatureClass)) {
    throw new VeuError(
      ReturnCode.EBICS_AUTHORISATION_ORDER_TYPE_FAILED,
      `User ${request.userId} has signature class T and can neither sign nor cancel orders`,
    );
  }
  return subscriber.signatureClass;
}

/**
 * Adds an electronic signature (HVE, or the bank-side VEU UI). The order is executed as soon as the signatures
 * authorise it and a required VoP confirmation is present. Returns the OrderID of the HVE.
 */
export function signVeuOrder(
  store: AppStore,
  request: { partnerId: string; orderId: string; userId: string },
): { orderId: string; released: boolean } {
  const veu = requireVeuOrder(store, request.partnerId, request.orderId);
  const signatureClass = requireSignatureClass(store, request);
  if (!canSign(veu, { userId: request.userId, signatureClass })) {
    throw new VeuError(ReturnCode.EBICS_DUPLICATE_SIGNATURE, `User ${request.userId} already signed order ${request.orderId}`);
  }

  const hveOrderId = store.nextOrderId(request.partnerId);
  store.addOrderSignature({ ...request, kind: 'HVE', signatureClass });
  const ctx = { partnerId: request.partnerId, userId: request.userId, orderId: hveOrderId, adminOrderType: 'HVE' };
  const reference = { orderIdRef: request.orderId, adminOrderTypeRef: 'BTU' };
  recordEvent(store, ctx, 'ES_UPLOAD', { reasonCode: 'TS01', ...reference });
  recordEvent(store, ctx, 'ES_VERIFICATION', { reasonCode: 'DS01', ...reference });

  const signed = requireVeuOrder(store, request.partnerId, request.orderId);
  if (!isReleasable(signed)) return { orderId: hveOrderId, released: false };
  releasePaymentOrder(store, signed.orders[0]!.id);
  return { orderId: hveOrderId, released: true };
}

/** Cancels the order in the VEU on behalf of a user (HVS, or the bank-side VEU UI). Returns the OrderID of the HVS. */
export function cancelVeuOrder(
  store: AppStore,
  request: { partnerId: string; orderId: string; userId: string },
  additionalInfo: string[] = [],
): { orderId: string } {
  const veu = requireVeuOrder(store, request.partnerId, request.orderId);
  requireSignatureClass(store, request);
  const hvsOrderId = store.nextOrderId(request.partnerId);
  cancelPaymentOrder(store, veu.orders[0]!.id, additionalInfo, { userId: request.userId, orderId: hvsOrderId });
  return { orderId: hvsOrderId };
}
