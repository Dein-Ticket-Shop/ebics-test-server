import type { EventEmitter } from 'node:events';

export enum SubscriberState {
  NEW = 'NEW',
  PARTIALLY_INITIALIZED_INI = 'PARTIALLY_INITIALIZED_INI',
  PARTIALLY_INITIALIZED_HIA = 'PARTIALLY_INITIALIZED_HIA',
  INITIALIZED = 'INITIALIZED',
  READY = 'READY',
  SUSPENDED = 'SUSPENDED',
}

export interface SubscriberKeys {
  signatureVersion?: string;
  signatureCertificate?: string;

  authenticationVersion?: string;
  authenticationCertificate?: string;

  encryptionVersion?: string;
  encryptionCertificate?: string;
}

/** EBICS signature class: E single, A first, B second signature; T transport signature (cannot authorise orders) */
export type SignatureClass = 'E' | 'A' | 'B' | 'T';

export interface Subscriber {
  partnerId: string;
  userId: string;
  state: SubscriberState;
  keys: SubscriberKeys;
  /** May download the customer protocol (HAC, PTK); otherwise 090003. Set per subscriber in the admin API/UI. */
  protocolDownloadsAllowed: boolean;
  /** Class of this user's electronic signatures; decides whether uploads execute, wait in the VEU or are rejected */
  signatureClass: SignatureClass;
  createdAt: string;
  updatedAt: string;
}

export interface BankKeys {
  authenticationPrivateKey: string;
  authenticationCertificate: string;
  authenticationVersion: string;

  encryptionPrivateKey: string;
  encryptionCertificate: string;
  encryptionVersion: string;
}

export interface HostConfig {
  hostId: string;
  bankKeys: BankKeys;
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

export type TransactionPhase = 'Initialisation' | 'Transfer' | 'Receipt';

export interface Transaction {
  transactionId: string;
  partnerId: string;
  userId: string;
  hostId: string;
  direction: 'upload' | 'download';
  phase: TransactionPhase;
  orderType: string;
  numSegments: number;
  currentSegment: number;
  segments: string[];
  transactionKey: string;
  encKeyDigest: string;
  signatureData?: string;
  serviceName?: string;
  msgName?: string;
  /** EBICS OrderID allocated for uploads (returned in the upload responses) */
  orderId?: string;
  serviceOption?: string;
  /** BTUOrderParams/SignatureFlag is present: the upload is authorised within EBICS */
  signatureFlag?: boolean;
  /** BTUOrderParams/SignatureFlag/@requestEDS of an upload */
  requestEds?: boolean;
  /** Download items handed out by this transaction, marked delivered on a positive receipt */
  deliveryKind?: DeliveryKind;
  deliveryKeys?: string[];
  /** SystemID of the technical subscriber that sent the request (EBICS 3.0.2 chapter 3.7) */
  systemId?: string;
  createdAt: string;
  expiresAt: string;
}

export interface UploadedOrder {
  id: number;
  partnerId: string;
  userId: string;
  serviceName: string;
  msgName?: string;
  rawContent: string;
  processed: boolean;
  orderId?: string;
  createdAt: string;
}

export interface DownloadData {
  id: number;
  serviceName: string;
  /** Only served for this ServiceOption; undefined matches requests with any option */
  serviceOption?: string;
  msgName?: string;
  content: string;
  contentType: string;
  createdAt: string;
}

export interface EbicsStore {
  getHostConfig(): HostConfig | undefined;
  setHostConfig(config: HostConfig): void;

  createSubscriber(partnerId: string, userId: string): Subscriber;
  getSubscriber(partnerId: string, userId: string): Subscriber | undefined;
  listSubscribers(): Subscriber[];
  updateSubscriberState(partnerId: string, userId: string, state: SubscriberState): void;
  updateSubscriberKeys(partnerId: string, userId: string, keys: Partial<SubscriberKeys>): void;
  updateSubscriberSettings(
    partnerId: string,
    userId: string,
    settings: Partial<Pick<Subscriber, 'protocolDownloadsAllowed' | 'signatureClass'>>,
  ): void;
  deleteSubscriber(partnerId: string, userId: string): void;

