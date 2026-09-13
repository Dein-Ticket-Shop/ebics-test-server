<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { base } from '$app/paths';
  import Icon from '$lib/components/Icon.svelte';
  import { cancelVeuOrder, signVeuOrder } from '$lib/api.js';
  import type { ServerFlags, Subscriber, VeuOrder } from '$lib/types.js';
  import { VOP_STATUS, apiErrorMessage, formatCents, formatDateTime, splitLines } from '$lib/payments.js';

  interface Props {
    data: { orders: VeuOrder[]; flags: ServerFlags | null; subscribers: Subscriber[]; partnerId: string };
  }

  let { data }: Props = $props();

  const partners = $derived([...new Set(data.subscribers.map((s) => s.partnerId))].sort());

  let signAs = $state<Record<string, string>>({});
  let cancelAs = $state<Record<string, string>>({});
  let cancelReason = $state<Record<string, string>>({});
  let errors = $state<Record<string, string>>({});
  let busy = $state<string | null>(null);
  let notice = $state('');

  const key = (o: VeuOrder) => `${o.partnerId}|${o.orderId}`;
  const usersOf = (o: VeuOrder) => data.subscribers.filter((s) => s.partnerId === o.partnerId);
  const hasSigned = (o: VeuOrder, userId: string) => o.signatures.some((s) => s.userId === userId);
  const confirmationPending = (o: VeuOrder) => o.vopConfirmationRequired && !o.vopConfirmed;
  const canSign = (o: VeuOrder, userId: string) => !hasSigned(o, userId) || confirmationPending(o);

  function signer(o: VeuOrder): string {
    return signAs[key(o)] ?? usersOf(o).find((u) => canSign(o, u.userId))?.userId ?? '';
  }

  function canceller(o: VeuOrder): string {
    return cancelAs[key(o)] ?? usersOf(o)[0]?.userId ?? '';
  }

  function handlePartnerFilter(e: Event) {
    const value = (e.currentTarget as HTMLSelectElement).value;
    goto(value ? `${base}/veu?partnerId=${encodeURIComponent(value)}` : `${base}/veu`);
  }

  async function handleSign(o: VeuOrder) {
    const k = key(o);
    const userId = signer(o);
    if (!userId) return;
    busy = k;
    errors[k] = '';
    notice = '';
    try {
      const result = await signVeuOrder(o.partnerId, o.orderId, userId);
      notice = result.released
        ? `${userId} signed order ${o.orderId} (HVE ${result.orderId}). The order was released and its payments are booked.`
        : `${userId} signed order ${o.orderId} (HVE ${result.orderId}).${result.order ? ` Signatures ${result.order.signaturesDone} of ${result.order.numSigRequired}.` : ''}`;
      delete signAs[k];
      await invalidateAll();
    } catch (e) {
      errors[k] = apiErrorMessage(e, 'Signing failed');
    } finally {
      busy = null;
    }
  }

  async function handleCancel(o: VeuOrder) {
    const k = key(o);
    const userId = canceller(o);
    if (!userId) return;
    if (!confirm(`Cancel order ${o.orderId} as ${userId}? No payment is booked.`)) return;
    busy = k;
    errors[k] = '';
    notice = '';
    try {
      const result = await cancelVeuOrder(o.partnerId, o.orderId, {
        userId,
        additionalInfo: splitLines(cancelReason[k] ?? ''),
      });
      notice = `${userId} cancelled order ${o.orderId} (HVS ${result.orderId}). No payment was booked.`;
      await invalidateAll();
    } catch (e) {
      errors[k] = apiErrorMessage(e, 'Cancellation failed');
    } finally {
      busy = null;
    }
  }
</script>

