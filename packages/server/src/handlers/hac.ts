import { create } from 'xmlbuilder2';
import type { HandlerContext } from './handler-types.js';
import type { Subscriber, HostConfig, EbicsStore } from '../store/types.js';

export function handleHac(
  _ctx: HandlerContext,
  subscriber: Subscriber,
  _hostConfig: HostConfig,
  store: EbicsStore,
): string {
  const root = create({ version: '1.0', encoding: 'UTF-8' })
    .ele('HACResponseOrderData');

  const entries = store.getActivityLog(50, 0);

  for (const entry of entries) {
    const item = root.ele('OrderDetails');
    item.ele('OrderType').txt(entry.orderType ?? 'N/A');
    item.ele('PartnerID').txt(entry.partnerId ?? subscriber.partnerId);
    item.ele('UserID').txt(entry.userId ?? subscriber.userId);
    item.ele('Timestamp').txt(entry.createdAt);
    item.ele('ReturnCode').txt(entry.resultCode ?? '000000');
  }

  return root.end({ prettyPrint: true });
}
