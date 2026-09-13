import { getHost, getServerFlags } from '$lib/api.js';

export async function load() {
  const [host, flags] = await Promise.all([getHost().catch(() => null), getServerFlags().catch(() => null)]);
  return { host, flags };
}
