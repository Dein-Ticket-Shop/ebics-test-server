<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { base } from '$app/paths';
  import Icon from '$lib/components/Icon.svelte';
  import { createHacEvent, getHacReportUrl, resetDeliveries } from '$lib/api.js';
  import type { HacEvent, ServerFlags, Subscriber } from '$lib/types.js';
  import { HAC_ACTIONS, hacActionBadge, formatDateTime, splitLines } from '$lib/payments.js';

  interface Props {
    data: { events: HacEvent[]; flags: ServerFlags | null; subscribers: Subscriber[]; partnerId: string };
  }

  let { data }: Props = $props();

  const partners = $derived([...new Set(data.subscribers.map((s) => s.partnerId))].sort());

  let expanded = $state<number | null>(null);

  function handlePartnerFilter(e: Event) {
    const value = (e.currentTarget as HTMLSelectElement).value;
    goto(value ? `${base}/hac?partnerId=${encodeURIComponent(value)}` : `${base}/hac`);
  }

  function previewReport() {
    if (!data.partnerId) return;
    window.open(getHacReportUrl(data.partnerId), '_blank');
  }

  async function handleRedeliver() {
    const scope = data.partnerId ? `partner ${data.partnerId}` : 'all partners';
    if (!confirm(`Mark all customer protocol events of ${scope} as not yet delivered? The next HAC download without DateRange returns them again.`)) return;
    try {
      const { reset } = await resetDeliveries({ partnerId: data.partnerId || undefined, kind: 'hac' });
      alert(`${reset} event(s) marked as not yet delivered.`);
      await invalidateAll();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Re-deliver failed');
    }
  }

  // Add event form
  let showForm = $state(false);
  let fPartnerId = $state('');
  let fUserId = $state('');
  let fOrderId = $state('');
  let fAction = $state<string>('ADDITIONAL');
  let fAdminOrderType = $state('BTU');
  let fServiceName = $state('');
  let fServiceOption = $state('');
  let fScope = $state('');
  let fContainerType = $state('');
  let fMsgName = $state('');
  let fOrderIdRef = $state('');
  let fAdminOrderTypeRef = $state('');
  let fReasonCode = $state('');
  let fInfo = $state('');
  let creating = $state(false);
  let formError = $state('');

  function openForm() {
    fPartnerId = data.partnerId;
    formError = '';
    showForm = true;
  }

  const opt = (v: string) => v.trim() || undefined;

  async function handleCreate() {
    if (!fPartnerId.trim() || !fAction || !fAdminOrderType.trim()) return;
    creating = true;
    formError = '';
    try {
      await createHacEvent({
        partnerId: fPartnerId.trim(),
        userId: opt(fUserId),
        orderId: opt(fOrderId),
        action: fAction,
        adminOrderType: fAdminOrderType.trim(),
        serviceName: opt(fServiceName),
        serviceOption: opt(fServiceOption),
        scope: opt(fScope),
        containerType: opt(fContainerType),
        msgName: opt(fMsgName),
        orderIdRef: opt(fOrderIdRef),
        adminOrderTypeRef: opt(fAdminOrderTypeRef),
        reasonCode: opt(fReasonCode),
        additionalInfo: splitLines(fInfo),
      });
      showForm = false;
      fUserId = fOrderId = fServiceName = fServiceOption = fScope = fContainerType = fMsgName = '';
      fOrderIdRef = fAdminOrderTypeRef = fReasonCode = fInfo = '';
      await invalidateAll();
    } catch (e) {
      formError = e instanceof Error ? e.message : 'Failed to add event';
    } finally {
      creating = false;
    }
  }

  function serviceLabel(ev: HacEvent): string {
    return [ev.serviceName, ev.scope, ev.serviceOption, ev.containerType, ev.msgName].filter(Boolean).join(' · ');
  }
</script>

