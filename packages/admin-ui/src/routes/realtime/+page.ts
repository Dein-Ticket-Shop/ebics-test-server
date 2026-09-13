import { listRealtimeConnections, listSubscribers } from '$lib/api.js';

export async function load() {
  const [connections, subscribers] = await Promise.all([
    listRealtimeConnections().catch(() => []),
    listSubscribers().catch(() => []),
  ]);
  return { connections, subscribers };
}
