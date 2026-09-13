import type { Subscriber, AppStore } from '../store/types.js';
import { ReturnCode } from '../protocol/return-codes.js';
import { processPain001 } from '../banking/processors/pain001.js';
import { processPain008 } from '../banking/processors/pain008.js';
import { OrderDataError, OrderAuthError, SignatureAuthorisationError } from '../banking/validation.js';
import { directDebitProtocolText, receiveCreditTransfers } from '../banking/payments.js';
import { recordUploadCompleted, recordUploadRejected, type OrderContext } from '../banking/order-events.js';
import { uploadDecision, uploadSignatureClass } from '../banking/signatures.js';
import { logError } from '../logger.js';

/** Upload transaction attributes the order lifecycle needs (set by the dispatcher) */
export interface BtuOrderContext {
  orderId?: string;
  serviceOption?: string;
  /** BTUOrderParams/SignatureFlag is present: the order is authorised within EBICS */
  signatureFlag?: boolean;
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

  const signatureFlag = context.signatureFlag ?? false;
  const requestEds = context.requestEds ?? false;
  const signatureClass = uploadSignatureClass(signatureFlag, subscriber.signatureClass);

  try {
    if (uploadDecision({ signatureFlag, requestEds, signatureClass }) === 'reject') {
      throw new SignatureAuthorisationError(
        `Unterschriftsklasse ${signatureClass} von ${subscriber.userId} reicht nicht aus und keine VEU angefordert`,
      );
    }
    if (msgName === 'pain.001') {
      if (context.orderId) {
        // Payment orders with VoP, payment status history, HAC events and the VEU for missing signatures
        receiveCreditTransfers(store, {
          rawContent,
          partnerId: subscriber.partnerId,
          userId: subscriber.userId,
          orderId: context.orderId,
          uploadedOrderId: order.id,
          serviceName,
          serviceOption: context.serviceOption,
          msgName,
          signatureFlag,
          requestEds,
          signatureClass: subscriber.signatureClass,
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
      const reasonCode = err instanceof SignatureAuthorisationError ? 'DS19' : 'TD03';
      recordUploadRejected(store, events, err instanceof Error ? err.message : String(err), reasonCode);
    }
    // Malformed IBAN/BIC under strict validation: bounce the file like a real bank.
    if (err instanceof OrderDataError) {
      return ReturnCode.EBICS_INVALID_ORDER_DATA_FORMAT;
    }
    // Ordering-party account unknown or partner not authorised for it.
    if (err instanceof OrderAuthError) {
      return ReturnCode.EBICS_ACCOUNT_AUTHORISATION_FAILED;
    }
    // Signature flag set, but the uploader's signature class does not authorise the order and no VEU was requested.
    if (err instanceof SignatureAuthorisationError) {
      return ReturnCode.EBICS_SIGNATURE_VERIFICATION_FAILED;
    }
  }

  return ReturnCode.EBICS_OK;
}
