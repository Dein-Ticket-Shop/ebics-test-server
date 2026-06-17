import type { HandlerContext, HandlerResult } from './handler-types.js';
import type { Subscriber, AppStore } from '../store/types.js';
import { SubscriberState } from '../store/types.js';
import { ReturnCode } from '../protocol/return-codes.js';
import { buildEbicsResponse } from '../protocol/xml-builder.js';

export function handleSpr(
  _ctx: HandlerContext,
  subscriber: Subscriber,
  _hostConfig: unknown,
  store: AppStore,
): HandlerResult {
  store.updateSubscriberState(subscriber.partnerId, subscriber.userId, SubscriberState.SUSPENDED);
  store.logActivity({
    eventType: 'subscriber_suspended',
    partnerId: subscriber.partnerId,
    userId: subscriber.userId,
    orderType: 'SPR',
    resultCode: ReturnCode.EBICS_OK,
  });

  return buildEbicsResponse({
    technicalCode: ReturnCode.EBICS_OK,
    businessCode: ReturnCode.EBICS_OK,
    transactionPhase: 'Initialisation',
  });
}
