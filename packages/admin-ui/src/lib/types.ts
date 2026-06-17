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
