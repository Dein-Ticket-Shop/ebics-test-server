import { getServerFlags, listSubscribers, listVeuOrders } from '$lib/api.js';

export async function load({ url }: { url: URL }) {
  const partnerId = url.searchParams.get('partnerId') ?? '';
  const [orders, flags, subscribers] = await Promise.all([
    listVeuOrders(partnerId || undefined),
    getServerFlags().catch(() => null),
    listSubscribers().catch(() => []),
  ]);
  return { orders, flags, subscribers, partnerId };
}
