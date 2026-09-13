import type {
  Subscriber,
  HostConfig,
  Stats,
  ActivityLogEntry,
  ProtocolLogSummary,
  ProtocolLogEntry,
  BankConfig,
  Person,
  Account,
  Booking,
  ServerFlags,
  EnvFlag,
  PaymentOrder,
  PaymentOrderStatus,
  PaymentStatusCode,
  VopStatus,
  HacEvent,
  HacEventInput,
  DeliveryKind,
  VeuOrder,
  WssParameters,
  RealtimeConnection,
  KeptRealtimeMessages,
  MinimumSignatureRules,
  BtfNotification,
  DownloadData,
} from './types.js';

const API = '/api';

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export const getHost = () => json<HostConfig>(`${API}/host`);
export const configureHost = (hostId: string) =>
  json<{ hostId: string; status: string }>(`${API}/host`, {
    method: 'POST',
    body: JSON.stringify({ hostId }),
  });

export const getStats = () => json<Stats>(`${API}/stats`);

export const listSubscribers = () => json<Subscriber[]>(`${API}/subscribers`);
export const getSubscriber = (partnerId: string, userId: string) =>
  json<Subscriber>(`${API}/subscribers/${encodeURIComponent(partnerId)}/${encodeURIComponent(userId)}`);
export const createSubscriber = (partnerId: string, userId: string) =>
  json<Subscriber>(`${API}/subscribers`, {
    method: 'POST',
    body: JSON.stringify({ partnerId, userId }),
  });
export const activateSubscriber = (partnerId: string, userId: string) =>
  json<Subscriber>(`${API}/subscribers/${encodeURIComponent(partnerId)}/${encodeURIComponent(userId)}/activate`, {
    method: 'POST',
  });
export const suspendSubscriber = (partnerId: string, userId: string) =>
  json<Subscriber>(`${API}/subscribers/${encodeURIComponent(partnerId)}/${encodeURIComponent(userId)}/suspend`, {
    method: 'POST',
  });
export const reactivateSubscriber = (partnerId: string, userId: string) =>
  json<Subscriber>(`${API}/subscribers/${encodeURIComponent(partnerId)}/${encodeURIComponent(userId)}/reactivate`, {
    method: 'POST',
  });
export const updateSubscriber = (
  partnerId: string,
  userId: string,
  patch: Partial<Pick<Subscriber, 'protocolDownloadsAllowed' | 'signatureClass'>>,
) =>
  json<Subscriber>(`${API}/subscribers/${encodeURIComponent(partnerId)}/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
export const deleteSubscriber = (partnerId: string, userId: string) =>
  json<{ status: string }>(`${API}/subscribers/${encodeURIComponent(partnerId)}/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  });

export const getActivity = (limit = 50, offset = 0) =>
  json<ActivityLogEntry[]>(`${API}/activity?limit=${limit}&offset=${offset}`);

export const getProtocolLog = (limit = 50, offset = 0) =>
  json<ProtocolLogSummary[]>(`${API}/protocol-log?limit=${limit}&offset=${offset}`);
export const getProtocolLogEntry = (id: number) =>
  json<ProtocolLogEntry>(`${API}/protocol-log/${id}`);

export const resetStore = () =>
  json<{ status: string }>(`${API}/reset`, { method: 'POST' });

// Banking API

const BANK = `${API}/banking`;

export const getBankConfig = () => json<BankConfig>(`${BANK}/bank`);
export const setBankConfig = (config: BankConfig) =>
  json<BankConfig>(`${BANK}/bank`, { method: 'POST', body: JSON.stringify(config) });

export const listPersons = () => json<Person[]>(`${BANK}/persons`);
export const getPerson = (id: number) => json<Person>(`${BANK}/persons/${id}`);
export const createPerson = (data: Omit<Person, 'id' | 'createdAt'>) =>
  json<Person>(`${BANK}/persons`, { method: 'POST', body: JSON.stringify(data) });