  storeNonce(nonce: string, timestamp: string): void;
  hasNonce(nonce: string): boolean;
  cleanExpiredNonces(): void;

  logActivity(entry: Omit<ActivityLogEntry, 'id' | 'createdAt'>): void;
  getActivityLog(limit?: number, offset?: number): ActivityLogEntry[];

  logProtocol(entry: Omit<ProtocolLogEntry, 'id' | 'createdAt'>): ProtocolLogEntry;
  getProtocolLog(limit?: number, offset?: number): ProtocolLogEntry[];
  getProtocolLogEntry(id: number): ProtocolLogEntry | undefined;

  createTransaction(tx: Omit<Transaction, 'createdAt' | 'expiresAt'>): Transaction;
  getTransaction(transactionId: string): Transaction | undefined;
  updateTransactionPhase(transactionId: string, phase: TransactionPhase): void;
  updateTransactionSegment(transactionId: string, currentSegment: number): void;
  deleteTransaction(transactionId: string): void;
  cleanExpiredTransactions(): void;

  appendUploadSegment(transactionId: string, segment: string): void;

  upsertDownloadData(serviceName: string, msgName: string | undefined, content: string, contentType: string, serviceOption?: string): void;
  getDownloadData(serviceName: string, msgName?: string, serviceOption?: string): DownloadData | undefined;
  listDownloadData(): DownloadData[];
  deleteDownloadData(id: number): void;

  createUploadedOrder(data: Omit<UploadedOrder, 'id' | 'processed' | 'createdAt' | 'orderId'> & { orderId?: string }): UploadedOrder;
  listUploadedOrders(): UploadedOrder[];
  getUploadedOrder(id: number): UploadedOrder | undefined;
  markUploadedOrderProcessed(id: number): void;

  reset(): void;
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
  sourcePainId?: number;
  createdAt: string;
}

export interface BankingStore {
  getBankConfig(): BankConfig | undefined;
  setBankConfig(config: BankConfig): void;

  createPerson(data: Omit<Person, 'id' | 'createdAt'>): Person;
  getPerson(id: number): Person | undefined;
  getPersonByExternalId(externalId: string): Person | undefined;
  listPersons(): Person[];
  updatePerson(id: number, patch: Partial<Omit<Person, 'id' | 'createdAt'>>): Person | undefined;
  deletePerson(id: number): void;

  createAccount(data: Omit<Account, 'id' | 'currentBalanceCents' | 'createdAt'>): Account;
  getAccount(id: number): Account | undefined;
  getAccountByIban(iban: string): Account | undefined;
  listAccounts(): Account[];
  listAccountsForPerson(personId: number): Account[];
  listAccountsForPartner(partnerId: string): Account[];
  updateAccount(id: number, patch: { name?: string; currency?: string }): Account | undefined;
  deleteAccount(id: number): void;

  partnerHasAccountAccess(partnerId: string, accountId: number): boolean;
  grantAccountAccess(partnerId: string, accountId: number): void;
  revokeAccountAccess(partnerId: string, accountId: number): void;

  /** Minimum number of bank-technical signatures for the customer and BTF service: the service rule, the customer rule or 1 */
  getMinimumSignatures(partnerId: string, serviceName?: string): MinimumSignatures;
  getMinimumSignatureRules(partnerId: string): MinimumSignatureRules;
  /** Sets the customer rule, or the rule of one BTF service; null removes it */
  setMinimumSignatures(partnerId: string, minimumSignatures: MinimumSignatures | null, serviceName?: string): void;

  /** Agreements of the customer; both agreed unless changed */
  getCustomerAgreements(partnerId: string): CustomerAgreements;
  updateCustomerAgreements(partnerId: string, patch: Partial<Pick<CustomerAgreements, 'veu' | 'signingOutsideEbics'>>): CustomerAgreements;

