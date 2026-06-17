<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { setBankConfig, seedDemo } from '$lib/api.js';
  import Icon from '$lib/components/Icon.svelte';
  import type { BankConfig } from '$lib/types.js';

  interface Props {
    data: { bank: BankConfig | null };
  }

  let { data }: Props = $props();

  let editing = $state(false);
  let blz = $state('');
  let bankName = $state('');
  let bic = $state('');
  let saving = $state(false);
  let seeding = $state(false);
  let seedResult = $state('');

  function startEdit() {
    blz = data.bank?.blz ?? '';
    bankName = data.bank?.name ?? '';
    bic = data.bank?.bic ?? '';
    editing = true;
  }

  async function handleSave() {
    if (!blz.trim() || !bankName.trim() || !bic.trim()) return;
    saving = true;
    try {
      await setBankConfig({ blz: blz.trim(), name: bankName.trim(), bic: bic.trim() });
      editing = false;
      await invalidateAll();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      saving = false;
    }
  }

  async function handleSeedDemo() {
    if (!confirm('This will create demo bank config, persons, accounts and bookings. Continue?')) return;
    seeding = true;
    seedResult = '';
    try {
      const result = await seedDemo();
      seedResult = `Seeded: ${result.persons.length} persons, ${result.accounts.length} accounts, ${result.bookingCount} bookings`;
      await invalidateAll();
    } catch (e) {
      seedResult = e instanceof Error ? e.message : 'Seed failed';
    } finally {
      seeding = false;
    }
  }
</script>

<div class="flex items-center justify-between mb-6">
  <h1 class="text-2xl font-bold">Bank Configuration</h1>
  <button class="btn btn-outline btn-sm gap-2" disabled={seeding} onclick={handleSeedDemo}>
    <Icon name="seed" class="w-4 h-4" />
    {seeding ? 'Seeding...' : 'Seed Demo Data'}
  </button>
</div>

{#if seedResult}
  <div class="alert alert-info mb-4 text-sm">{seedResult}</div>
{/if}

{#if !data.bank && !editing}
  <div class="text-center py-16 text-base-content/40">
    <Icon name="bank" class="w-12 h-12 mx-auto mb-3 opacity-30" />
    <p class="text-lg">Bank not configured</p>
    <p class="text-sm mt-1">Configure the bank or seed demo data to get started.</p>
    <button class="btn btn-primary btn-sm mt-4" onclick={startEdit}>Configure Bank</button>
  </div>
{:else if !editing}
  <div class="bg-base-200 rounded-xl p-5">
    <div class="flex items-start justify-between">
      <div>
        <div class="text-xl font-bold">{data.bank?.name}</div>
        <div class="grid grid-cols-2 gap-8 mt-4">
          <div>
            <div class="text-xs text-base-content/50 mb-0.5">BLZ</div>
            <div class="font-mono text-lg">{data.bank?.blz}</div>
          </div>
          <div>
            <div class="text-xs text-base-content/50 mb-0.5">BIC</div>
            <div class="font-mono text-lg">{data.bank?.bic}</div>
          </div>
        </div>
      </div>
      <button class="btn btn-ghost btn-sm gap-1.5" onclick={startEdit}>
        <Icon name="edit" class="w-3.5 h-3.5" />
        Edit
      </button>
    </div>
  </div>
{:else}
  <div class="bg-base-200 rounded-xl p-5">
    <h3 class="text-sm font-semibold mb-4">Bank Details</h3>
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div class="form-control">
        <label class="label" for="bankName"><span class="label-text text-xs">Bank Name</span></label>
        <input id="bankName" type="text" class="input input-bordered input-sm" bind:value={bankName} placeholder="EBICS Test Bank AG" />
      </div>
      <div class="form-control">
        <label class="label" for="blz"><span class="label-text text-xs">BLZ</span></label>
        <input id="blz" type="text" class="input input-bordered input-sm font-mono" bind:value={blz} placeholder="10020030" />
      </div>
      <div class="form-control">
        <label class="label" for="bic"><span class="label-text text-xs">BIC</span></label>
        <input id="bic" type="text" class="input input-bordered input-sm font-mono" bind:value={bic} placeholder="ETBADE2AXXX" />
      </div>
    </div>
    <div class="flex gap-2 mt-5 justify-end">
      <button class="btn btn-ghost btn-sm" onclick={() => editing = false}>Cancel</button>
      <button class="btn btn-primary btn-sm" disabled={saving || !blz.trim() || !bankName.trim() || !bic.trim()} onclick={handleSave}>
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  </div>
{/if}
