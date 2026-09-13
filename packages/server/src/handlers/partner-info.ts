import type { XMLBuilder } from 'xmlbuilder2/lib/interfaces.js';
import type { Account, HostConfig, SignatureClass } from '../store/types.js';
import { SubscriberState } from '../store/types.js';
import { EBICS_NS } from '../protocol/constants.js';

/** BTF service descriptor (RestrictedServiceType: ServiceName, Scope?, ServiceOption?, MsgName). */
export interface ServiceInfo {
  serviceName: string;
  scope?: string;
  serviceOption?: string;
  msgName: string;
}

/** One advertised order type. `service` present only for BTU/BTD (BTF) entries. */
export interface OrderTypeInfo {
  adminType: string;
  service?: ServiceInfo;
  description: string;
}

/**
 * Single source of truth for the order types this server actually handles in the
 * secured (post-initialisation) flow — see dispatcher.ts. Advertised verbatim in HTD
 * and HKD so a client's capability probe matches what the server will accept.
 */
export const SUPPORTED_ORDER_TYPES: OrderTypeInfo[] = [
  // Administrative downloads
  { adminType: 'HPD', description: 'Download bank parameters' },
  { adminType: 'HTD', description: 'Download subscriber data' },
  { adminType: 'HKD', description: 'Download customer data' },
  { adminType: 'HAA', description: 'Download available order types' },
  { adminType: 'HAC', description: 'Download customer acknowledgement' },
  { adminType: 'PTK', description: 'Download customer protocol (text)' },
  // Distributed electronic signature (VEU)
  { adminType: 'HVU', description: 'VEU overview' },
  { adminType: 'HVZ', description: 'VEU overview with order details' },
  { adminType: 'HVD', description: 'VEU state of an order' },
  { adminType: 'HVT', description: 'VEU transaction details' },
  { adminType: 'HVE', description: 'VEU signature' },
  { adminType: 'HVS', description: 'VEU cancellation' },
  // Administrative uploads / key management
  { adminType: 'PUB', description: 'Send signature public key' },
  { adminType: 'HCA', description: 'Send authentication & encryption public keys' },
  { adminType: 'HCS', description: 'Send all subscriber keys' },
  { adminType: 'SPR', description: 'Suspend subscriber access' },
  // Business uploads (BTU) — handled by handleBtu / pain processors
  { adminType: 'BTU', service: { serviceName: 'SCT', scope: 'DE', msgName: 'pain.001' }, description: 'SEPA Credit Transfer' },
  { adminType: 'BTU', service: { serviceName: 'SDD', scope: 'DE', msgName: 'pain.008' }, description: 'SEPA Direct Debit (CORE)' },
  { adminType: 'BTU', service: { serviceName: 'SDD', scope: 'DE', serviceOption: 'B2B', msgName: 'pain.008' }, description: 'SEPA Direct Debit (B2B)' },
  // Business downloads (BTD) — handled by handleBtd
  { adminType: 'BTD', service: { serviceName: 'STA', scope: 'DE', msgName: 'camt.053' }, description: 'Bank statement (camt.053)' },
  { adminType: 'BTD', service: { serviceName: 'STA', scope: 'DE', msgName: 'mt940' }, description: 'Bank statement (MT940)' },
  // SEPA Instant with payment status, notification and Verification of Payee reports
  { adminType: 'BTU', service: { serviceName: 'SCI', scope: 'DE', serviceOption: 'VOI', msgName: 'pain.001' }, description: 'SEPA Instant Credit Transfer' },
  { adminType: 'BTD', service: { serviceName: 'EOP', scope: 'DE', msgName: 'camt.053' }, description: 'End of period statement (camt.053)' },
  { adminType: 'BTD', service: { serviceName: 'STM', scope: 'DE', msgName: 'camt.052' }, description: 'Intraday account report (camt.052)' },
  { adminType: 'BTD', service: { serviceName: 'STM', scope: 'DE', serviceOption: 'SCI', msgName: 'camt.054' }, description: 'Debit/credit notification (camt.054)' },
  { adminType: 'BTD', service: { serviceName: 'REP', scope: 'DE', serviceOption: 'SCI', msgName: 'pain.002' }, description: 'Payment status report (pain.002)' },
  { adminType: 'BTD', service: { serviceName: 'REP', scope: 'DE', serviceOption: 'VOP', msgName: 'pain.002' }, description: 'Verification of Payee report (pain.002)' },
  { adminType: 'BTD', service: { serviceName: 'OTH', scope: 'DE', msgName: 'wssparam' }, description: 'Real-time notification connection parameters' },
];

/** Maps a subscriber lifecycle state to the EBICS UserStatusType integer. */
export function userStatusFromState(state: SubscriberState): string {
  switch (state) {
    case SubscriberState.READY:
    case SubscriberState.INITIALIZED:
      return '1';
    default:
      return '0';
  }
}

