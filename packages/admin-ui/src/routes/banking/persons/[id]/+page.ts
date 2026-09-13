import { getBankConfig, getPerson, listAccounts, listAccountsForPerson } from '$lib/api.js';

export async function load({ params }: { params: { id: string } }) {
  const id = parseInt(params.id, 10);
  const [person, accounts, allAccounts, bankConfig] = await Promise.all([
    getPerson(id),
    listAccountsForPerson(id),
    listAccounts(),
    getBankConfig().catch(() => null),
  ]);
  return { person, accounts, allAccounts, bankConfig };
}
