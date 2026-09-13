import { listDownloadData } from '$lib/api.js';

export async function load() {
  return { entries: await listDownloadData() };
}
