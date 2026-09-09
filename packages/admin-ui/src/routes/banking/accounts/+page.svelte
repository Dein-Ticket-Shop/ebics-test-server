<script lang="ts">
  import { base } from '$app/paths';
  import { invalidateAll } from '$app/navigation';
  import Icon from '$lib/components/Icon.svelte';
  import { deleteAccount } from '$lib/api.js';
  import type { Account, Person } from '$lib/types.js';

  interface Props {
    data: { accounts: Account[]; persons: Person[] };
  }

  let { data }: Props = $props();

  const personMap = $derived(new Map(data.persons.map((p) => [p.id, p])));

  function formatCents(cents: number, cur: string): string {
    return (cents / 100).toLocaleString('de-DE', { style: 'currency', currency: cur });
  }

  const totalBalance = $derived(data.accounts.reduce((sum, a) => sum + a.currentBalanceCents, 0));

  async function handleDelete(account: Account) {
    if (!confirm(`Delete account ${account.name} (${account.iban})? This also removes its bookings.`)) return;
    try {
      await deleteAccount(account.id);
      await invalidateAll();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Delete failed');
    }
  }
</script>

<div class="flex items-center justify-between mb-6">
  <h1 class="text-2xl font-bold">Accounts</h1>
  {#if data.accounts.length > 0}
    <div class="text-right">
      <div class="text-xs text-base-content/50">Total Balance</div>
      <div class="font-mono text-lg font-bold {totalBalance >= 0 ? 'text-success' : 'text-error'}">
        {formatCents(totalBalance, 'EUR')}
      </div>
    </div>
  {/if}
</div>

{#if data.accounts.length === 0}
  <div class="text-center py-16 text-base-content/40">
    <Icon name="accounts" class="w-12 h-12 mx-auto mb-3 opacity-30" />
    <p class="text-lg">No accounts yet</p>
    <p class="text-sm mt-1">Create accounts from a person's detail page.</p>
  </div>
{:else}
  <div class="overflow-x-auto bg-base-200 rounded-xl">
    <table class="table">
      <thead>
        <tr>
          <th>Account Name</th>
          <th>IBAN</th>
          <th>Owner</th>
          <th>Currency</th>
          <th class="text-right">Balance</th>
          <th class="w-28"></th>
        </tr>
      </thead>
      <tbody>
        {#each data.accounts as account}
          {@const owner = personMap.get(account.personId)}
          <tr class="hover:bg-base-300/50">
            <td>
              <a href="{base}/banking/accounts/{account.id}" class="link link-hover font-medium">{account.name}</a>
            </td>
            <td class="font-mono text-sm text-base-content/60">{account.iban}</td>
            <td>
              {#if owner}
                <a href="{base}/banking/persons/{owner.id}" class="link link-hover text-sm">{owner.name}</a>
              {:else}
                <span class="text-base-content/30">-</span>
              {/if}
            </td>
            <td class="font-mono text-sm">{account.currency}</td>
            <td class="text-right font-mono font-medium {account.currentBalanceCents >= 0 ? 'text-success' : 'text-error'}">
              {formatCents(account.currentBalanceCents, account.currency)}
            </td>
            <td>
              <div class="flex gap-1 justify-end">
                <a href="{base}/banking/accounts/{account.id}" class="btn btn-ghost btn-xs">View</a>
                <button class="btn btn-ghost btn-xs text-error" onclick={() => handleDelete(account)}>Delete</button>
              </div>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
