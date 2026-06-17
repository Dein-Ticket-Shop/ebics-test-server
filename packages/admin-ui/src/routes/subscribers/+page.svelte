<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { base } from '$app/paths';
  import StateBadge from '$lib/components/StateBadge.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { createSubscriber, activateSubscriber, deleteSubscriber } from '$lib/api.js';
  import type { Subscriber } from '$lib/types.js';

  interface Props {
    data: { subscribers: Subscriber[] };
  }

  let { data }: Props = $props();

  let showModal = $state(false);
  let newPartnerId = $state('');
  let newUserId = $state('');
  let creating = $state(false);
  let error = $state('');

  async function handleCreate() {
    if (!newPartnerId.trim() || !newUserId.trim()) return;
    creating = true;
    error = '';
    try {
      await createSubscriber(newPartnerId.trim(), newUserId.trim());
      showModal = false;
      newPartnerId = '';
      newUserId = '';
      await invalidateAll();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to create subscriber';
    } finally {
      creating = false;
    }
  }

  async function handleActivate(sub: Subscriber) {
    try {
      await activateSubscriber(sub.partnerId, sub.userId);
      await invalidateAll();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Activation failed');
    }
  }

  async function handleDelete(sub: Subscriber) {
    if (!confirm(`Delete subscriber ${sub.partnerId}/${sub.userId}?`)) return;
    try {
      await deleteSubscriber(sub.partnerId, sub.userId);
      await invalidateAll();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Delete failed');
    }
  }
</script>

<div class="flex items-center justify-between mb-6">
  <h1 class="text-2xl font-bold">Subscribers</h1>
  <button class="btn btn-primary btn-sm gap-1.5" onclick={() => showModal = true}>
    <Icon name="plus" class="w-4 h-4" /> New Subscriber
  </button>
</div>

{#if data.subscribers.length === 0}
  <div class="text-center py-16 text-base-content/40">
    <Icon name="subscribers" class="w-12 h-12 mx-auto mb-3 opacity-30" />
    <p class="text-lg">No subscribers yet</p>
    <p class="text-sm mt-1">Create one to get started with the INI flow.</p>
  </div>
{:else}
  <div class="overflow-x-auto bg-base-200 rounded-xl">
    <table class="table">
      <thead>
        <tr>
          <th>Partner ID</th>
          <th>User ID</th>
          <th>State</th>
          <th>Created</th>
          <th class="w-48"></th>
        </tr>
      </thead>
      <tbody>
        {#each data.subscribers as sub}
          <tr class="hover:bg-base-300/50">
            <td class="font-mono">
              <a href="{base}/subscribers/{sub.partnerId}/{sub.userId}" class="link link-hover">{sub.partnerId}</a>
            </td>
            <td class="font-mono">{sub.userId}</td>
            <td><StateBadge state={sub.state} /></td>
            <td class="text-sm text-base-content/50">{new Date(sub.createdAt + 'Z').toLocaleDateString()}</td>
            <td>
              <div class="flex gap-1 justify-end">
                <a href="{base}/subscribers/{sub.partnerId}/{sub.userId}" class="btn btn-ghost btn-xs">View</a>
                {#if sub.state === 'INITIALIZED'}
                  <button class="btn btn-success btn-xs" onclick={() => handleActivate(sub)}>Activate</button>
                {/if}
                <button class="btn btn-ghost btn-xs text-error" onclick={() => handleDelete(sub)}>Delete</button>
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
      <h3 class="text-lg font-bold">New Subscriber</h3>
      <div class="form-control mt-4">
        <label class="label" for="partnerId"><span class="label-text text-xs">Partner ID</span></label>
        <input id="partnerId" type="text" class="input input-bordered input-sm" bind:value={newPartnerId} placeholder="e.g. PARTNER1" />
      </div>
      <div class="form-control mt-3">
        <label class="label" for="userId"><span class="label-text text-xs">User ID</span></label>
        <input id="userId" type="text" class="input input-bordered input-sm" bind:value={newUserId} placeholder="e.g. USER1" />
      </div>
      {#if error}
        <div class="alert alert-error mt-4 text-sm">{error}</div>
      {/if}
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => showModal = false}>Cancel</button>
        <button class="btn btn-primary btn-sm" disabled={creating || !newPartnerId.trim() || !newUserId.trim()} onclick={handleCreate}>
          {creating ? 'Creating...' : 'Create'}
        </button>
      </div>
    </div>
    <button class="modal-backdrop" onclick={() => showModal = false}>Close</button>
  </div>
{/if}
