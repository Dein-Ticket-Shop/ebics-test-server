import type { Subscriber, AppStore } from '../store/types.js';
import { ReturnCode } from '../protocol/return-codes.js';
import { processPain001 } from '../banking/processors/pain001.js';

export function handleBtu(
  rawContent: string,
  serviceName: string,
  msgName: string | undefined,
  subscriber: Subscriber,
  store: AppStore,
): ReturnCode {
  store.createUploadedOrder({
    partnerId: subscriber.partnerId,
    userId: subscriber.userId,
    serviceName,
    msgName,
    rawContent,
  });

  if (msgName === 'pain.001') {
    try {
      processPain001(rawContent, store);
    } catch {
      // best-effort — upload is still stored
    }
  }

  return ReturnCode.EBICS_OK;
}