  createBooking(data: Omit<Booking, 'id' | 'createdAt'>): Booking;
  listBookingsForAccount(accountId: number, fromDate?: string, toDate?: string): Booking[];
  deleteBooking(id: number): void;
  getOpeningBalanceCents(accountId: number, beforeDate: string): number;

  getNextAccountSequence(): number;
}

// Order lifecycle: EBICS order IDs, HAC event ledger, credit transfer orders, download deliveries

import type { VopStatus } from '../config/feature-flags.js';
export type { VopStatus };

/** HAC action types (EBICS 3.0 Annex, customer acknowledgement) */
export type HacAction =
  | 'FILE_UPLOAD'
  | 'FILE_DOWNLOAD'
  | 'ES_UPLOAD'
  | 'ES_DOWNLOAD'
  | 'ES_VERIFICATION'
  | 'VEU_FORWARDING'
  | 'VEU_VERIFICATION'
  | 'VEU_VERIFICATION_END'
  | 'VEU_CANCEL_ORDER'
  | 'ADDITIONAL'
  | 'ORDER_HAC_FINAL_POS'
  | 'ORDER_HAC_FINAL_NEG';

export interface HacEvent {
  id: number;
  partnerId: string;
  /** Omitted for FINAL_* events, like real banks do */
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
  /** ISO timestamp with milliseconds; strictly increasing per partner so clients can use it as idempotency key */
  eventAt: string;
  uploadedOrderId?: number;
}

export type NewHacEvent = Omit<HacEvent, 'id' | 'eventAt' | 'additionalInfo'> & {
  eventAt?: string;
  additionalInfo?: string[];
};

export type PaymentOrderStatus = 'PENDING_EDS' | 'EXECUTED' | 'CANCELLED' | 'REJECTED';
export type PaymentStatusCode = 'ACTC' | 'ACCP' | 'ACSP' | 'ACSC' | 'ACWC' | 'RJCT';

/** One pain.001 PmtInf (Sammler) received in an upload */
export interface PaymentOrder {
  id: number;
  orderId: string;
  uploadedOrderId?: number;
  partnerId: string;
  userId: string;
  serviceName: string;
  serviceOption?: string;
  msgName: string;
  /** GrpHdr/MsgId of the pain.001 file */
  msgId: string;
  /** PmtInf/PmtInfId (Sammlerreferenz) */
  pmtInfId: string;
  debtorName?: string;
  debtorIban?: string;
  requestedEds: boolean;
  /** Held until an electronic signature (HVE) confirms a VoP result other than RCVC */
  vopConfirmationRequired: boolean;
  status: PaymentOrderStatus;
  createdAt: string;
  updatedAt: string;
}

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

/** A pain.008 direct debit upload waiting in the VEU; its direct debits are booked when it is released */
export interface DirectDebitOrder {
  id: number;
  orderId: string;
  uploadedOrderId: number;
  partnerId: string;
  userId: string;
  serviceName: string;
  serviceOption?: string;
  msgName: string;
  status: PaymentOrderStatus;
  createdAt: string;
  updatedAt: string;
}

export type NewPaymentOrder = Omit<PaymentOrder, 'id' | 'createdAt' | 'updatedAt' | 'vopConfirmationRequired'> &
  Partial<Pick<PaymentOrder, 'vopConfirmationRequired'>>;
export type NewPaymentTransaction = Omit<PaymentTransaction, 'id' | 'paymentOrderId'>;

/** Download services that hand out each item once when no DateRange is requested */
export type DeliveryKind = 'camt.054' | 'psr' | 'vop' | 'hac' | 'ptk';

export type OrderSignatureKind = 'UPLOAD' | 'HVE';

/** Electronic signature on an EBICS order (VEU) */
/**
 * Minimum number of bank-technical signatures agreed between bank and customer (EBICS 3.0.2 chapter 3.5), one of the
 * authorisation schemes of chapter 11.2.3
 */
export type MinimumSignatures = 1 | 2;

export interface MinimumSignatureRules {
  partnerId: string;
  /** Rule of the customer for every service without its own rule (default 1) */
  minimumSignatures: MinimumSignatures;
  /** Rules per BTF ServiceName, e.g. { SCI: 2 } */
  services: Record<string, MinimumSignatures>;
}

/** Contractual agreements of a customer that decide how uploads are authorised (EBICS 3.0.2 chapter 3.14) */
export interface CustomerAgreements {
  partnerId: string;
  /** VEU agreement: uploads requesting EDS whose signatures do not authorise them wait in the VEU, otherwise 091007 */
  veu: boolean;
  /** Orders without SignatureFlag are authorised outside EBICS (e.g. accompanying note), otherwise 090003 */
  signingOutsideEbics: boolean;
}

export interface OrderSignature {
  id: number;
  partnerId: string;
  orderId: string;
  userId: string;
  kind: OrderSignatureKind;
  /** Class the signature counts as: the signer's class when signing, T for uploads without SignatureFlag */
  signatureClass: SignatureClass;
  signedAt: string;
}

export interface DateFilter {
  /** inclusive, YYYY-MM-DD */
  from?: string;
  /** inclusive, YYYY-MM-DD */
  to?: string;
}

export interface OrderLedgerStore {
  nextOrderId(partnerId: string): string;

