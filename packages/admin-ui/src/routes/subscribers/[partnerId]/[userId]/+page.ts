import { getSubscriber } from '$lib/api.js';

export async function load({ params }: { params: { partnerId: string; userId: string } }) {
  return { subscriber: await getSubscriber(params.partnerId, params.userId) };
}
