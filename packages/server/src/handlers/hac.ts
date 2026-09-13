import { create } from 'xmlbuilder2';
import type { HandlerContext, DownloadOrderData } from './handler-types.js';
import type { Subscriber, HostConfig, AppStore } from '../store/types.js';
import { hacFormat } from '../config/feature-flags.js';
import { xpathString } from '../protocol/xml-parser.js';
import { generateHacReport } from '../banking/generators/pain002.js';

export function handleHac(
  ctx: HandlerContext,
  subscriber: Subscriber,
  hostConfig: HostConfig,
  store: AppStore,
): DownloadOrderData {
  if (hacFormat() === 'pain.002') {
    return customerProtocol(ctx, subscriber, store);
  }

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

/** Customer name shown in the HAC originator: owner of the partner's first account, else the partner ID */
export function partnerDisplayName(store: AppStore, partnerId: string): string {
  const account = store.listAccountsForPartner(partnerId)[0];
  const person = account ? store.getPerson(account.personId) : undefined;
  return person?.name ?? partnerId;
}

/**
 * pain.002.001.03 customer protocol of the requesting partner (all its users). Without a DateRange
 * only events not yet fetched are returned; with a DateRange all events of those days.
 */
function customerProtocol(ctx: HandlerContext, subscriber: Subscriber, store: AppStore): DownloadOrderData {
  const from = xpathString('//ebics:StandardOrderParams/ebics:DateRange/ebics:Start/text()', ctx.doc);
  const to = xpathString('//ebics:StandardOrderParams/ebics:DateRange/ebics:End/text()', ctx.doc);
  const ranged = Boolean(from || to);

  let events = store.listHacEvents({ partnerId: subscriber.partnerId, from, to });
  if (!ranged) {
    const delivered = store.listDeliveredKeys(subscriber.partnerId, 'hac');
    events = events.filter((e) => !delivered.has(`hac:${e.id}`));
  }
  if (events.length === 0) return null;

  const content = generateHacReport(events, {
    bankBic: store.getBankConfig()?.bic,
    customerName: (partnerId) => partnerDisplayName(store, partnerId),
  });

  return {
    documents: [{ name: 'hac.xml', content }],
    ...(ranged ? {} : { deliveryKind: 'hac' as const, deliveryKeys: events.map((e) => `hac:${e.id}`) }),
  };
}
