<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { base } from '$app/paths';
  import Icon from '$lib/components/Icon.svelte';
  import {
    releasePayment,
    cancelPayment,
    rejectPayment,
    addPaymentStatusEvent,
    overrideTransactionVop,
    getPaymentStatusReportUrl,
    getPaymentVopReportUrl,
  } from '$lib/api.js';
  import type { HacEvent, PaymentOrder, PaymentStatusCode, PaymentTransaction, VopStatus } from '$lib/types.js';
  import {
    PAYMENT_ORDER_STATUS,
    VOP_STATUS,
    PAYMENT_STATUS_CODES,
    paymentStatusCodeBadge,
    hacActionBadge,
    formatCents,
    formatDateTime,
    splitLines,
  } from '$lib/payments.js';

  interface Props {
    data: { payment: PaymentOrder; hacEvents: HacEvent[] };
  }

  let { data }: Props = $props();

  const p = $derived(data.payment);
  const currency = $derived(p.transactions[0]?.currency ?? 'EUR');
  const vopStatuses = Object.keys(VOP_STATUS) as VopStatus[];

  let busy = $state(false);

  async function run(action: () => Promise<unknown>, failure: string) {
    busy = true;
    try {
      await action();
      await invalidateAll();
    } catch (e) {
      alert(e instanceof Error ? e.message : failure);
    } finally {
      busy = false;
    }
  }

  function handleRelease() {
    if (!confirm(`Release order ${p.orderId}? Its payments are booked and the order completes.`)) return;
    run(() => releasePayment(p.id), 'Release failed');
  }

  function handleCancel() {
    if (!confirm(`Cancel order ${p.orderId} in the VEU? No payment is booked.`)) return;
    run(() => cancelPayment(p.id), 'Cancel failed');
  }

  function handleReject() {
    const reason = prompt(`Reject order ${p.orderId}. Optional reason code (leave empty for none):`, '');
    if (reason === null) return;
    run(() => rejectPayment(p.id, { reasonCode: reason.trim() || undefined }), 'Reject failed');
  }

  function openReport(url: string) {
    window.open(url, '_blank');
  }

  // VoP override
  let vopTxId = $state<number | null>(null);
  let vopStatus = $state<VopStatus>('RCVC');
  let vopName = $state('');

  function startVop(tx: PaymentTransaction) {
    vopTxId = tx.id;
    vopStatus = tx.vopStatus;
    vopName = tx.vopCorrectedName ?? '';
  }

  function saveVop() {
    const txId = vopTxId;
    if (txId === null) return;
    run(async () => {
      await overrideTransactionVop(p.id, txId, {
        status: vopStatus,
        correctedName: vopStatus === 'RVMC' ? vopName.trim() : undefined,
      });
      vopTxId = null;
    }, 'VoP override failed');
  }

  // Payment status event
  let showStatusForm = $state(false);
  let evStatus = $state<PaymentStatusCode>('ACSC');
  let evReason = $state('');
  let evInfo = $state('');

  function saveStatusEvent() {
    run(async () => {
      await addPaymentStatusEvent(p.id, {
        status: evStatus,
        reasonCode: evReason.trim() || undefined,
        additionalInfo: splitLines(evInfo),
      });
      showStatusForm = false;
      evReason = '';
      evInfo = '';
    }, 'Adding status event failed');
  }
</script>

<div class="mb-6">
  <a href="{base}/payments" class="text-sm text-base-content/50 hover:text-base-content inline-flex items-center gap-1">
    <Icon name="chevronLeft" class="w-3.5 h-3.5" /> Payment Orders
  </a>
</div>

