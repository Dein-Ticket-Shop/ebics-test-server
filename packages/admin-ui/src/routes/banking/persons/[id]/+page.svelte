<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { base } from '$app/paths';
  import { deletePerson, updatePerson, createAccount } from '$lib/api.js';
  import Icon from '$lib/components/Icon.svelte';
  import type { Person, Account } from '$lib/types.js';

  interface Props {
    data: { person: Person; accounts: Account[] };
  }

  let { data }: Props = $props();

  let showNewAccount = $state(false);
  let accountName = $state('');
  let currency = $state('EUR');
  let accountNumber = $state('');
  let creating = $state(false);
  let error = $state('');

  // Edit person
  let editing = $state(false);
  let edit = $state({ name: '', externalId: '', addressLine1: '', addressLine2: '', country: '' });
  let savingPerson = $state(false);
  let editError = $state('');

  function startEdit() {
    edit = {
      name: data.person.name,
      externalId: data.person.externalId ?? '',
      addressLine1: data.person.addressLine1 ?? '',
      addressLine2: data.person.addressLine2 ?? '',
      country: data.person.country,
    };
    editError = '';
    editing = true;
  }

  async function handleSavePerson() {
    if (!edit.name.trim()) return;
    savingPerson = true;
    editError = '';
    try {
      await updatePerson(data.person.id, {
        name: edit.name.trim(),
        externalId: edit.externalId.trim() || undefined,
        addressLine1: edit.addressLine1.trim() || undefined,
        addressLine2: edit.addressLine2.trim() || undefined,
        country: edit.country.trim() || 'DE',
      });
      editing = false;
      await invalidateAll();
    } catch (e) {
      editError = e instanceof Error ? e.message : 'Save failed';
    } finally {
      savingPerson = false;
    }
  }

  function formatCents(cents: number, cur: string): string {
    return (cents / 100).toLocaleString('de-DE', { style: 'currency', currency: cur });
  }

  async function handleDelete() {
    if (!confirm(`Delete ${data.person.name}? This also deletes their accounts and bookings.`)) return;
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
      await createAccount({
        personId: data.person.id,
        name: accountName.trim(),
        currency: currency.trim() || 'EUR',
        accountNumber: accountNumber.trim() || undefined,
      });
      showNewAccount = false;
      accountName = '';
      currency = 'EUR';
      accountNumber = '';
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
  <div class="flex gap-2">
    <button class="btn btn-ghost btn-sm gap-1.5" onclick={startEdit}>
      <Icon name="edit" class="w-3.5 h-3.5" /> Edit
    </button>
    <button class="btn btn-ghost btn-sm text-error gap-1.5" onclick={handleDelete}>
      <Icon name="trash" class="w-3.5 h-3.5" /> Delete
    </button>
  </div>
</div>

{#if editing}
  <div class="bg-base-200 rounded-xl p-4 mb-6">
    <h2 class="text-sm font-semibold mb-3">Edit Person</h2>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div class="form-control">
        <label class="label" for="edName"><span class="label-text text-xs">Name</span></label>
        <input id="edName" type="text" class="input input-bordered input-sm" bind:value={edit.name} />
      </div>
      <div class="form-control">
        <label class="label" for="edExt"><span class="label-text text-xs">External ID</span></label>
        <input id="edExt" type="text" class="input input-bordered input-sm font-mono" bind:value={edit.externalId} />
      </div>
      <div class="form-control">
        <label class="label" for="edA1"><span class="label-text text-xs">Address Line 1</span></label>
        <input id="edA1" type="text" class="input input-bordered input-sm" bind:value={edit.addressLine1} />
      </div>
      <div class="form-control">
        <label class="label" for="edA2"><span class="label-text text-xs">Address Line 2</span></label>
        <input id="edA2" type="text" class="input input-bordered input-sm" bind:value={edit.addressLine2} />
      </div>
      <div class="form-control w-24">
        <label class="label" for="edCty"><span class="label-text text-xs">Country</span></label>
        <input id="edCty" type="text" class="input input-bordered input-sm font-mono" bind:value={edit.country} maxlength="2" />
      </div>
    </div>
    <div class="flex gap-2 mt-3">
      <button class="btn btn-primary btn-sm" disabled={savingPerson || !edit.name.trim()} onclick={handleSavePerson}>
        {savingPerson ? '...' : 'Save'}
      </button>
      <button class="btn btn-ghost btn-sm" onclick={() => editing = false}>Cancel</button>
    </div>
    {#if editError}
      <div class="alert alert-error mt-2 text-sm">{editError}</div>
    {/if}
  </div>
{/if}

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
      <div class="form-control w-40">
        <label class="label" for="accNum"><span class="label-text text-xs">Account Number (optional)</span></label>
        <input id="accNum" type="text" inputmode="numeric" maxlength="10" class="input input-bordered input-sm font-mono" bind:value={accountNumber} placeholder="auto" />
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
