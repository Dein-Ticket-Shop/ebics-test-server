import { getEnvFlags, getHost } from '$lib/api.js';

export async function load() {
  const [host, envFlags] = await Promise.all([getHost().catch(() => null), getEnvFlags().catch(() => null)]);
  return { host, envFlags };
}
