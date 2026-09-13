import { listKeptRealtimeMessages, listRealtimeConnections, listSubscribers } from '$lib/api.js';

export async function load() {
  const [connections, kept, subscribers] = await Promise.all([
    listRealtimeConnections().catch(() => []),
    listKeptRealtimeMessages().catch(() => []),
    listSubscribers().catch(() => []),
  ]);
  return { connections, kept, subscribers };
}
