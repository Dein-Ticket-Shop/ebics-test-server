<script lang="ts">
  import { getActivity } from '$lib/api.js';
  import Icon from '$lib/components/Icon.svelte';
  import type { ActivityLogEntry } from '$lib/types.js';

  interface Props {
    data: { activity: ActivityLogEntry[] };
  }

  let { data }: Props = $props();

  let entries = $derived(data.activity);
  let extraEntries = $state<ActivityLogEntry[]>([]);
  let loading = $state(false);
  let hasMore = $derived(entries.length === 50 || extraEntries.length % 50 === 0);

  let allEntries = $derived([...entries, ...extraEntries]);

  async function loadMore() {
    loading = true;
    try {
      const more = await getActivity(50, allEntries.length);
      extraEntries = [...extraEntries, ...more];
    } finally {
      loading = false;
    }
  }

  function formatEvent(type: string): string {
    return type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function formatTime(iso: string): string {
    return new Date(iso + 'Z').toLocaleString();
  }
</script>

<h1 class="text-2xl font-bold mb-6">Activity Log</h1>

{#if allEntries.length === 0}
  <div class="text-center py-16 text-base-content/40">
    <Icon name="activity" class="w-12 h-12 mx-auto mb-3 opacity-30" />
    <p class="text-lg">No activity recorded yet</p>
    <p class="text-sm mt-1">Actions and EBICS requests will appear here.</p>
  </div>
{:else}
  <div class="overflow-x-auto bg-base-200 rounded-xl">
    <table class="table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Event</th>
          <th>Subscriber</th>
          <th>Order Type</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>
        {#each allEntries as entry}
          <tr class="hover:bg-base-300/50">
            <td class="font-mono text-xs whitespace-nowrap">{formatTime(entry.createdAt)}</td>
            <td class="text-sm">{formatEvent(entry.eventType)}</td>
            <td>
              {#if entry.partnerId}
                <span class="font-mono text-sm">{entry.partnerId}/{entry.userId}</span>
              {:else}
                <span class="text-base-content/30">-</span>
              {/if}
            </td>
            <td>
              {#if entry.orderType}
                <span class="badge badge-outline badge-xs">{entry.orderType}</span>
              {:else}
                <span class="text-base-content/30">-</span>
              {/if}
            </td>
            <td>
              {#if entry.resultCode}
                <span class="font-mono text-xs">{entry.resultCode}</span>
              {:else}
                <span class="text-base-content/30">-</span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  {#if hasMore}
    <div class="flex justify-center mt-4">
      <button class="btn btn-ghost btn-sm" disabled={loading} onclick={loadMore}>
        {loading ? 'Loading...' : 'Load More'}
      </button>
    </div>
  {/if}
{/if}
