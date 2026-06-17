import { getAccount, listBookings, getPerson, listSubscribers } from '$lib/api.js';

export async function load({ params }: { params: { id: string } }) {
  const id = parseInt(params.id, 10);
  const accountPromise = getAccount(id);
  const personPromise = accountPromise.then((a) => getPerson(a.personId));
  const [account, bookings, subscribers, person] = await Promise.all([
    accountPromise,
    listBookings(id),
    listSubscribers(),
    personPromise,
  ]);
  return { account, bookings, person, subscribers };
}
