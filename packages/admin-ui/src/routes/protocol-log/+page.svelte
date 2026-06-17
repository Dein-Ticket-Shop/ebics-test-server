<script lang="ts">
  import { base } from '$app/paths';
  import { getProtocolLog } from '$lib/api.js';
  import Icon from '$lib/components/Icon.svelte';
  import type { ProtocolLogSummary } from '$lib/types.js';

  interface Props {
    data: { entries: ProtocolLogSummary[] };
  }

  let { data }: Props = $props();

  let entries = $derived(data.entries);
  let extraEntries = $state<ProtocolLogSummary[]>([]);
  let loading = $state(false);

  let allEntries = $derived([...entries, ...extraEntries]);

  async function loadMore() {
    loading = true;
    try {
      const more = await getProtocolLog(100, allEntries.length);
      extraEntries = [...extraEntries, ...more];
    } finally {
      loading = false;
    }
  }

  function formatTime(iso: string): string {
    return new Date(iso + 'Z').toLocaleString();
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  function returnCodeClass(code?: string): string {
    if (!code) return '';
    if (code === '000000') return 'text-success';
    if (code.startsWith('01')) return 'text-info';
    return 'text-error';
  }

  function rootElementShort(el?: string): string {
    if (!el) return '?';
    return el.replace('ebics', '').replace('Request', 'Req').replace('Response', 'Res');
  }
</script>

<div class="flex items-center justify-between mb-6">
  <h1 class="text-2xl font-bold">Protocol Log</h1>
  <div class="text-sm text-base-content/50">{allEntries.length} entries</div>
</div>

{#if allEntries.length === 0}
  <div class="text-center py-16 text-base-content/40">
    <Icon name="protocol" class="w-12 h-12 mx-auto mb-3 opacity-30" />
    <p class="text-lg">No EBICS exchanges recorded yet</p>
    <p class="text-sm mt-1">Send requests to the EBICS endpoint to see them here.</p>
  </div>
{:else}
  <div class="overflow-x-auto bg-base-200 rounded-xl">
    <table class="table table-sm">
      <thead>
        <tr>
          <th>#</th>
          <th>Time</th>
          <th>Type</th>
          <th>Order</th>
          <th>Subscriber</th>
          <th>TxID</th>
          <th>Phase</th>
          <th>Result</th>
          <th>Size</th>
          <th>Duration</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each allEntries as entry}
          <tr class="hover:bg-base-300/50">
            <td class="font-mono text-xs text-base-content/40">{entry.id}</td>
            <td class="font-mono text-xs whitespace-nowrap">{formatTime(entry.createdAt)}</td>
            <td>
              <span class="badge badge-ghost badge-xs font-mono">{rootElementShort(entry.rootElement)}</span>
            </td>
            <td>
              {#if entry.orderType}
                <span class="badge badge-outline badge-xs font-bold">{entry.orderType}</span>
              {:else}
                <span class="text-base-content/20">-</span>
              {/if}
            </td>
            <td>
              {#if entry.partnerId}
                <span class="font-mono text-xs">{entry.partnerId}/{entry.userId}</span>
              {:else}
                <span class="text-base-content/20">-</span>
              {/if}
            </td>
            <td>
              {#if entry.transactionId}
                <span class="font-mono text-xs" title={entry.transactionId}>{entry.transactionId.slice(0, 8)}...</span>
              {:else}
                <span class="text-base-content/20">-</span>
              {/if}
            </td>
            <td>
              {#if entry.transactionPhase}
                <span class="text-xs">{entry.transactionPhase.slice(0, 4)}</span>
              {:else}
                <span class="text-base-content/20">-</span>
              {/if}
            </td>
            <td>
              {#if entry.returnCode}
                <span class="font-mono text-xs {returnCodeClass(entry.returnCode)}">{entry.returnCode}</span>
              {:else}
                <span class="text-base-content/20">-</span>
              {/if}
            </td>
            <td class="text-xs text-base-content/50 whitespace-nowrap">
              {formatSize(entry.requestSize)} / {formatSize(entry.responseSize)}
            </td>
            <td class="text-xs font-mono text-base-content/40">
              {entry.durationMs !== undefined ? `${entry.durationMs}ms` : '-'}
            </td>
            <td>
              <a href="{base}/protocol-log/{entry.id}" class="btn btn-ghost btn-xs">View</a>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  {#if entries.length >= 100 || extraEntries.length % 100 === 0 && extraEntries.length > 0}
    <div class="flex justify-center mt-4">
      <button class="btn btn-ghost btn-sm" disabled={loading} onclick={loadMore}>
        {loading ? 'Loading...' : 'Load More'}
      </button>
    </div>
  {/if}
{/if}
