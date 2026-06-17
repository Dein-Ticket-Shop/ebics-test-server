import type { Subscriber, AppStore } from '../store/types.js';
import { ReturnCode } from '../protocol/return-codes.js';
import { processPain001 } from '../banking/processors/pain001.js';
import { processPain008 } from '../banking/processors/pain008.js';
import { OrderDataError, OrderAuthError } from '../banking/validation.js';
import { logError } from '../logger.js';

export function handleBtu(
  rawContent: string,
  serviceName: string,
  msgName: string | undefined,
  subscriber: Subscriber,
  store: AppStore,
): ReturnCode {
  const order = store.createUploadedOrder({
    partnerId: subscriber.partnerId,
    userId: subscriber.userId,
    serviceName,
    msgName,
    rawContent,
  });

  try {
    if (msgName === 'pain.001') {
      processPain001(rawContent, store, subscriber.partnerId);
      store.markUploadedOrderProcessed(order.id);
    } else if (msgName === 'pain.008') {
      processPain008(rawContent, store, subscriber.partnerId);
      store.markUploadedOrderProcessed(order.id);
    }
  } catch (err) {
    // best-effort — upload is still stored, left unprocessed
    logError(`${msgName ?? serviceName} processing`, err);
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