<div class="flex items-center justify-between mb-6">
  <h1 class="text-2xl font-bold">Customer Protocol</h1>
  <div class="flex items-center gap-2">
    <label for="partnerFilter" class="text-xs text-base-content/50">Partner</label>
    <select id="partnerFilter" class="select select-bordered select-sm" value={data.partnerId} onchange={handlePartnerFilter}>
      <option value="">All</option>
      {#each partners as pid}
        <option value={pid}>{pid}</option>
      {/each}
      {#if data.partnerId && !partners.includes(data.partnerId)}
        <option value={data.partnerId}>{data.partnerId}</option>
      {/if}
    </select>
    <button class="btn btn-sm btn-outline gap-1.5" disabled={!data.partnerId} title={data.partnerId ? '' : 'Select a partner first'} onclick={previewReport}>
      <Icon name="download" class="w-3.5 h-3.5" /> Preview report
    </button>
    <button class="btn btn-sm btn-ghost" onclick={handleRedeliver}>Re-deliver all</button>
    <button class="btn btn-primary btn-sm gap-1.5" onclick={openForm}>
      <Icon name="plus" class="w-4 h-4" /> Add event
    </button>
  </div>
</div>

{#if data.flags?.hacFormat === 'legacy'}
  <div class="bg-info/10 border border-info/20 rounded-xl p-4 mb-6 text-sm">
    <div class="font-medium text-info mb-1">HAC downloads use the legacy format</div>
    HAC still returns the legacy <span class="font-mono">HACResponseOrderData</span> document. Set
    <span class="font-mono">EBICS_HAC_FORMAT=pain.002</span> to serve this ledger as a pain.002 customer protocol. The events below
    are recorded either way.
  </div>
{:else if data.flags?.hacFormat === 'pain.002'}
  <div class="bg-success/10 border border-success/20 rounded-xl p-4 mb-6 text-sm">
    HAC downloads return these events as a pain.002 customer protocol. Without a DateRange, only events not yet delivered are returned.
  </div>
{/if}

{#if showForm}
  <div class="bg-base-200 rounded-xl p-5 mb-6 ring-1 ring-primary/20">
    <h3 class="text-sm font-semibold mb-4">Add Protocol Event</h3>
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <div>
        <label for="fPartner" class="block text-xs text-base-content/60 mb-1">Partner ID *</label>
        <input id="fPartner" type="text" list="hacPartners" class="input input-bordered input-sm w-full font-mono" bind:value={fPartnerId} />
        <datalist id="hacPartners">
          {#each partners as pid}
            <option value={pid}></option>
          {/each}
        </datalist>
      </div>
      <div>
        <label for="fUser" class="block text-xs text-base-content/60 mb-1">User ID</label>
        <input id="fUser" type="text" class="input input-bordered input-sm w-full font-mono" bind:value={fUserId} />
      </div>
      <div>
        <label for="fOrder" class="block text-xs text-base-content/60 mb-1">Order ID</label>
        <input id="fOrder" type="text" class="input input-bordered input-sm w-full font-mono" bind:value={fOrderId} placeholder="allocated automatically" maxlength="4" />
      </div>
      <div>
        <label for="fAction" class="block text-xs text-base-content/60 mb-1">Action *</label>
        <select id="fAction" class="select select-bordered select-sm w-full font-mono" bind:value={fAction}>
          {#each HAC_ACTIONS as action}
            <option value={action}>{action}</option>
          {/each}
        </select>
      </div>
      <div>
        <label for="fAot" class="block text-xs text-base-content/60 mb-1">Admin order type *</label>
        <input id="fAot" type="text" class="input input-bordered input-sm w-full font-mono" bind:value={fAdminOrderType} />
      </div>
      <div>
        <label for="fService" class="block text-xs text-base-content/60 mb-1">Service name</label>
        <input id="fService" type="text" class="input input-bordered input-sm w-full font-mono" bind:value={fServiceName} placeholder="SCI" />
      </div>
      <div>
        <label for="fOption" class="block text-xs text-base-content/60 mb-1">Service option</label>
        <input id="fOption" type="text" class="input input-bordered input-sm w-full font-mono" bind:value={fServiceOption} />
      </div>
      <div>
        <label for="fScope" class="block text-xs text-base-content/60 mb-1">Scope</label>
        <input id="fScope" type="text" class="input input-bordered input-sm w-full font-mono" bind:value={fScope} placeholder="DE" />
      </div>
      <div>
        <label for="fContainer" class="block text-xs text-base-content/60 mb-1">Container type</label>
        <input id="fContainer" type="text" class="input input-bordered input-sm w-full font-mono" bind:value={fContainerType} />
      </div>
      <div>
        <label for="fMsg" class="block text-xs text-base-content/60 mb-1">Message name</label>
        <input id="fMsg" type="text" class="input input-bordered input-sm w-full font-mono" bind:value={fMsgName} placeholder="pain.001" />
      </div>
      <div>
        <label for="fRef" class="block text-xs text-base-content/60 mb-1">Order ID ref</label>
        <input id="fRef" type="text" class="input input-bordered input-sm w-full font-mono" bind:value={fOrderIdRef} maxlength="4" />
      </div>
      <div>
        <label for="fAotRef" class="block text-xs text-base-content/60 mb-1">Admin order type ref</label>
        <input id="fAotRef" type="text" class="input input-bordered input-sm w-full font-mono" bind:value={fAdminOrderTypeRef} />
      </div>
      <div>
        <label for="fReason" class="block text-xs text-base-content/60 mb-1">Reason code</label>
        <input id="fReason" type="text" class="input input-bordered input-sm w-full font-mono" bind:value={fReasonCode} placeholder="DS01" />
      </div>
    </div>
    <div class="mt-3">
      <label for="fInfo" class="block text-xs text-base-content/60 mb-1">Additional info (one entry per line)</label>
      <textarea id="fInfo" class="textarea textarea-bordered textarea-sm w-full font-mono" rows="4" bind:value={fInfo}></textarea>
    </div>
    {#if formError}
      <div class="alert alert-error mt-3 text-sm">{formError}</div>
    {/if}
    <div class="flex gap-2 mt-4 justify-end border-t border-base-300 pt-4">
      <button class="btn btn-ghost btn-sm" onclick={() => (showForm = false)}>Cancel</button>
      <button
        class="btn btn-primary btn-sm"
        disabled={creating || !fPartnerId.trim() || !fAdminOrderType.trim()}
        onclick={handleCreate}
      >
        {creating ? 'Adding...' : 'Add Event'}
      </button>
    </div>
  </div>
{/if}

{#if data.events.length === 0}
  <div class="text-center py-16 text-base-content/40">
    <Icon name="hac" class="w-12 h-12 mx-auto mb-3 opacity-30" />
    <p class="text-lg">No protocol events{data.partnerId ? ` for ${data.partnerId}` : ''}</p>
    <p class="text-sm mt-1">Events are recorded for key initialisation, uploads and VEU actions.</p>
  </div>
{:else}
  <div class="overflow-x-auto bg-base-200 rounded-xl">
    <table class="table table-sm">
      <thead>
        <tr>
          <th class="w-8"></th>
          <th>Time</th>
          <th>Partner / User</th>
          <th>Order ID</th>
          <th>Action</th>
          <th>Order Type / Service</th>
          <th>Ref</th>
          <th>Reason</th>
          <th>Delivered</th>
        </tr>
      </thead>
      <tbody>
        {#each data.events as ev (ev.id)}
          <tr class="hover:bg-base-300/50">
            <td>
              {#if ev.additionalInfo.length > 0}
                <button
                  class="btn btn-ghost btn-xs px-1 text-base-content/40"
                  aria-label="Toggle additional info"
                  onclick={() => (expanded = expanded === ev.id ? null : ev.id)}
                >
                  {expanded === ev.id ? '▾' : '▸'}
                </button>
              {/if}
            </td>
            <td class="text-xs whitespace-nowrap">{formatDateTime(ev.eventAt)}</td>
            <td class="font-mono text-sm whitespace-nowrap">{ev.partnerId}{ev.userId ? ` / ${ev.userId}` : ''}</td>
            <td class="font-mono text-sm">{ev.orderId}</td>
            <td><span class="badge badge-sm font-mono whitespace-nowrap {hacActionBadge(ev.action)}">{ev.action}</span></td>
            <td class="font-mono text-xs">
              {ev.adminOrderType}
              {#if serviceLabel(ev)}
                <div class="text-base-content/50">{serviceLabel(ev)}</div>
              {/if}
            </td>
            <td class="font-mono text-xs">
              {#if ev.orderIdRef}
                {ev.orderIdRef}{ev.adminOrderTypeRef ? ` (${ev.adminOrderTypeRef})` : ''}
              {:else}
                <span class="text-base-content/30">-</span>
              {/if}
            </td>
            <td class="font-mono text-xs">{ev.reasonCode ?? '-'}</td>
            <td>
              <span class="badge badge-xs {ev.delivered ? 'badge-success' : 'badge-ghost'}">{ev.delivered ? 'Yes' : 'No'}</span>
            </td>
          </tr>
          {#if expanded === ev.id}
            <tr class="bg-base-300/30">
              <td colspan="9" class="px-6 py-3">
                <pre class="text-xs whitespace-pre overflow-x-auto">{ev.additionalInfo.join('\n')}</pre>
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </div>
{/if}