/** Emits a RestrictedServiceType block in schema element order. */
function addService(node: XMLBuilder, service: ServiceInfo): void {
  const el = node.ele(EBICS_NS.H005, 'Service');
  el.ele(EBICS_NS.H005, 'ServiceName').txt(service.serviceName);
  if (service.scope) {
    el.ele(EBICS_NS.H005, 'Scope').txt(service.scope);
  }
  if (service.serviceOption) {
    el.ele(EBICS_NS.H005, 'ServiceOption').txt(service.serviceOption);
  }
  el.ele(EBICS_NS.H005, 'MsgName').txt(service.msgName);
}

/**
 * Builds the PartnerInfo block shared by the HKD and HTD responses:
 * address, bank host, accessible accounts and authorised order types.
 */
export function buildPartnerInfo(
  parent: XMLBuilder,
  partnerId: string,
  hostConfig: HostConfig,
  accounts: Account[],
  orderTypes: OrderTypeInfo[],
  /** Agreed minimum number of bank-technical signatures per BTF service, reported as NumSigRequired of BTU entries */
  minimumSignatures?: (serviceName: string) => number,
): void {
  const partnerInfo = parent.ele(EBICS_NS.H005, 'PartnerInfo');

  const addressInfo = partnerInfo.ele(EBICS_NS.H005, 'AddressInfo');
  addressInfo.ele(EBICS_NS.H005, 'Name').txt(partnerId);

  const bankInfo = partnerInfo.ele(EBICS_NS.H005, 'BankInfo');
  bankInfo.ele(EBICS_NS.H005, 'HostID').txt(hostConfig.hostId);

  for (const account of accounts) {
    const accountInfo = partnerInfo
      .ele(EBICS_NS.H005, 'AccountInfo')
      .att('ID', String(account.id))
      .att('Currency', account.currency);
    accountInfo.ele(EBICS_NS.H005, 'AccountNumber').att('international', 'true').txt(account.iban);
    accountInfo.ele(EBICS_NS.H005, 'AccountHolder').txt(account.name);
  }

  for (const ot of orderTypes) {
    const orderInfo = partnerInfo.ele(EBICS_NS.H005, 'OrderInfo');
    orderInfo.ele(EBICS_NS.H005, 'AdminOrderType').txt(ot.adminType);
    if (ot.service) {
      addService(orderInfo, ot.service);
    }
    orderInfo.ele(EBICS_NS.H005, 'Description').txt(ot.description);
    // NumSigRequired: "Anzahl erforderlicher EUs" (default 0), agreed per BTF between bank and customer (chapter 3.5)
    if (ot.adminType === 'BTU' && ot.service && minimumSignatures) {
      orderInfo.ele(EBICS_NS.H005, 'NumSigRequired').txt(String(minimumSignatures(ot.service.serviceName)));
    }
  }
}

/** AdminOrderTypes that send order data to the bank: their Permission carries the user's signature class */
const UPLOAD_ORDER_TYPES: readonly string[] = ['BTU', 'HVE', 'HVS', 'PUB', 'HCA', 'HCS', 'SPR'];

/**
 * Adds the Permission entries for a subscriber's UserInfo block. Upload order types carry the signature class
 * (AuthorisationLevel); the spec leaves it out for downloads.
 */
export function buildUserPermissions(userInfo: XMLBuilder, orderTypes: OrderTypeInfo[], signatureClass: SignatureClass): void {
  for (const ot of orderTypes) {
    const perm = userInfo.ele(EBICS_NS.H005, 'Permission');
    if (UPLOAD_ORDER_TYPES.includes(ot.adminType)) {
      perm.att('AuthorisationLevel', signatureClass);
    }
    perm.ele(EBICS_NS.H005, 'AdminOrderType').txt(ot.adminType);
    if (ot.service) {
      addService(perm, ot.service);
    }
  }
}

/** AdminOrderTypes of the customer protocol; a subscriber may be denied them (090003) */
export const PROTOCOL_ORDER_TYPES: readonly string[] = ['HAC', 'PTK'];

/** AdminOrderTypes of the VEU that need a bank-technical signature; not permitted for signature class T (090003) */
export const SIGNING_ORDER_TYPES: readonly string[] = ['HVE', 'HVS'];

/** The order types listed as Permission for a subscriber in HKD/HTD */
export function permittedOrderTypes(subscriber: { protocolDownloadsAllowed: boolean; signatureClass: SignatureClass }): OrderTypeInfo[] {
  return SUPPORTED_ORDER_TYPES.filter(
    (ot) =>
      (subscriber.protocolDownloadsAllowed || !PROTOCOL_ORDER_TYPES.includes(ot.adminType)) &&
      (subscriber.signatureClass !== 'T' || !SIGNING_ORDER_TYPES.includes(ot.adminType)),
  );
}
