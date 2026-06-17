import { getProtocolLogEntry } from '$lib/api.js';

export async function load({ params }: { params: { id: string } }) {
  return { entry: await getProtocolLogEntry(parseInt(params.id, 10)) };
}
