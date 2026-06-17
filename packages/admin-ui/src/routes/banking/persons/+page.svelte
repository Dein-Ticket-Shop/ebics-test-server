<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { base } from '$app/paths';
  import { createPerson, deletePerson } from '$lib/api.js';
  import Icon from '$lib/components/Icon.svelte';
  import type { Person } from '$lib/types.js';

  interface Props {
    data: { persons: Person[] };
  }

  let { data }: Props = $props();

  let showModal = $state(false);
  let name = $state('');
  let externalId = $state('');
  let country = $state('DE');
  let addressLine1 = $state('');
  let addressLine2 = $state('');
  let creating = $state(false);
  let error = $state('');

  function resetForm() {
    name = '';
    externalId = '';
    country = 'DE';
    addressLine1 = '';
    addressLine2 = '';
    error = '';
  }

  async function handleCreate() {
    if (!name.trim()) return;
    creating = true;
    error = '';
    try {
      await createPerson({
        name: name.trim(),
        externalId: externalId.trim() || undefined,
        country: country.trim() || 'DE',
        addressLine1: addressLine1.trim() || undefined,
        addressLine2: addressLine2.trim() || undefined,
      });
      showModal = false;
      resetForm();
      await invalidateAll();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to create person';
    } finally {
      creating = false;
    }
  }

  async function handleDelete(person: Person) {
    if (!confirm(`Delete ${person.name}?`)) return;
    try {
      await deletePerson(person.id);
      await invalidateAll();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Delete failed');
    }
  }
</script>

<div class="flex items-center justify-between mb-6">
  <h1 class="text-2xl font-bold">Persons</h1>
  <button class="btn btn-primary btn-sm gap-1.5" onclick={() => { resetForm(); showModal = true; }}>
    <Icon name="plus" class="w-4 h-4" />
    New Person
  </button>
</div>

{#if data.persons.length === 0}
  <div class="text-center py-16 text-base-content/40">
    <Icon name="persons" class="w-12 h-12 mx-auto mb-3 opacity-30" />
    <p class="text-lg">No persons yet</p>
    <p class="text-sm mt-1">Create a person or seed demo data from Bank Config.</p>
  </div>
{:else}
  <div class="overflow-x-auto bg-base-200 rounded-xl">
    <table class="table">
      <thead>
        <tr>
          <th>Name</th>
          <th>External ID</th>
          <th>Country</th>
          <th>Address</th>
          <th>Created</th>
          <th class="w-32"></th>
        </tr>
      </thead>
      <tbody>
        {#each data.persons as person}
          <tr class="hover:bg-base-300/50">
            <td>
              <a href="{base}/banking/persons/{person.id}" class="link link-hover font-medium">{person.name}</a>
            </td>
            <td><span class="font-mono text-sm text-base-content/60">{person.externalId ?? '-'}</span></td>
            <td>{person.country}</td>
            <td class="text-sm text-base-content/60">{person.addressLine1 ?? '-'}</td>
            <td class="text-sm text-base-content/50">{new Date(person.createdAt + 'Z').toLocaleDateString()}</td>
            <td>
              <div class="flex gap-1 justify-end">
                <a href="{base}/banking/persons/{person.id}" class="btn btn-ghost btn-xs">View</a>
                <button class="btn btn-ghost btn-xs text-error" onclick={() => handleDelete(person)}>Delete</button>
              </div>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

{#if showModal}
  <div class="modal modal-open">
    <div class="modal-box">
      <h3 class="text-lg font-bold">New Person</h3>
      <div class="form-control mt-4">
        <label class="label" for="personName"><span class="label-text text-xs">Name *</span></label>
        <input id="personName" type="text" class="input input-bordered input-sm" bind:value={name} placeholder="Alice Mustermann" />
      </div>
      <div class="grid grid-cols-2 gap-4 mt-3">
        <div class="form-control">
          <label class="label" for="extId"><span class="label-text text-xs">External ID</span></label>
          <input id="extId" type="text" class="input input-bordered input-sm" bind:value={externalId} placeholder="alice" />
        </div>
        <div class="form-control">
          <label class="label" for="country"><span class="label-text text-xs">Country</span></label>
          <input id="country" type="text" class="input input-bordered input-sm" bind:value={country} placeholder="DE" />
        </div>
      </div>
      <div class="form-control mt-3">
        <label class="label" for="addr1"><span class="label-text text-xs">Address Line 1</span></label>
        <input id="addr1" type="text" class="input input-bordered input-sm" bind:value={addressLine1} placeholder="Musterstraße 1" />
      </div>
      <div class="form-control mt-3">
        <label class="label" for="addr2"><span class="label-text text-xs">Address Line 2</span></label>
        <input id="addr2" type="text" class="input input-bordered input-sm" bind:value={addressLine2} placeholder="12345 Berlin" />
      </div>
      {#if error}
        <div class="alert alert-error mt-4 text-sm">{error}</div>
      {/if}
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => showModal = false}>Cancel</button>
        <button class="btn btn-primary btn-sm" disabled={creating || !name.trim()} onclick={handleCreate}>
          {creating ? 'Creating...' : 'Create'}
        </button>
      </div>
    </div>
    <button class="modal-backdrop" onclick={() => showModal = false}>Close</button>
  </div>
{/if}