export const updatePerson = (id: number, patch: Partial<Omit<Person, 'id' | 'createdAt'>>) =>
  json<Person>(`${BANK}/persons/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
export const deletePerson = (id: number) =>
  json<{ status: string }>(`${BANK}/persons/${id}`, { method: 'DELETE' });

export const listAccounts = () => json<Account[]>(`${BANK}/accounts`);
export const getAccount = (id: number) => json<Account>(`${BANK}/accounts/${id}`);
export const listAccountsForPerson = (personId: number) =>
  json<Account[]>(`${BANK}/persons/${personId}/accounts`);
export const createAccount = (data: { personId: number; name: string; currency?: string; accountNumber?: string }) =>
  json<Account>(`${BANK}/accounts`, { method: 'POST', body: JSON.stringify(data) });
export const updateAccount = (id: number, patch: { name?: string; currency?: string }) =>
  json<Account>(`${BANK}/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
export const deleteAccount = (id: number) =>
  json<{ status: string }>(`${BANK}/accounts/${id}`, { method: 'DELETE' });

export const listAccountsForPartner = (partnerId: string) =>
  json<Account[]>(`${BANK}/partners/${encodeURIComponent(partnerId)}/accounts`);
export const grantAccountAccess = (partnerId: string, accountId: number) =>
  json<{ status: string }>(`${BANK}/partners/${encodeURIComponent(partnerId)}/accounts/${accountId}`, { method: 'POST' });
export const revokeAccountAccess = (partnerId: string, accountId: number) =>
  json<{ status: string }>(`${BANK}/partners/${encodeURIComponent(partnerId)}/accounts/${accountId}`, { method: 'DELETE' });
export const getMinimumSignatureRules = (partnerId: string) =>
  json<MinimumSignatureRules>(`${BANK}/partners/${encodeURIComponent(partnerId)}/minimum-signatures`);
/** Sets the customer rule, or the rule of one BTF service; null removes it */
export const setMinimumSignatures = (partnerId: string, data: { minimumSignatures: 1 | 2 | null; serviceName?: string }) =>
  json<MinimumSignatureRules>(`${BANK}/partners/${encodeURIComponent(partnerId)}/minimum-signatures`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });

export const listBookings = (accountId: number, from?: string, to?: string) => {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const qs = params.toString();
  return json<Booking[]>(`${BANK}/accounts/${accountId}/bookings${qs ? `?${qs}` : ''}`);
};
export const createBooking = (accountId: number, data: {
  amountCents: number;
  valueDate: string;
  bookingDate?: string;
  counterpartyName?: string;
  counterpartyIban?: string;
  counterpartyBic?: string;
  remittanceInfo?: string;
  endToEndId?: string;
  transactionCode?: string;
  currency?: string;
}) => json<Booking>(`${BANK}/accounts/${accountId}/bookings`, { method: 'POST', body: JSON.stringify(data) });
export const deleteBooking = (accountId: number, bookingId: number) =>
  json<{ status: string }>(`${BANK}/accounts/${accountId}/bookings/${bookingId}`, { method: 'DELETE' });

export type StatementFormat = 'camt.052' | 'camt.053' | 'camt.054' | 'mt940';

export const getStatementUrl = (accountId: number, format: StatementFormat, from?: string, to?: string) => {
  const params = new URLSearchParams({ format });
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return `${BANK}/accounts/${accountId}/statement?${params}`;
};

export const seedDemo = () =>
  json<{ bank: BankConfig; persons: Person[]; accounts: Account[]; bookingCount: number }>(`${BANK}/seed/demo`, { method: 'POST' });

// Server flags

export const getServerFlags = () => json<ServerFlags>(`${API}/config/flags`);
export const getEnvFlags = () => json<EnvFlag[]>(`${API}/config/env-flags`);

// Payment orders

export const listPayments = (filter: { partnerId?: string; status?: PaymentOrderStatus } = {}) => {
  const params = new URLSearchParams();
  if (filter.partnerId) params.set('partnerId', filter.partnerId);
  if (filter.status) params.set('status', filter.status);
  const qs = params.toString();
  return json<PaymentOrder[]>(`${API}/payments${qs ? `?${qs}` : ''}`);
};
export const getPayment = (id: number) => json<PaymentOrder>(`${API}/payments/${id}`);
export const releasePayment = (id: number) =>
  json<PaymentOrder>(`${API}/payments/${id}/release`, { method: 'POST' });
export const cancelPayment = (id: number, data: { additionalInfo?: string[] } = {}) =>
  json<PaymentOrder>(`${API}/payments/${id}/cancel`, { method: 'POST', body: JSON.stringify(data) });
export const rejectPayment = (id: number, data: { reasonCode?: string; additionalInfo?: string[] } = {}) =>
  json<PaymentOrder>(`${API}/payments/${id}/reject`, { method: 'POST', body: JSON.stringify(data) });
