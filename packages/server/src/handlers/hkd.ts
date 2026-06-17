import { create } from 'xmlbuilder2';
import type { HandlerContext } from './handler-types.js';
import type { Subscriber, HostConfig, AppStore } from '../store/types.js';
import { EBICS_NS } from '../protocol/constants.js';
import {
  buildPartnerInfo,
  buildUserPermissions,
  userStatusFromState,
  SUPPORTED_ORDER_TYPES,
} from './partner-info.js';

export function handleHkd(
  _ctx: HandlerContext,
  subscriber: Subscriber,
  hostConfig: HostConfig,
  store: AppStore,
): string {
  const allSubscribers = store.listSubscribers().filter(
    (s) => s.partnerId === subscriber.partnerId,
  );
  const accounts = store.listAccountsForPartner(subscriber.partnerId);

  const root = create({ version: '1.0', encoding: 'UTF-8' })
    .ele(EBICS_NS.H005, 'HKDResponseOrderData');

  buildPartnerInfo(root, subscriber.partnerId, hostConfig, accounts, SUPPORTED_ORDER_TYPES);

  for (const sub of allSubscribers) {
    const userInfo = root.ele(EBICS_NS.H005, 'UserInfo');
    userInfo
      .ele(EBICS_NS.H005, 'UserID')
      .att('Status', userStatusFromState(sub.state))
      .txt(sub.userId);
    userInfo.ele(EBICS_NS.H005, 'Name').txt(sub.userId);
    buildUserPermissions(userInfo, SUPPORTED_ORDER_TYPES);
  }

  return root.end({ prettyPrint: true });
}
