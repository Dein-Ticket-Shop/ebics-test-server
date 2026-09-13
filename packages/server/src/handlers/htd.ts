import { create } from 'xmlbuilder2';
import type { HandlerContext } from './handler-types.js';
import type { Subscriber, HostConfig, AppStore } from '../store/types.js';
import { EBICS_NS } from '../protocol/constants.js';
import {
  buildPartnerInfo,
  buildUserPermissions,
  permittedOrderTypes,
  userStatusFromState,
  SUPPORTED_ORDER_TYPES,
} from './partner-info.js';

export function handleHtd(
  _ctx: HandlerContext,
  subscriber: Subscriber,
  hostConfig: HostConfig,
  store: AppStore,
): string {
  const accounts = store.listAccountsForPartner(subscriber.partnerId);

  const root = create({ version: '1.0', encoding: 'UTF-8' })
    .ele(EBICS_NS.H005, 'HTDResponseOrderData');

  buildPartnerInfo(root, subscriber.partnerId, hostConfig, accounts, SUPPORTED_ORDER_TYPES);

  const userInfo = root.ele(EBICS_NS.H005, 'UserInfo');
  userInfo
    .ele(EBICS_NS.H005, 'UserID')
    .att('Status', userStatusFromState(subscriber.state))
    .txt(subscriber.userId);
  userInfo.ele(EBICS_NS.H005, 'Name').txt(subscriber.userId);
  buildUserPermissions(userInfo, permittedOrderTypes(subscriber));

  return root.end({ prettyPrint: true });
}
