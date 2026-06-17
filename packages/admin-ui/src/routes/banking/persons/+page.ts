import { listPersons } from '$lib/api.js';

export async function load() {
  return { persons: await listPersons() };
}
