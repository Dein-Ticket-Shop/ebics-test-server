import { listSubscribers } from '$lib/api.js';

export async function load() {
  return { subscribers: await listSubscribers() };
}
