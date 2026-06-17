import { getHost } from '$lib/api.js';

export async function load() {
  const host = await getHost().catch(() => null);
  return { host };
}