<div class="flex items-center justify-between mb-6">
  <h1 class="text-2xl font-bold">VEU <span class="text-base-content/40 font-normal text-base">Distributed electronic signature</span></h1>
  <div class="flex items-center gap-2">
    <label for="veuPartner" class="text-xs text-base-content/50">Partner</label>
    <select id="veuPartner" class="select select-bordered select-sm" value={data.partnerId} onchange={handlePartnerFilter}>
      <option value="">All</option>
      {#each partners as pid}
        <option value={pid}>{pid}</option>
      {/each}
      {#if data.partnerId && !partners.includes(data.partnerId)}
        <option value={data.partnerId}>{data.partnerId}</option>
      {/if}
    </select>
  </div>
</div>

<div class="bg-info/10 border border-info/20 rounded-xl p-4 mb-6 text-sm">
  <div class="font-medium text-info mb-1">When orders wait here</div>
  <ul class="list-disc ml-5 space-y-1">
    <li>
      <span class="font-mono">EBICS_EDS_HOLD=true</span> and the upload requested EDS: a second user has to sign.
      <span class="badge badge-xs {data.flags?.edsHold ? 'badge-success' : 'badge-ghost'}">{data.flags?.edsHold ? 'on' : 'off'}</span>
    </li>
    <li>
      <span class="font-mono">EBICS_VOP_CONFIRMATION=true</span> and the VoP result is not RCVC: one signature confirms it.
      <span class="badge badge-xs {data.flags?.vopConfirmation ? 'badge-success' : 'badge-ghost'}">{data.flags?.vopConfirmation ? 'on' : 'off'}</span>
    </li>
  </ul>
  <div class="text-base-content/60 mt-2">Signing or cancelling here does the same as the EBICS orders HVE and HVS of that user.</div>
</div>

{#if notice}
  <div class="alert alert-success mb-6 text-sm flex justify-between">
    <span>{notice}</span>
    <button class="btn btn-ghost btn-xs" onclick={() => (notice = '')}>Dismiss</button>
  </div>
{/if}

{#if data.orders.length === 0}
  <div class="text-center py-16 text-base-content/40">
    <Icon name="veu" class="w-12 h-12 mx-auto mb-3 opacity-30" />
    <p class="text-lg">No orders waiting for signatures{data.partnerId ? ` for ${data.partnerId}` : ''}</p>
    <p class="text-sm mt-1">Orders held in the VEU appear here until they are signed, cancelled or rejected.</p>
  </div>
{:else}
  <div class="space-y-4">
    {#each data.orders as o (key(o))}
      {@const k = key(o)}
      {@const users = usersOf(o)}
      <div class="bg-base-200 rounded-xl p-5">
        <div class="flex items-start justify-between gap-4 mb-4">
          <div>
            <div class="flex items-center gap-2 flex-wrap">
              <h2 class="text-lg font-bold font-mono">{o.partnerId} / {o.orderId}</h2>
              <span class="badge badge-outline badge-sm {VOP_STATUS[o.vopGroupStatus].badge}" title={o.vopGroupStatus}>
                VoP: {VOP_STATUS[o.vopGroupStatus].label}
              </span>
              {#if confirmationPending(o)}
                <span class="badge badge-warning badge-sm">VoP confirmation pending</span>
              {/if}
              {#if o.releasable}
                <span class="badge badge-success badge-sm">Releasable</span>
              {/if}
            </div>
            <div class="text-sm text-base-content/50 mt-1 font-mono">
              {o.serviceName}{o.serviceOption ? `/${o.serviceOption}` : ''} · {o.msgName}
            </div>
            <div class="text-xs text-base-content/40 mt-0.5">
              MsgId <span class="font-mono" title={o.msgId}>{o.msgId}</span> · created {formatDateTime(o.createdAt)} by
              <span class="font-mono">{o.originatorUserId}</span>
            </div>
          </div>
          <div class="text-right shrink-0">
            <div class="text-xs text-base-content/50">Total</div>
            <div class="font-mono text-xl font-bold">{formatCents(o.totalCents, o.currency)}</div>
            <a href="{base}/payments/{o.paymentOrderIds[0]}" class="link link-hover text-xs">Payment order</a>
          </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4 text-sm">
          <div>
            <div class="text-[11px] text-base-content/40 uppercase tracking-wide">Debtor</div>
            <div class="mt-0.5">{o.debtorName ?? '-'}</div>
            <div class="font-mono text-xs text-base-content/60">{o.debtorIban ?? ''}</div>
          </div>
          <div>
            <div class="text-[11px] text-base-content/40 uppercase tracking-wide">Signatures</div>
            <div class="flex items-center gap-2 mt-1">
              <progress class="progress progress-warning w-24" value={o.signaturesDone} max={o.numSigRequired}></progress>
              <span>Signatures {o.signaturesDone} of {o.numSigRequired}</span>
            </div>
          </div>
          <div>
            <div class="text-[11px] text-base-content/40 uppercase tracking-wide">Signed by</div>
            {#each o.signatures as sig (sig.id)}
              <div class="text-xs mt-0.5">
                <span class="font-mono">{sig.userId}</span>
                <span class="badge badge-ghost badge-xs">{sig.kind}</span>
                <span class="text-base-content/50">{formatDateTime(sig.signedAt)}</span>
              </div>
            {:else}
              <div class="text-xs text-base-content/40 mt-0.5">No signatures yet</div>
            {/each}
          </div>
        </div>

        <div class="overflow-x-auto bg-base-100 rounded-lg mb-4">
          <table class="table table-xs">
            <thead>
              <tr>
                <th>E2E ID</th>
                <th>Creditor</th>
                <th>IBAN</th>
                <th class="text-right">Amount</th>
                <th>VoP</th>
              </tr>
            </thead>
            <tbody>
              {#each o.transactions as tx (tx.id)}
                <tr>
                  <td class="font-mono text-xs max-w-[10rem] truncate" title={tx.endToEndId}>{tx.endToEndId ?? '-'}</td>
                  <td class="text-xs">{tx.creditorName ?? '-'}</td>
                  <td class="font-mono text-xs">{tx.creditorIban ?? '-'}</td>
                  <td class="text-right font-mono text-xs">{formatCents(tx.amountCents, tx.currency)}</td>
                  <td class="text-xs">
                    <span class="badge badge-xs {VOP_STATUS[tx.vopStatus].badge}">{VOP_STATUS[tx.vopStatus].label}</span>
                    {#if tx.vopCorrectedName}
                      <span class="text-base-content/60">{tx.vopCorrectedName}</span>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>

        <div class="flex flex-wrap items-end gap-6 border-t border-base-300 pt-4">
          <div class="flex items-end gap-2">
            <div>
              <label for="sign-{k}" class="block text-xs text-base-content/60 mb-1">Sign as</label>
              <select
                id="sign-{k}"
                class="select select-bordered select-sm font-mono"
                value={signer(o)}
                onchange={(e) => (signAs[k] = (e.currentTarget as HTMLSelectElement).value)}
              >
                {#each users as user (user.userId)}
                  <option value={user.userId} disabled={!canSign(o, user.userId)}>
                    {user.userId}{hasSigned(o, user.userId) ? ' (signed)' : ''}
                  </option>
                {/each}
              </select>
            </div>
            <button class="btn btn-success btn-sm" disabled={busy === k || !signer(o)} onclick={() => handleSign(o)}>
              {busy === k ? '...' : 'Sign'}
            </button>
          </div>

          <div class="flex items-end gap-2 flex-1 min-w-[18rem]">
            <div>
              <label for="cancel-{k}" class="block text-xs text-base-content/60 mb-1">Cancel as</label>
              <select
                id="cancel-{k}"
                class="select select-bordered select-sm font-mono"
                value={canceller(o)}
                onchange={(e) => (cancelAs[k] = (e.currentTarget as HTMLSelectElement).value)}
              >
                {#each users as user (user.userId)}
                  <option value={user.userId}>{user.userId}</option>
                {/each}
              </select>
            </div>
            <div class="flex-1">
              <label for="reason-{k}" class="block text-xs text-base-content/60 mb-1">Reason (optional, one line per entry)</label>
              <textarea
                id="reason-{k}"
                class="textarea textarea-bordered textarea-sm w-full"
                rows="1"
                value={cancelReason[k] ?? ''}
                oninput={(e) => (cancelReason[k] = (e.currentTarget as HTMLTextAreaElement).value)}
              ></textarea>
            </div>
            <button class="btn btn-warning btn-sm" disabled={busy === k || !canceller(o)} onclick={() => handleCancel(o)}>
              Cancel order
            </button>
          </div>
        </div>

        {#if users.length === 0}
          <div class="text-xs text-warning mt-2">Partner {o.partnerId} has no subscribers to sign or cancel with.</div>
        {/if}
        {#if errors[k]}
          <div class="alert alert-error mt-3 text-sm">{errors[k]}</div>
        {/if}
      </div>
    {/each}
  </div>
{/if}
