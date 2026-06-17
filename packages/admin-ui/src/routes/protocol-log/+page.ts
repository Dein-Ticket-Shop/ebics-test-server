import { getProtocolLog } from '$lib/api.js';

export async function load() {
  return { entries: await getProtocolLog(100, 0) };
}
