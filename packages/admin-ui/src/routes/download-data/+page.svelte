<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import Icon from '$lib/components/Icon.svelte';
  import { deleteDownloadData, upsertDownloadData } from '$lib/api.js';
  import type { DownloadData } from '$lib/types.js';
  import { apiErrorMessage, formatSqliteDateTime } from '$lib/payments.js';

  interface Props {
    data: { entries: DownloadData[] };
  }

  let { data }: Props = $props();

  let fService = $state('');
  let fOption = $state('');
  let fMsg = $state('');
  let fContent = $state('');
  let fType = $state<'text' | 'base64'>('text');
  let saving = $state(false);
  let formError = $state('');
  let expanded = $state<number | null>(null);

  async function handleSave() {
    if (!fService.trim() || !fContent) return;
    saving = true;
    formError = '';
    try {
      await upsertDownloadData({
        serviceName: fService.trim(),
        serviceOption: fOption.trim() || undefined,
        msgName: fMsg.trim() || undefined,
        content: fContent,
        contentType: fType,
      });
      fContent = '';
      await invalidateAll();
    } catch (e) {
      formError = apiErrorMessage(e, 'Saving failed');
    } finally {
      saving = false;
    }
  }

  async function handleDelete(entry: DownloadData) {
    const label = [entry.serviceName, entry.serviceOption, entry.msgName].filter(Boolean).join('/');
    if (!confirm(`Delete seeded download data ${label}?`)) return;
    try {
      await deleteDownloadData(entry.id);
      await invalidateAll();
    } catch (e) {
      alert(apiErrorMessage(e, 'Delete failed'));
    }
  }

  function edit(entry: DownloadData) {
    fService = entry.serviceName;
    fOption = entry.serviceOption ?? '';
    fMsg = entry.msgName ?? '';
    fContent = entry.content;
    fType = entry.contentType === 'base64' ? 'base64' : 'text';
  }
</script>

<h1 class="text-2xl font-bold mb-2">Download Data</h1>
<p class="text-sm text-base-content/50 mb-6">
  Seeded content is returned for BTD downloads with a matching service name and message name, before any generated data.
  An entry with a service option only serves requests with that <span class="font-mono">ServiceOption</span>; an entry without
  an option serves every option. Saving the same service, option and message name replaces the entry.
</p>

<div class="bg-base-200 rounded-xl p-5 mb-6">
  <h2 class="text-sm font-semibold mb-3">Add or replace entry</h2>
  <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
    <div>
      <label for="ddService" class="block text-xs text-base-content/60 mb-1">Service name *</label>
      <input id="ddService" type="text" class="input input-bordered input-sm w-full font-mono" bind:value={fService} placeholder="STM" />
    </div>
    <div>
      <label for="ddOption" class="block text-xs text-base-content/60 mb-1">Service option</label>
      <input id="ddOption" type="text" class="input input-bordered input-sm w-full font-mono" bind:value={fOption} placeholder="any" />
    </div>
    <div>
      <label for="ddMsg" class="block text-xs text-base-content/60 mb-1">Message name</label>
      <input id="ddMsg" type="text" class="input input-bordered input-sm w-full font-mono" bind:value={fMsg} placeholder="camt.054" />
    </div>
    <div>
      <label for="ddType" class="block text-xs text-base-content/60 mb-1">Content type</label>
      <select id="ddType" class="select select-bordered select-sm w-full" bind:value={fType}>
        <option value="text">text</option>
        <option value="base64">base64</option>
      </select>
    </div>
  </div>
  <div class="mt-3">
    <label for="ddContent" class="block text-xs text-base-content/60 mb-1">Content *</label>
    <textarea id="ddContent" class="textarea textarea-bordered textarea-sm w-full font-mono" rows="8" bind:value={fContent}></textarea>
  </div>
  {#if formError}
    <div class="alert alert-error mt-3 text-sm">{formError}</div>
  {/if}
  <div class="flex justify-end mt-3">
    <button class="btn btn-primary btn-sm" disabled={saving || !fService.trim() || !fContent} onclick={handleSave}>
      {saving ? 'Saving...' : 'Save'}
    </button>
  </div>
</div>

{#if data.entries.length === 0}
  <div class="text-center py-12 text-base-content/40">
    <Icon name="data" class="w-12 h-12 mx-auto mb-3 opacity-30" />
    <p>No seeded download data.</p>
  </div>
{:else}
  <div class="overflow-x-auto bg-base-200 rounded-xl">
    <table class="table table-sm">
      <thead>
        <tr>
          <th class="w-8"></th>
          <th>Service</th>
          <th>Option</th>
          <th>Message</th>
          <th>Type</th>
          <th class="text-right">Size</th>
          <th>Created</th>
          <th class="w-28"></th>
        </tr>
      </thead>
      <tbody>
        {#each data.entries as entry (entry.id)}
          <tr class="hover:bg-base-300/50">
            <td>
              <button class="btn btn-ghost btn-xs px-1 text-base-content/40" aria-label="Toggle content" onclick={() => (expanded = expanded === entry.id ? null : entry.id)}>
                {expanded === entry.id ? '▾' : '▸'}
              </button>
            </td>
            <td class="font-mono">{entry.serviceName}</td>
            <td class="font-mono">{entry.serviceOption ?? 'any'}</td>
            <td class="font-mono">{entry.msgName ?? '-'}</td>
            <td class="font-mono text-xs">{entry.contentType}</td>
            <td class="text-right font-mono text-xs">{entry.content.length.toLocaleString('de-DE')} chars</td>
            <td class="text-xs">{formatSqliteDateTime(entry.createdAt)}</td>
            <td class="text-right">
              <button class="btn btn-ghost btn-xs" onclick={() => edit(entry)} title="Load into form">
                <Icon name="edit" class="w-3.5 h-3.5" />
              </button>
              <button class="btn btn-ghost btn-xs text-error" onclick={() => handleDelete(entry)} title="Delete">
                <Icon name="trash" class="w-3.5 h-3.5" />
              </button>
            </td>
          </tr>
          {#if expanded === entry.id}
            <tr class="bg-base-300/30">
              <td colspan="8" class="px-6 py-3">
                <pre class="text-xs whitespace-pre overflow-x-auto max-h-80">{entry.content}</pre>
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </div>
{/if}
