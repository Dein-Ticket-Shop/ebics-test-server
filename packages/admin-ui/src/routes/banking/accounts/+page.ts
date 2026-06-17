import { listAccounts, listPersons } from '$lib/api.js';

export async function load() {
  const [accounts, persons] = await Promise.all([listAccounts(), listPersons()]);
  return { accounts, persons };
}
