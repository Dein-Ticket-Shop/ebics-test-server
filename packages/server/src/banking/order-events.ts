import type { AppStore, HacAction, HacEvent } from '../store/types.js';

/** Order attributes repeated on every HAC event of one EBICS order */
export interface OrderContext {
  partnerId: string;
  userId?: string;
  orderId: string;
  adminOrderType: string;
  serviceName?: string;
  serviceOption?: string;
  scope?: string;
  containerType?: string;
  msgName?: string;
  uploadedOrderId?: number;
}

export interface EventOptions {
  reasonCode?: string;
  additionalInfo?: string[];
  orderIdRef?: string;
  adminOrderTypeRef?: string;
  /** Banks omit the UserID on FINAL_* events */
  withoutUser?: boolean;
}

export function recordEvent(store: AppStore, ctx: OrderContext, action: HacAction, options: EventOptions = {}): HacEvent {
  return store.appendHacEvent({
    partnerId: ctx.partnerId,
    userId: options.withoutUser ? undefined : ctx.userId,
    orderId: ctx.orderId,
    action,
    adminOrderType: ctx.adminOrderType,
    serviceName: ctx.serviceName,
    serviceOption: ctx.serviceOption,
    scope: ctx.scope,
    containerType: ctx.containerType,
    msgName: ctx.msgName,
    orderIdRef: options.orderIdRef,
    adminOrderTypeRef: options.adminOrderTypeRef,
    reasonCode: options.reasonCode,
    additionalInfo: options.additionalInfo,
    uploadedOrderId: ctx.uploadedOrderId,
  });
}

/** End marker of an order: positive (processed, or cancelled by an authorised user) or negative */
export function recordFinal(store: AppStore, ctx: OrderContext, positive: boolean, additionalInfo: string[] = []): HacEvent {
  return recordEvent(store, ctx, positive ? 'ORDER_HAC_FINAL_POS' : 'ORDER_HAC_FINAL_NEG', {
    additionalInfo,
    withoutUser: true,
  });
}

/** Upload received, signature verified and order completed */
export function recordUploadCompleted(store: AppStore, ctx: OrderContext, protocolText: string[] = []): void {
  recordEvent(store, ctx, 'FILE_UPLOAD', { reasonCode: 'TS01' });
  recordEvent(store, ctx, 'ES_VERIFICATION', { reasonCode: 'DS01' });
  recordFinal(store, ctx, true, protocolText);
}

/** Upload received but the order was refused: TD03 for the order data, DS19 for insufficient signature rights */
export function recordUploadRejected(store: AppStore, ctx: OrderContext, message: string, reasonCode = 'TD03'): void {
  recordEvent(store, ctx, 'FILE_UPLOAD', { reasonCode: 'TS01' });
  recordEvent(store, ctx, 'ES_VERIFICATION', { reasonCode, additionalInfo: [message] });
  recordFinal(store, ctx, false, [message]);
}

/** INI / HIA accepted: the order stays open until the bank activates the subscriber */
export function recordKeyManagementOrder(
  store: AppStore,
  partnerId: string,
  userId: string,
  adminOrderType: 'INI' | 'HIA',
): string {
  const orderId = store.nextOrderId(partnerId);
  recordEvent(store, { partnerId, userId, orderId, adminOrderType }, 'FILE_UPLOAD', { reasonCode: 'TS01' });
  return orderId;
}

/** Activation closes the subscriber's open INI and HIA orders */
export function recordSubscriberActivated(store: AppStore, partnerId: string, userId: string): void {
  const events = store.listHacEvents({ partnerId });
  const finished = new Set(events.filter((e) => e.action.startsWith('ORDER_HAC_FINAL')).map((e) => e.orderId));
  for (const event of events) {
    if (
      event.userId === userId &&
      event.action === 'FILE_UPLOAD' &&
      (event.adminOrderType === 'INI' || event.adminOrderType === 'HIA') &&
      !finished.has(event.orderId)
    ) {
      recordFinal(store, { partnerId, userId, orderId: event.orderId, adminOrderType: event.adminOrderType }, true);
      finished.add(event.orderId);
    }
  }
}
