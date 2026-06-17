import { getBankConfig } from '$lib/api.js';

export async function load() {
  const bank = await getBankConfig().catch(() => null);
  return { bank };
}
