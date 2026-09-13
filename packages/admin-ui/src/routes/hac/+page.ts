import { getServerFlags, listHacEvents, listSubscribers } from '$lib/api.js';

export async function load({ url }: { url: URL }) {
  const partnerId = url.searchParams.get('partnerId') ?? '';
  const [events, flags, subscribers] = await Promise.all([
    listHacEvents(partnerId ? { partnerId } : {}),
    getServerFlags().catch(() => null),
    listSubscribers().catch(() => []),
  ]);
  return { events, flags, subscribers, partnerId };
}
