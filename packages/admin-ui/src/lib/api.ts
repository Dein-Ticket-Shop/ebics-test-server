import type { Subscriber, HostConfig, Stats, ActivityLogEntry, ProtocolLogSummary, ProtocolLogEntry, BankConfig, Person, Account, Booking } from './types.js';

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
export const deletePerson = (id: number) =>
  json<{ status: string }>(`${BANK}/persons/${id}`, { method: 'DELETE' });

export const listAccounts = () => json<Account[]>(`${BANK}/accounts`);
export const getAccount = (id: number) => json<Account>(`${BANK}/accounts/${id}`);
export const listAccountsForPerson = (personId: number) =>
  json<Account[]>(`${BANK}/persons/${personId}/accounts`);
export const createAccount = (data: { personId: number; name: string; currency?: string }) =>
  json<Account>(`${BANK}/accounts`, { method: 'POST', body: JSON.stringify(data) });

export const listAccountsForPartner = (partnerId: string) =>
  json<Account[]>(`${BANK}/partners/${encodeURIComponent(partnerId)}/accounts`);
export const grantAccountAccess = (partnerId: string, accountId: number) =>
  json<{ status: string }>(`${BANK}/partners/${encodeURIComponent(partnerId)}/accounts/${accountId}`, { method: 'POST' });
export const revokeAccountAccess = (partnerId: string, accountId: number) =>
  json<{ status: string }>(`${BANK}/partners/${encodeURIComponent(partnerId)}/accounts/${accountId}`, { method: 'DELETE' });

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

export const getStatementUrl = (accountId: number, format: 'camt.053' | 'mt940', from?: string, to?: string) => {
  const params = new URLSearchParams({ format });
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return `${BANK}/accounts/${accountId}/statement?${params}`;
};

export const seedDemo = () =>
  json<{ bank: BankConfig; persons: Person[]; accounts: Account[]; bookingCount: number }>(`${BANK}/seed/demo`, { method: 'POST' });
