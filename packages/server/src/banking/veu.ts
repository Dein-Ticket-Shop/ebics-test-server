import { createHash } from 'node:crypto';
import type { AppStore, OrderSignature, PaymentOrder } from '../store/types.js';
import { ReturnCode } from '../protocol/return-codes.js';
import { cancelPaymentOrder, releasePaymentOrder } from './payments.js';
import { recordEvent } from './order-events.js';

/** An EBICS order (partner + OrderID) waiting in the VEU (distributed electronic signature) */
export interface VeuOrder {
  partnerId: string;
  orderId: string;
  /** PmtInfs of the order, oldest first */
  orders: PaymentOrder[];
  signatures: OrderSignature[];
  /** Distinct users whose signatures release the order */
  signaturesRequired: number;
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
  const signatures = store.listOrderSignatures(first.partnerId, first.orderId);
  const rawContent = first.uploadedOrderId ? (store.getUploadedOrder(first.uploadedOrderId)?.rawContent ?? '') : '';
  return {
    partnerId: first.partnerId,
    orderId: first.orderId,
    orders,
    signatures,
    signaturesRequired: Math.max(...orders.map((o) => o.signaturesRequired)),
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

/**
 * NumSigRequired as reported in HVZ: the total number of signatures needed for release, so a pending order
 * always reports more than NumSigDone. Missing distinct signers count, and a pending VoP confirmation needs
 * at least one more signature.
 */
export function numSigRequired(veu: VeuOrder): number {
  const confirmationPending = veu.vopConfirmationRequired && !veu.vopConfirmed;
  const missingSigners = Math.max(veu.signaturesRequired - distinctSigners(veu), 0);
  return veu.signatures.length + Math.max(missingSigners, confirmationPending ? 1 : 0);
}

/** Whether the user may sign: not signed yet, or confirming a pending VoP result (also allowed for the uploader) */
export function canSign(veu: VeuOrder, userId: string): boolean {
  const confirmationPending = veu.vopConfirmationRequired && !veu.vopConfirmed;
  return confirmationPending || !veu.signatures.some((s) => s.userId === userId);
}

export function isReleasable(veu: VeuOrder): boolean {
  return distinctSigners(veu) >= veu.signaturesRequired && (!veu.vopConfirmationRequired || veu.vopConfirmed);
}

function requireVeuOrder(store: AppStore, partnerId: string, orderId: string): VeuOrder {
  const veu = getVeuOrder(store, partnerId, orderId);
  if (!veu) throw new VeuError(ReturnCode.EBICS_ORDERID_UNKNOWN, `No order ${orderId} waiting for signatures`);
  return veu;
}

/**
 * Adds an electronic signature (HVE, or the bank-side VEU UI). The order is executed as soon as enough
 * distinct users signed and a required VoP confirmation is present. Returns the OrderID of the HVE.
 */
export function signVeuOrder(
  store: AppStore,
  request: { partnerId: string; orderId: string; userId: string },
): { orderId: string; released: boolean } {
  const veu = requireVeuOrder(store, request.partnerId, request.orderId);
  if (!canSign(veu, request.userId)) {
    throw new VeuError(ReturnCode.EBICS_DUPLICATE_SIGNATURE, `User ${request.userId} already signed order ${request.orderId}`);
  }

  const hveOrderId = store.nextOrderId(request.partnerId);
  store.addOrderSignature({ ...request, kind: 'HVE' });
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
  const hvsOrderId = store.nextOrderId(request.partnerId);
  cancelPaymentOrder(store, veu.orders[0]!.id, additionalInfo, { userId: request.userId, orderId: hvsOrderId });
  return { orderId: hvsOrderId };
}