  appendHacEvent(event: NewHacEvent): HacEvent;
  getHacEvent(id: number): HacEvent | undefined;
  listHacEvents(filter?: { partnerId?: string; orderId?: string } & DateFilter): HacEvent[];

  createPaymentOrder(order: NewPaymentOrder, transactions: NewPaymentTransaction[]): PaymentOrder;
  getPaymentOrder(id: number): PaymentOrder | undefined;
  listPaymentOrders(filter?: { partnerId?: string; status?: PaymentOrderStatus; orderId?: string; msgId?: string }): PaymentOrder[];
  updatePaymentOrderStatus(id: number, status: PaymentOrderStatus): void;

  /** Holds a pain.008 upload in the VEU with status PENDING_EDS */
  createDirectDebitOrder(order: Omit<DirectDebitOrder, 'id' | 'status' | 'createdAt' | 'updatedAt'>): DirectDebitOrder;
  getDirectDebitOrder(id: number): DirectDebitOrder | undefined;
  /** Oldest first */
  listDirectDebitOrders(filter?: { partnerId?: string; orderId?: string; status?: PaymentOrderStatus }): DirectDebitOrder[];
  updateDirectDebitOrderStatus(id: number, status: PaymentOrderStatus): void;
  listPaymentTransactions(paymentOrderId: number): PaymentTransaction[];
  getPaymentTransaction(id: number): PaymentTransaction | undefined;
  updatePaymentTransaction(
    id: number,
    patch: Partial<Pick<PaymentTransaction, 'vopStatus' | 'vopCorrectedName' | 'debitBookingId' | 'creditBookingId'>>,
  ): void;
  appendPaymentStatusEvent(event: {
    paymentOrderId: number;
    status: PaymentStatusCode;
    reasonCode?: string;
    additionalInfo?: string[];
  }): PaymentStatusEvent;
  listPaymentStatusEvents(filter?: { paymentOrderId?: number; partnerId?: string } & DateFilter): PaymentStatusEvent[];

  addOrderSignature(signature: {
    partnerId: string;
    orderId: string;
    userId: string;
    kind: OrderSignatureKind;
    signatureClass: SignatureClass;
  }): OrderSignature;
  listOrderSignatures(partnerId: string, orderId: string): OrderSignature[];

  /** Emits 'booking' (Booking), 'paymentOrder' (PaymentOrder), 'paymentStatus' (PaymentStatusEvent), 'hacEvent' (HacEvent) */
  readonly events: EventEmitter;

  markDelivered(partnerId: string, kind: DeliveryKind, itemKeys: string[]): void;
  listDeliveredKeys(partnerId: string, kind: DeliveryKind): Set<string>;
  resetDeliveries(filter?: { partnerId?: string; kind?: DeliveryKind }): number;
}

export type AppStore = EbicsStore & BankingStore & OrderLedgerStore;
