import { create } from 'xmlbuilder2';
import type { HandlerContext } from './handler-types.js';
import type { Subscriber, HostConfig, AppStore } from '../store/types.js';
import { EBICS_NS } from '../protocol/constants.js';

export function handleHaa(
  _ctx: HandlerContext,
  subscriber: Subscriber,
  _hostConfig: HostConfig,
  store: AppStore,
): string {
  const root = create({ version: '1.0', encoding: 'UTF-8' })
    .ele(EBICS_NS.H005, 'HAAResponseOrderData');

  const downloadData = store.listDownloadData();

  for (const dd of downloadData) {
    const orderInfo = root.ele(EBICS_NS.H005, 'OrderInfo');
    orderInfo.ele(EBICS_NS.H005, 'AdminOrderType').txt('BTD');
    const service = orderInfo.ele(EBICS_NS.H005, 'Service');
    service.ele(EBICS_NS.H005, 'ServiceName').txt(dd.serviceName);
    if (dd.msgName) {
      service.ele(EBICS_NS.H005, 'MsgName').txt(dd.msgName);
    }
    service.ele(EBICS_NS.H005, 'Scope').txt('DE');
    orderInfo.ele(EBICS_NS.H005, 'Description').txt(`${dd.serviceName} download`);
  }

  const partnerAccounts = store.listAccountsForPartner(subscriber.partnerId);
  if (partnerAccounts.length > 0) {
    for (const [sn, mn] of [['STA', 'camt.053'], ['STA', 'mt940'], ['EOP', 'camt.053']] as const) {
      const orderInfo = root.ele(EBICS_NS.H005, 'OrderInfo');
      orderInfo.ele(EBICS_NS.H005, 'AdminOrderType').txt('BTD');
      const service = orderInfo.ele(EBICS_NS.H005, 'Service');
      service.ele(EBICS_NS.H005, 'ServiceName').txt(sn);
      service.ele(EBICS_NS.H005, 'MsgName').txt(mn);
      service.ele(EBICS_NS.H005, 'Scope').txt('DE');
      orderInfo.ele(EBICS_NS.H005, 'Description').txt(`${sn}/${mn} statement`);
    }

    const reports = [
      ['STM', undefined, 'camt.052', 'Intraday account report'],
      ['STM', 'SCI', 'camt.054', 'Debit/credit notification'],
      ['REP', 'SCI', 'pain.002', 'Payment status report'],
      ['REP', 'VOP', 'pain.002', 'Verification of Payee report'],
    ] as const;
    for (const [serviceName, serviceOption, msgName, description] of reports) {
      const orderInfo = root.ele(EBICS_NS.H005, 'OrderInfo');
      orderInfo.ele(EBICS_NS.H005, 'AdminOrderType').txt('BTD');
      const service = orderInfo.ele(EBICS_NS.H005, 'Service');
      service.ele(EBICS_NS.H005, 'ServiceName').txt(serviceName);
      service.ele(EBICS_NS.H005, 'Scope').txt('DE');
      if (serviceOption) service.ele(EBICS_NS.H005, 'ServiceOption').txt(serviceOption);
      service.ele(EBICS_NS.H005, 'MsgName').txt(msgName);
      orderInfo.ele(EBICS_NS.H005, 'Description').txt(description);
    }
  }

  return root.end({ prettyPrint: true });
}