export const addPaymentStatusEvent = (
  id: number,
  data: { status: PaymentStatusCode; reasonCode?: string; additionalInfo?: string[] },
) => json<PaymentOrder>(`${API}/payments/${id}/status-events`, { method: 'POST', body: JSON.stringify(data) });
export const overrideTransactionVop = (
  id: number,
  txId: number,
  data: { status: VopStatus; correctedName?: string },
) => json<PaymentOrder>(`${API}/payments/${id}/transactions/${txId}/vop`, { method: 'PATCH', body: JSON.stringify(data) });
export const getPaymentStatusReportUrl = (id: number) => `${API}/payments/${id}/status-report`;
export const getPaymentVopReportUrl = (id: number) => `${API}/payments/${id}/vop-report`;

// Customer protocol (HAC)

export const listHacEvents = (filter: { partnerId?: string; orderId?: string } = {}) => {
  const params = new URLSearchParams();
  if (filter.partnerId) params.set('partnerId', filter.partnerId);
  if (filter.orderId) params.set('orderId', filter.orderId);
  const qs = params.toString();
  return json<HacEvent[]>(`${API}/hac-events${qs ? `?${qs}` : ''}`);
};
export const createHacEvent = (data: HacEventInput) =>
  json<HacEvent>(`${API}/hac-events`, { method: 'POST', body: JSON.stringify(data) });
export const getHacReportUrl = (partnerId: string) => `${API}/hac/report?partnerId=${encodeURIComponent(partnerId)}`;

// Download delivery state

export const resetDeliveries = (data: { partnerId?: string; kind?: DeliveryKind } = {}) =>
  json<{ reset: number }>(`${API}/deliveries/reset`, { method: 'POST', body: JSON.stringify(data) });

// VEU (bank-side signing and cancellation)

const enc = encodeURIComponent;

export const listVeuOrders = (partnerId?: string) =>
  json<VeuOrder[]>(`${API}/veu/orders${partnerId ? `?partnerId=${enc(partnerId)}` : ''}`);
export const getVeuOrder = (partnerId: string, orderId: string) =>
  json<VeuOrder>(`${API}/veu/orders/${enc(partnerId)}/${enc(orderId)}`);
export const signVeuOrder = (partnerId: string, orderId: string, userId: string) =>
  json<{ orderId: string; released: boolean; order: VeuOrder | null }>(`${API}/veu/orders/${enc(partnerId)}/${enc(orderId)}/sign`, {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
export const cancelVeuOrder = (partnerId: string, orderId: string, data: { userId: string; additionalInfo?: string[] }) =>
  json<{ orderId: string }>(`${API}/veu/orders/${enc(partnerId)}/${enc(orderId)}/cancel`, {
    method: 'POST',
    body: JSON.stringify(data),
  });

// Real-time notifications

export const listRealtimeConnections = () => json<RealtimeConnection[]>(`${API}/realtime/connections`);
export const listKeptRealtimeMessages = () => json<KeptRealtimeMessages[]>(`${API}/realtime/kept-messages`);
export const issueRealtimeToken = (data: { partnerId: string; userId?: string }) =>
  json<WssParameters>(`${API}/realtime/tokens`, { method: 'POST', body: JSON.stringify(data) });
export const notifyRealtime = (data: { partnerId: string; userId?: string; btf?: BtfNotification[]; orderTypes?: string[] }) =>
  json<{ sent: number; kept?: number }>(`${API}/realtime/notify`, { method: 'POST', body: JSON.stringify(data) });
export const broadcastRealtimeInfo = (data: { text: string; lang?: string }) =>
  json<{ sent: number; kept?: number }>(`${API}/realtime/info`, { method: 'POST', body: JSON.stringify(data) });

// Seeded download data

export const listDownloadData = () => json<DownloadData[]>(`${API}/download-data`);
export const upsertDownloadData = (data: {
  serviceName: string;
  serviceOption?: string;
  msgName?: string;
  content: string;
  contentType?: 'text' | 'base64';
}) => json<{ status: string; serviceName: string }>(`${API}/download-data`, { method: 'POST', body: JSON.stringify(data) });
export const deleteDownloadData = (id: number) =>
  json<{ status: string }>(`${API}/download-data/${id}`, { method: 'DELETE' });

// Customer protocol as text (PTK)

export const getPtkReportUrl = (partnerId: string) => `${API}/ptk/report?partnerId=${enc(partnerId)}`;
