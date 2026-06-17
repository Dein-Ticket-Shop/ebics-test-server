import { getStats, getActivity, getHost, getBankConfig, listPersons, listAccounts } from '$lib/api.js';

export async function load() {
  const [stats, recentActivity, host, bankConfig, persons, accounts] = await Promise.all([
    getStats(),
    getActivity(5, 0),
    getHost().catch(() => null),
    getBankConfig().catch(() => null),
    listPersons().catch(() => []),
    listAccounts().catch(() => []),
  ]);
  return { stats, recentActivity, host, bankConfig, persons, accounts };
}
