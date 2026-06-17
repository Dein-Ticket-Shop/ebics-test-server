<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { base } from '$app/paths';
  import { deletePerson, createAccount } from '$lib/api.js';
  import Icon from '$lib/components/Icon.svelte';
  import type { Person, Account } from '$lib/types.js';

  interface Props {
    data: { person: Person; accounts: Account[] };
  }

  let { data }: Props = $props();

  let showNewAccount = $state(false);
  let accountName = $state('');
  let currency = $state('EUR');
  let creating = $state(false);
  let error = $state('');

  function formatCents(cents: number, cur: string): string {
    return (cents / 100).toLocaleString('de-DE', { style: 'currency', currency: cur });
  }

  async function handleDelete() {
    if (!confirm(`Delete ${data.person.name}? This may fail if they have accounts.`)) return;
    try {
      await deletePerson(data.person.id);
      goto(`${base}/banking/persons`);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  async function handleCreateAccount() {
    if (!accountName.trim()) return;
    creating = true;
    error = '';
    try {
      await createAccount({ personId: data.person.id, name: accountName.trim(), currency: currency.trim() || 'EUR' });
      showNewAccount = false;
      accountName = '';
      currency = 'EUR';
      await invalidateAll();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to create account';
    } finally {
      creating = false;
    }
  }
</script>

<div class="mb-6">
  <a href="{base}/banking/persons" class="text-sm text-base-content/50 hover:text-base-content inline-flex items-center gap-1">
    <Icon name="chevronLeft" class="w-3.5 h-3.5" /> Persons
  </a>
</div>

<div class="flex items-start justify-between mb-6">
  <div>
    <h1 class="text-2xl font-bold">{data.person.name}</h1>
    <div class="flex items-center gap-3 mt-1.5 text-sm text-base-content/50">
      {#if data.person.externalId}
        <span class="font-mono bg-base-200 px-2 py-0.5 rounded text-xs">{data.person.externalId}</span>
      {/if}
      <span>{data.person.country}</span>
      {#if data.person.addressLine1}
        <span class="text-base-content/40">|</span>
        <span>{data.person.addressLine1}{data.person.addressLine2 ? `, ${data.person.addressLine2}` : ''}</span>
      {/if}
    </div>
  </div>
  <button class="btn btn-ghost btn-sm text-error gap-1.5" onclick={handleDelete}>
    <Icon name="trash" class="w-3.5 h-3.5" /> Delete
  </button>
</div>

<div class="flex items-center justify-between mb-4">
  <h2 class="text-lg font-semibold">Accounts</h2>
  <button class="btn btn-primary btn-sm gap-1.5" onclick={() => showNewAccount = true}>
    <Icon name="plus" class="w-4 h-4" /> New Account
  </button>
</div>

{#if showNewAccount}
  <div class="bg-base-200 rounded-xl p-4 mb-4">
    <div class="flex gap-4 items-end">
      <div class="form-control flex-1">
        <label class="label" for="accName"><span class="label-text text-xs">Account Name</span></label>
        <input id="accName" type="text" class="input input-bordered input-sm" bind:value={accountName} placeholder="Girokonto" />
      </div>
      <div class="form-control w-24">
        <label class="label" for="accCur"><span class="label-text text-xs">Currency</span></label>
        <input id="accCur" type="text" class="input input-bordered input-sm font-mono" bind:value={currency} />
      </div>
      <button class="btn btn-primary btn-sm" disabled={creating || !accountName.trim()} onclick={handleCreateAccount}>
        {creating ? '...' : 'Create'}
      </button>
      <button class="btn btn-ghost btn-sm" onclick={() => showNewAccount = false}>Cancel</button>
    </div>
    {#if error}
      <div class="alert alert-error mt-2 text-sm">{error}</div>
    {/if}
  </div>
{/if}

{#if data.accounts.length === 0}
  <div class="text-center py-10 text-base-content/40">
    <p>No accounts yet.</p>
  </div>
{:else}
  <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
    {#each data.accounts as account}
      <a href="{base}/banking/accounts/{account.id}" class="bg-base-200 rounded-xl p-4 hover:bg-base-300/60 transition-colors block">
        <div class="flex justify-between items-start">
          <div>
            <div class="font-medium">{account.name}</div>
            <div class="font-mono text-xs text-base-content/40 mt-1">{account.iban}</div>
          </div>
          <div class="text-right">
            <div class="font-mono text-lg font-bold {account.currentBalanceCents >= 0 ? 'text-success' : 'text-error'}">
              {formatCents(account.currentBalanceCents, account.currency)}
            </div>
          </div>
        </div>
      </a>
    {/each}
  </div>
{/if}
