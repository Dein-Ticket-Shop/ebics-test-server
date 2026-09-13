import { getStats, getActivity, getHost, getBankConfig, listPersons, listAccounts, listPayments } from '$lib/api.js';

export async function load() {
  const [stats, recentActivity, host, bankConfig, persons, accounts, pendingPayments] = await Promise.all([
    getStats(),
    getActivity(5, 0),
    getHost().catch(() => null),
    getBankConfig().catch(() => null),
    listPersons().catch(() => []),
    listAccounts().catch(() => []),
    listPayments({ status: 'PENDING_EDS' }).catch(() => []),
  ]);
  return { stats, recentActivity, host, bankConfig, persons, accounts, pendingPayments };
}