<div class="flex items-start justify-between mb-6">
  <div>
    <h1 class="text-2xl font-bold font-mono">Order {p.orderId}</h1>
    <div class="flex items-center gap-3 mt-2">
      <span class="badge {PAYMENT_ORDER_STATUS[p.status].badge}">{PAYMENT_ORDER_STATUS[p.status].label}</span>
      <span class="badge badge-outline badge-sm {VOP_STATUS[p.vopGroupStatus].badge}" title={p.vopGroupStatus}>
        VoP: {VOP_STATUS[p.vopGroupStatus].label}
      </span>
      {#if p.requestedEds}
        <span class="badge badge-outline badge-sm">EDS requested</span>
      {/if}
      <span class="text-sm text-base-content/50">Created {formatDateTime(p.createdAt)}</span>
      <span class="text-sm text-base-content/30">|</span>
      <span class="text-sm text-base-content/50">Updated {formatDateTime(p.updatedAt)}</span>
    </div>
  </div>
  <div class="flex items-start gap-4">
    <div class="text-right">
      <div class="text-xs text-base-content/50">Total</div>
      <div class="font-mono text-2xl font-bold">{formatCents(p.totalCents, currency)}</div>
    </div>
  </div>
</div>

{#if p.status === 'PENDING_EDS'}
  <div class="bg-warning/10 border border-warning/20 rounded-xl p-4 mb-6 text-sm flex items-center justify-between gap-4">
    <div>
      <div class="font-medium text-warning mb-1">Awaiting electronic distributed signature</div>
      <ul class="list-disc ml-5 mb-1">
        <li>Waiting for electronic signatures (HVE) of users with signature class E, A or B</li>
        {#if p.vopConfirmationRequired}
          <li>Waiting for VoP confirmation</li>
        {/if}
      </ul>
      The order is held in the VEU. Release books the payments; cancel or reject completes it without booking.
      <a href="{base}/veu?partnerId={encodeURIComponent(p.partnerId)}" class="link link-hover font-medium ml-1">Open in VEU</a>
    </div>
    <div class="flex gap-2 shrink-0">
      <button class="btn btn-success btn-sm" disabled={busy} onclick={handleRelease}>Release</button>
      <button class="btn btn-warning btn-sm" disabled={busy} onclick={handleCancel}>Cancel in VEU</button>
      <button class="btn btn-error btn-sm" disabled={busy} onclick={handleReject}>Reject</button>
    </div>
  </div>
{/if}

<div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
  <div class="bg-base-200 rounded-xl p-4">
    <h2 class="text-sm font-semibold mb-3">Order</h2>
    <div class="grid grid-cols-2 gap-4 text-sm">
      <div>
        <div class="text-[11px] text-base-content/40 uppercase tracking-wide">Partner / User</div>
        <div class="font-mono mt-0.5">{p.partnerId} / {p.userId}</div>
      </div>
      <div>
        <div class="text-[11px] text-base-content/40 uppercase tracking-wide">Service</div>
        <div class="font-mono mt-0.5">
          {p.serviceName}{p.serviceOption ? `/${p.serviceOption}` : ''} · {p.msgName}
        </div>
      </div>
      <div class="col-span-2">
        <div class="text-[11px] text-base-content/40 uppercase tracking-wide">Message ID (Datei-ID)</div>
        <div class="font-mono mt-0.5 text-xs break-all">{p.msgId}</div>
      </div>
      <div class="col-span-2">
        <div class="text-[11px] text-base-content/40 uppercase tracking-wide">PmtInfId (Sammlerreferenz)</div>
        <div class="font-mono mt-0.5 text-xs break-all">{p.pmtInfId}</div>
      </div>
      {#if p.uploadedOrderId !== undefined}
        <div>
          <div class="text-[11px] text-base-content/40 uppercase tracking-wide">Uploaded Order</div>
          <div class="font-mono mt-0.5">#{p.uploadedOrderId}</div>
        </div>
      {/if}
    </div>
  </div>

  <div class="bg-base-200 rounded-xl p-4">
    <h2 class="text-sm font-semibold mb-3">Debtor</h2>
    <div class="grid grid-cols-2 gap-4 text-sm">
      <div>
        <div class="text-[11px] text-base-content/40 uppercase tracking-wide">Name</div>
        <div class="mt-0.5">{p.debtorName ?? '-'}</div>
      </div>
      <div>
        <div class="text-[11px] text-base-content/40 uppercase tracking-wide">IBAN</div>
        <div class="font-mono mt-0.5 text-xs">{p.debtorIban ?? '-'}</div>
      </div>
    </div>
    <h2 class="text-sm font-semibold mt-5 mb-2">Reports</h2>
    <p class="text-xs text-base-content/40 mb-3">pain.002 documents as delivered via BTD.</p>
    <div class="flex gap-2">
      <button class="btn btn-xs btn-outline gap-1.5" onclick={() => openReport(getPaymentStatusReportUrl(p.id))}>
        <Icon name="download" class="w-3.5 h-3.5" /> Payment status report
      </button>
      <button class="btn btn-xs btn-outline gap-1.5" onclick={() => openReport(getPaymentVopReportUrl(p.id))}>
        <Icon name="download" class="w-3.5 h-3.5" /> VoP report
      </button>
    </div>
  </div>
</div>

<!-- Transactions -->
<h2 class="text-lg font-semibold mb-4">
  Transactions <span class="text-base-content/40 font-normal text-sm">({p.transactions.length})</span>
</h2>

<div class="overflow-x-auto bg-base-200 rounded-xl mb-6">
  <table class="table table-sm">
    <thead>
      <tr>
        <th>End-to-End ID</th>
        <th>Creditor</th>
        <th class="text-right">Amount</th>
        <th>Remittance Info</th>
        <th>Bookings</th>
        <th>VoP</th>
        <th class="w-20"></th>
      </tr>
    </thead>
    <tbody>
      {#each p.transactions as tx (tx.id)}
        <tr>
          <td class="font-mono text-xs max-w-[10rem] truncate" title={tx.endToEndId}>{tx.endToEndId ?? '-'}</td>
          <td class="text-sm">
            {tx.creditorName ?? '-'}
            {#if tx.creditorIban}
              <div class="font-mono text-xs text-base-content/50">{tx.creditorIban}{tx.creditorBic ? ` · ${tx.creditorBic}` : ''}</div>
            {/if}
          </td>
          <td class="text-right font-mono font-medium whitespace-nowrap">{formatCents(tx.amountCents, tx.currency)}</td>
          <td class="text-sm text-base-content/60 max-w-xs truncate" title={tx.remittanceInfo}>{tx.remittanceInfo ?? '-'}</td>
          <td class="font-mono text-xs whitespace-nowrap">
            {#if tx.debitBookingId === undefined && tx.creditBookingId === undefined}
              <span class="text-base-content/30">-</span>
            {:else}
              {#if tx.debitBookingId !== undefined}<div>Debit #{tx.debitBookingId}</div>{/if}
              {#if tx.creditBookingId !== undefined}<div>Credit #{tx.creditBookingId}</div>{/if}
            {/if}
          </td>
          <td>
            <span class="badge badge-sm whitespace-nowrap {VOP_STATUS[tx.vopStatus].badge}" title={tx.vopStatus}>
              {VOP_STATUS[tx.vopStatus].label}
            </span>
            {#if tx.vopStatus === 'RVMC' && tx.vopCorrectedName}
              <div class="text-xs text-base-content/60 mt-0.5">{tx.vopCorrectedName}</div>
            {/if}
          </td>
          <td>
            <button class="btn btn-ghost btn-xs gap-1" onclick={() => (vopTxId === tx.id ? (vopTxId = null) : startVop(tx))}>
              <Icon name="edit" class="w-3.5 h-3.5" /> VoP
            </button>
          </td>
        </tr>
        {#if vopTxId === tx.id}
          <tr class="bg-base-300/30">
            <td colspan="7" class="px-6 py-3">
              <div class="flex gap-3 items-end">
                <div>
                  <label for="vopStatus-{tx.id}" class="block text-xs text-base-content/60 mb-1">VoP result</label>
                  <select id="vopStatus-{tx.id}" class="select select-bordered select-sm" bind:value={vopStatus}>
                    {#each vopStatuses as s}
                      <option value={s}>{s} · {VOP_STATUS[s].label}</option>
                    {/each}
                  </select>
                </div>
                {#if vopStatus === 'RVMC'}
                  <div class="flex-1">
                    <label for="vopName-{tx.id}" class="block text-xs text-base-content/60 mb-1">Corrected name *</label>
                    <input id="vopName-{tx.id}" type="text" class="input input-bordered input-sm w-full" bind:value={vopName} />
                  </div>
                {/if}
                <button
                  class="btn btn-primary btn-sm"
                  disabled={busy || (vopStatus === 'RVMC' && !vopName.trim())}
                  onclick={saveVop}
                >
                  Save
                </button>
                <button class="btn btn-ghost btn-sm" onclick={() => (vopTxId = null)}>Cancel</button>
              </div>
            </td>
          </tr>
        {/if}
      {/each}
    </tbody>
  </table>
</div>

<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
  <!-- Payment status timeline -->
  <div class="bg-base-200 rounded-xl p-4">
    <div class="flex items-center justify-between mb-3">
      <h2 class="text-sm font-semibold">Payment Status (pain.002)</h2>
      <button class="btn btn-xs btn-outline gap-1" onclick={() => (showStatusForm = !showStatusForm)}>
        <Icon name="plus" class="w-3.5 h-3.5" /> Add status
      </button>
    </div>

    {#if showStatusForm}
      <div class="bg-base-100 rounded-lg p-3 mb-3">
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label for="evStatus" class="block text-xs text-base-content/60 mb-1">Status</label>
            <select id="evStatus" class="select select-bordered select-sm w-full" bind:value={evStatus}>
              {#each PAYMENT_STATUS_CODES as c}
                <option value={c.code}>{c.code} · {c.label}</option>
              {/each}
            </select>
          </div>
          <div>
            <label for="evReason" class="block text-xs text-base-content/60 mb-1">Reason code</label>
            <input id="evReason" type="text" class="input input-bordered input-sm w-full font-mono" bind:value={evReason} placeholder="AM04" />
          </div>
        </div>
        <div class="mt-3">
          <label for="evInfo" class="block text-xs text-base-content/60 mb-1">Additional info (one entry per line)</label>
          <textarea id="evInfo" class="textarea textarea-bordered textarea-sm w-full font-mono" rows="3" bind:value={evInfo}></textarea>
        </div>
        <div class="flex gap-2 justify-end mt-3">
          <button class="btn btn-ghost btn-sm" onclick={() => (showStatusForm = false)}>Cancel</button>
          <button class="btn btn-primary btn-sm" disabled={busy} onclick={saveStatusEvent}>Add</button>
        </div>
      </div>
    {/if}

    {#if p.statusEvents.length === 0}
      <p class="text-xs text-base-content/40 italic">No status events yet.</p>
    {:else}
      <ul class="space-y-2">
        {#each p.statusEvents as ev (ev.id)}
          <li class="flex gap-3 text-sm">
            <span class="badge badge-sm font-mono {paymentStatusCodeBadge(ev.status)}">{ev.status}</span>
            <div class="flex-1 min-w-0">
              <div class="text-xs text-base-content/50">
                {formatDateTime(ev.createdAt)}
                {#if ev.reasonCode}<span class="ml-2 font-mono">Reason {ev.reasonCode}</span>{/if}
              </div>
              {#if ev.additionalInfo.length > 0}
                <pre class="text-xs mt-1 whitespace-pre-wrap">{ev.additionalInfo.join('\n')}</pre>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <!-- HAC events -->
  <div class="bg-base-200 rounded-xl p-4">
    <div class="flex items-center justify-between mb-3">
      <h2 class="text-sm font-semibold">Customer Protocol (HAC)</h2>
      <a href="{base}/hac?partnerId={encodeURIComponent(p.partnerId)}" class="text-xs link link-hover text-base-content/50">All events</a>
    </div>
    {#if data.hacEvents.length === 0}
      <p class="text-xs text-base-content/40 italic">No protocol events for this order.</p>
    {:else}
      <ul class="space-y-3">
        {#each data.hacEvents as ev (ev.id)}
          <li class="text-sm">
            <div class="flex flex-wrap items-center gap-2">
              <span class="badge badge-sm font-mono {hacActionBadge(ev.action)}">{ev.action}</span>
              {#if ev.reasonCode}<span class="badge badge-outline badge-xs font-mono">{ev.reasonCode}</span>{/if}
              {#if ev.orderIdRef}
                <span class="text-xs text-base-content/60">
                  ref <span class="font-mono">{ev.orderIdRef}</span>{ev.adminOrderTypeRef ? ` (${ev.adminOrderTypeRef})` : ''}
                </span>
              {/if}
              <span class="text-xs text-base-content/50">{formatDateTime(ev.eventAt)}</span>
            </div>
            {#if ev.additionalInfo.length > 0}
              <pre class="text-xs mt-1 bg-base-100 rounded p-2 overflow-x-auto">{ev.additionalInfo.join('\n')}</pre>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>
