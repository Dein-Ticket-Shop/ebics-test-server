import { getActivity } from '$lib/api.js';

export async function load() {
  return { activity: await getActivity(50, 0) };
}
