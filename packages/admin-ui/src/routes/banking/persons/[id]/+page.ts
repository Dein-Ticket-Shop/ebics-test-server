import { getPerson, listAccountsForPerson } from '$lib/api.js';

export async function load({ params }: { params: { id: string } }) {
  const id = parseInt(params.id, 10);
  const [person, accounts] = await Promise.all([
    getPerson(id),
    listAccountsForPerson(id),
  ]);
  return { person, accounts };
}
