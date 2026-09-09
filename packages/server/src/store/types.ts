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

export interface Subscriber {
  partnerId: string;
  userId: string;
  state: SubscriberState;
  keys: SubscriberKeys;
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
  createdAt: string;
}

export interface DownloadData {
  id: number;
  serviceName: string;
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

  upsertDownloadData(serviceName: string, msgName: string | undefined, content: string, contentType: string): void;
  getDownloadData(serviceName: string, msgName?: string): DownloadData | undefined;
  listDownloadData(): DownloadData[];

  createUploadedOrder(data: Omit<UploadedOrder, 'id' | 'processed' | 'createdAt'>): UploadedOrder;
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

  createBooking(data: Omit<Booking, 'id' | 'createdAt'>): Booking;
  listBookingsForAccount(accountId: number, fromDate?: string, toDate?: string): Booking[];
  deleteBooking(id: number): void;
  getOpeningBalanceCents(accountId: number, beforeDate: string): number;

  getNextAccountSequence(): number;
}

export type AppStore = EbicsStore & BankingStore;
