export type SubscriberState =
  | 'NEW'
  | 'PARTIALLY_INITIALIZED_INI'
  | 'PARTIALLY_INITIALIZED_HIA'
  | 'INITIALIZED'
  | 'READY'
  | 'SUSPENDED';

export interface SubscriberKeys {
  signatureVersion?: string;
  signatureCertificate?: string;
  authenticationVersion?: string;
  authenticationCertificate?: string;
  encryptionVersion?: string;
  encryptionCertificate?: string;
}

export interface Subscriber {
  partnerId: string;
  userId: string;
  state: SubscriberState;
  keys: SubscriberKeys;
  /** May download the customer protocol (HAC, PTK); otherwise 090003 */
  protocolDownloadsAllowed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BankKeysPublic {
  authenticationVersion: string;
  authenticationCertificate: string;
  encryptionVersion: string;
  encryptionCertificate: string;
}

export interface HostConfig {
  hostId: string;
  bankKeys: BankKeysPublic;
}

export interface Stats {
  total: number;
  byState: Record<SubscriberState, number>;
  hostConfigured: boolean;
}

export interface ActivityLogEntry {
  id: number;
  eventType: string;
  partnerId?: string;
  userId?: string;
  orderType?: string;
  resultCode?: string;
  details?: Record<string, unknown>;
  createdAt: string;
}

export interface ProtocolLogSummary {
  id: number;
  rootElement?: string;
  orderType?: string;
  partnerId?: string;
  userId?: string;
  transactionId?: string;
  transactionPhase?: string;
  returnCode?: string;
  requestSize: number;
  responseSize: number;
  durationMs?: number;
  createdAt: string;
}

export interface ProtocolLogEntry {
  id: number;
  rootElement?: string;
  orderType?: string;
  partnerId?: string;
  userId?: string;
  transactionId?: string;
  transactionPhase?: string;
  returnCode?: string;
  requestXml: string;
  responseXml: string;
  durationMs?: number;
  createdAt: string;
}

// Banking simulation types

export interface BankConfig {
  blz: string;
  name: string;
  bic: string;
}

export interface Person {
  id: number;
  externalId?: string;
  name: string;
  addressLine1?: string;
  addressLine2?: string;
  country: string;
  createdAt: string;
}

export interface Account {
  id: number;
  personId: number;
  iban: string;
  accountNumber: string;
  currency: string;
  name: string;
  currentBalanceCents: number;
  createdAt: string;
}

export interface Booking {
  id: number;
  accountId: number;
  amountCents: number;
  currency: string;
  valueDate: string;
  bookingDate: string;
  counterpartyName?: string;
  counterpartyIban?: string;
  counterpartyBic?: string;
  remittanceInfo?: string;
  endToEndId?: string;
  transactionCode: string;
  createdAt: string;
}

// Payment orders (pain.001 uploads, VEU / EDS hold)

export type PaymentOrderStatus = 'PENDING_EDS' | 'EXECUTED' | 'CANCELLED' | 'REJECTED';
export type PaymentStatusCode = 'ACTC' | 'ACCP' | 'ACSP' | 'ACSC' | 'ACWC' | 'RJCT';
/** Verification of Payee result: match, close match, no match, not applicable */
export type VopStatus = 'RCVC' | 'RVMC' | 'RVNM' | 'RVNA';

export interface PaymentTransaction {
  id: number;
  paymentOrderId: number;
  endToEndId?: string;
  creditorName?: string;
  creditorIban?: string;
  creditorBic?: string;
  amountCents: number;
  currency: string;
  remittanceInfo?: string;
  vopStatus: VopStatus;
  vopCorrectedName?: string;
  debitBookingId?: number;
  creditBookingId?: number;
}

export interface PaymentStatusEvent {
  id: number;
  paymentOrderId: number;
  status: PaymentStatusCode;
  reasonCode?: string;
  additionalInfo: string[];
  createdAt: string;
}

export interface PaymentOrder {
  id: number;
  orderId: string;
  uploadedOrderId?: number;
  partnerId: string;
  userId: string;
  serviceName: string;
  serviceOption?: string;
  msgName: string;
  msgId: string;
  pmtInfId: string;
  debtorName?: string;
  debtorIban?: string;
  requestedEds: boolean;
  /** Distinct users whose signatures release the order (2 with EDS hold, else 1) */
  signaturesRequired: number;
  /** Held until a signature confirms a VoP result other than RCVC */
  vopConfirmationRequired: boolean;
  status: PaymentOrderStatus;
  vopGroupStatus: VopStatus;
  totalCents: number;
  createdAt: string;
  updatedAt: string;
  transactions: PaymentTransaction[];
  /** ascending */
  statusEvents: PaymentStatusEvent[];
}

// Customer protocol (HAC event ledger)

export type HacAction =
  | 'FILE_UPLOAD'
  | 'FILE_DOWNLOAD'
  | 'ES_VERIFICATION'
  | 'VEU_FORWARDING'
  | 'VEU_VERIFICATION_END'
  | 'VEU_CANCEL_ORDER'
  | 'ADDITIONAL'
  | 'ORDER_HAC_FINAL_POS'
  | 'ORDER_HAC_FINAL_NEG';

export interface HacEvent {
  id: number;
  partnerId: string;
  userId?: string;
  orderId: string;
  action: string;
  adminOrderType: string;
  serviceName?: string;
  serviceOption?: string;
  scope?: string;
  containerType?: string;
  msgName?: string;
  orderIdRef?: string;
  adminOrderTypeRef?: string;
  reasonCode?: string;
  additionalInfo: string[];
  eventAt: string;
  delivered: boolean;
}

export interface HacEventInput {
  partnerId: string;
  userId?: string;
  /** allocated by the server when omitted */
  orderId?: string;
  action: string;
  adminOrderType: string;
  serviceName?: string;
  serviceOption?: string;
  scope?: string;
  containerType?: string;
  msgName?: string;
  orderIdRef?: string;
  adminOrderTypeRef?: string;
  reasonCode?: string;
  additionalInfo?: string[];
}

export type DeliveryKind = 'camt.054' | 'psr' | 'vop' | 'hac' | 'ptk';

export interface ServerFlags {
  hacFormat: 'legacy' | 'pain.002';
  edsHold: boolean;
  vopDefault: VopStatus;
  strictValidation: boolean;
  allowPreActivation: boolean;
  hacDownloadEvents: boolean;
  vopConfirmation: boolean;
  wssOneTimeTokens: boolean;
}

// VEU (distributed electronic signature)

export interface OrderSignature {
  id: number;
  partnerId: string;
  orderId: string;
  userId: string;
  kind: 'UPLOAD' | 'HVE';
  signedAt: string;
}

export interface VeuOrder {
  partnerId: string;
  orderId: string;
  paymentOrderIds: number[];
  serviceName: string;
  serviceOption?: string;
  msgName: string;
  msgId: string;
  originatorUserId: string;
  createdAt: string;
  debtorName?: string;
  debtorIban?: string;
  totalCents: number;
  currency: string;
  vopGroupStatus: VopStatus;
  transactions: PaymentTransaction[];
  signatures: OrderSignature[];
  /** distinct signing users */
  signaturesDone: number;
  /** distinct users needed */
  signaturesRequired: number;
  /** what HVZ reports (one more while a VoP confirmation is pending) */
  numSigRequired: number;
  vopConfirmationRequired: boolean;
  vopConfirmed: boolean;
  releasable: boolean;
  dataDigest: string;
}

// Real-time notifications

export interface WssParameters {
  URL: string;
  TOKEN: string;
  /** Y = one-time token, N = reusable until VALIDITY */
  OTT: 'Y' | 'N';
  VALIDITY: string;
  PARTNERID: string;
  USERID?: string;
}

export interface RealtimeConnection {
  id: string;
  partnerId: string;
  userId?: string;
  connectedAt: string;
}

export interface BtfNotification {
  SERVICE: string;
  SCOPE?: string;
  OPTION?: string;
  CONTTYPE?: string;
  MSGNAME: string;
}

// Seeded download data

export interface DownloadData {
  id: number;
  serviceName: string;
  serviceOption?: string;
  msgName?: string;
  content: string;
  contentType: string;
  /** SQLite datetime without zone (UTC) */
  createdAt: string;
}
