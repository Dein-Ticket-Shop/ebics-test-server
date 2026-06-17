import { create } from 'xmlbuilder2';
import type { HandlerContext } from './handler-types.js';
import type { Subscriber, HostConfig, EbicsStore } from '../store/types.js';
import { EBICS_NS } from '../protocol/constants.js';

const SUPPORTED_ORDER_TYPES = ['HPD', 'HTD', 'HKD', 'HAA', 'HAC', 'BTD'];

export function handleHtd(
  _ctx: HandlerContext,
  subscriber: Subscriber,
  hostConfig: HostConfig,
  _store: EbicsStore,
): string {
  const root = create({ version: '1.0', encoding: 'UTF-8' })
    .ele(EBICS_NS.H005, 'HTDResponseOrderData');

  const partnerInfo = root.ele(EBICS_NS.H005, 'PartnerInfo');
  const addressInfo = partnerInfo.ele(EBICS_NS.H005, 'AddressInfo');
  addressInfo.ele(EBICS_NS.H005, 'Name').txt('Test Partner');

  const bankInfo = partnerInfo.ele(EBICS_NS.H005, 'BankInfo');
  bankInfo.ele(EBICS_NS.H005, 'HostID').txt(hostConfig.hostId);

  for (const ot of SUPPORTED_ORDER_TYPES) {
    const orderInfo = partnerInfo.ele(EBICS_NS.H005, 'OrderInfo');
    orderInfo.ele(EBICS_NS.H005, 'AdminOrderType').txt(ot);
    orderInfo.ele(EBICS_NS.H005, 'Description').txt(`${ot} order type`);
  }

  const userInfo = root.ele(EBICS_NS.H005, 'UserInfo');
  userInfo.ele(EBICS_NS.H005, 'UserID').att('Status', '1').txt(subscriber.userId);
  userInfo.ele(EBICS_NS.H005, 'Name').txt(subscriber.userId);

  for (const ot of SUPPORTED_ORDER_TYPES) {
    const perm = userInfo.ele(EBICS_NS.H005, 'Permission');
    perm.ele(EBICS_NS.H005, 'AdminOrderType').txt(ot);
  }

  return root.end({ prettyPrint: true });
}
