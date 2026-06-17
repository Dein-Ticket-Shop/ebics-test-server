<script lang="ts">
  import type { SubscriberState, BankConfig, Person, Account } from '$lib/types.js';
  import { base } from '$app/paths';

  interface Props {
    data: {
      stats: { total: number; byState: Record<SubscriberState, number>; hostConfigured: boolean };
      recentActivity: Array<{
        id: number;
        eventType: string;
        partnerId?: string;
        userId?: string;
        orderType?: string;
        resultCode?: string;
        createdAt: string;
      }>;
      host: { hostId: string } | null;
      bankConfig: BankConfig | null;
      persons: Person[];
      accounts: Account[];
    };
  }

  const { data }: Props = $props();

  const totalBalanceCents = $derived(data.accounts.reduce((s, a) => s + a.currentBalanceCents, 0));

  function formatCents(cents: number): string {
    return (cents / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
  }

  const stateColors: Record<string, string> = {
    NEW: 'text-neutral',
    PARTIALLY_INITIALIZED_INI: 'text-warning',
    PARTIALLY_INITIALIZED_HIA: 'text-warning',
    INITIALIZED: 'text-info',
    READY: 'text-success',
    SUSPENDED: 'text-error',
  };

  function formatEvent(type: string): string {
    return type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function formatTime(iso: string): string {
    return new Date(iso + 'Z').toLocaleTimeString();
  }
</script>

<h1 class="text-2xl font-bold mb-6">Dashboard</h1>

<div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
  <div class="bg-base-200 rounded-xl p-4">
    <div class="text-xs text-base-content/50 mb-1">Host ID</div>
    <div class="text-lg font-bold font-mono">{data.host?.hostId ?? 'Not configured'}</div>
    <div class="text-xs text-base-content/40 mt-0.5">{data.stats.hostConfigured ? 'Active' : 'Unconfigured'}</div>
  </div>

  <div class="bg-base-200 rounded-xl p-4">
    <div class="text-xs text-base-content/50 mb-1">Subscribers</div>
    <div class="text-2xl font-bold">{data.stats.total}</div>
    <div class="text-xs text-base-content/40 mt-0.5">{data.stats.byState.READY} ready</div>
  </div>

  <div class="bg-base-200 rounded-xl p-4">
    <div class="text-xs text-base-content/50 mb-1">Pending Activation</div>
    <div class="text-2xl font-bold text-info">{data.stats.byState.INITIALIZED}</div>
    <div class="text-xs text-base-content/40 mt-0.5">Awaiting bank operator approval</div>
  </div>
</div>

{#if data.stats.total > 0}
  <div class="bg-base-200 rounded-xl p-4 mb-6">
    <h2 class="text-sm font-semibold mb-2">Subscriber States</h2>
    <div class="flex flex-wrap gap-4">
      {#each Object.entries(data.stats.byState) as [state, count]}
        {#if count > 0}
          <div class="flex items-center gap-2">
            <span class="font-mono text-sm font-bold {stateColors[state]}">{count}</span>
            <span class="text-xs text-base-content/50">{state.replace(/_/g, ' ')}</span>
          </div>
        {/if}
      {/each}
    </div>
  </div>
{/if}

<div class="bg-base-200 rounded-xl p-4 mb-6">
  <div class="flex items-center justify-between mb-3">
    <h2 class="text-sm font-semibold">Banking Simulation</h2>
    <a href="{base}/banking" class="text-xs link link-hover text-base-content/50">Configure</a>
  </div>
  {#if data.bankConfig}
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <div>
        <div class="text-xs text-base-content/50">Bank</div>
        <div class="font-medium text-sm mt-0.5">{data.bankConfig.name}</div>
        <div class="font-mono text-xs text-base-content/40">{data.bankConfig.bic}</div>
      </div>
      <div>
        <div class="text-xs text-base-content/50">Persons</div>
        <div class="text-xl font-bold mt-0.5">{data.persons.length}</div>
      </div>
      <div>
        <div class="text-xs text-base-content/50">Accounts</div>
        <div class="text-xl font-bold mt-0.5">{data.accounts.length}</div>
      </div>
      <div>
        <div class="text-xs text-base-content/50">Total Balance</div>
        <div class="text-xl font-bold font-mono mt-0.5 {totalBalanceCents >= 0 ? 'text-success' : 'text-error'}">
          {formatCents(totalBalanceCents)}
        </div>
      </div>
    </div>
  {:else}
    <p class="text-sm text-base-content/40">Not configured. <a href="{base}/banking" class="link">Set up bank</a> or seed demo data.</p>
  {/if}
</div>

<div class="bg-base-200 rounded-xl p-4">
  <h2 class="text-sm font-semibold mb-2">Recent Activity</h2>
  {#if data.recentActivity.length === 0}
    <p class="text-sm text-base-content/40 italic">No activity yet</p>
  {:else}
    <div class="overflow-x-auto -mx-4 px-4">
      <table class="table table-sm">
        <thead>
          <tr>
            <th>Time</th>
            <th>Event</th>
            <th>Subscriber</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {#each data.recentActivity as entry}
            <tr>
              <td class="font-mono text-xs">{formatTime(entry.createdAt)}</td>
              <td class="text-sm">{formatEvent(entry.eventType)}</td>
              <td>
                {#if entry.partnerId}
                  <span class="font-mono text-xs">{entry.partnerId}/{entry.userId}</span>
                {:else}
                  <span class="text-base-content/30">-</span>
                {/if}
              </td>
              <td>
                {#if entry.orderType}
                  <span class="badge badge-outline badge-xs">{entry.orderType}</span>
                {/if}
                {#if entry.resultCode}
                  <span class="font-mono text-xs ml-1">{entry.resultCode}</span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
