import type { Subscriber, AppStore } from '../store/types.js';
import { ReturnCode } from '../protocol/return-codes.js';
import { processPain001 } from '../banking/processors/pain001.js';
import { processPain008 } from '../banking/processors/pain008.js';
import { OrderDataError, OrderAuthError } from '../banking/validation.js';
import { directDebitProtocolText, receiveCreditTransfers } from '../banking/payments.js';
import { recordUploadCompleted, recordUploadRejected, type OrderContext } from '../banking/order-events.js';
import { logError } from '../logger.js';

/** Upload transaction attributes the order lifecycle needs (set by the dispatcher) */
export interface BtuOrderContext {
  orderId?: string;
  serviceOption?: string;
  /** BTUOrderParams/SignatureFlag/@requestEDS */
  requestEds?: boolean;
}

export function handleBtu(
  rawContent: string,
  serviceName: string,
  msgName: string | undefined,
  subscriber: Subscriber,
  store: AppStore,
  context: BtuOrderContext = {},
): ReturnCode {
  const order = store.createUploadedOrder({
    partnerId: subscriber.partnerId,
    userId: subscriber.userId,
    serviceName,
    msgName,
    rawContent,
    orderId: context.orderId,
  });

  const events: OrderContext | undefined = context.orderId
    ? {
        partnerId: subscriber.partnerId,
        userId: subscriber.userId,
        orderId: context.orderId,
        adminOrderType: 'BTU',
        serviceName,
        serviceOption: context.serviceOption,
        msgName,
        uploadedOrderId: order.id,
      }
    : undefined;

  try {
    if (msgName === 'pain.001') {
      if (context.orderId) {
        // Payment orders with VoP, payment status history, HAC events and optional EDS hold
        receiveCreditTransfers(store, {
          rawContent,
          partnerId: subscriber.partnerId,
          userId: subscriber.userId,
          orderId: context.orderId,
          uploadedOrderId: order.id,
          serviceName,
          serviceOption: context.serviceOption,
          msgName,
          requestEds: context.requestEds ?? false,
        });
      } else {
        processPain001(rawContent, store, subscriber.partnerId);
      }
      store.markUploadedOrderProcessed(order.id);
    } else if (msgName === 'pain.008') {
      processPain008(rawContent, store, subscriber.partnerId);
      store.markUploadedOrderProcessed(order.id);
      if (events) recordUploadCompleted(store, events, directDebitProtocolText(store, rawContent));
    } else if (events) {
      recordUploadCompleted(store, events);
    }
  } catch (err) {
    // best-effort — upload is still stored, left unprocessed
    logError(`${msgName ?? serviceName} processing`, err);
    if (events) {
      recordUploadRejected(store, events, err instanceof Error ? err.message : String(err));
    }
    // Malformed IBAN/BIC under strict validation: bounce the file like a real bank.
    if (err instanceof OrderDataError) {
      return ReturnCode.EBICS_INVALID_ORDER_DATA_FORMAT;
    }
    // Ordering-party account unknown or partner not authorised for it.
    if (err instanceof OrderAuthError) {
      return ReturnCode.EBICS_ACCOUNT_AUTHORISATION_FAILED;
    }
  }

  return ReturnCode.EBICS_OK;
}
