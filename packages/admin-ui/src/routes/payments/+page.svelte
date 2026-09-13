<script lang="ts">
  import { base } from '$app/paths';
  import { goto } from '$app/navigation';
  import Icon from '$lib/components/Icon.svelte';
  import type { PaymentOrder, PaymentOrderStatus, ServerFlags } from '$lib/types.js';
  import { PAYMENT_ORDER_STATUS, VOP_STATUS, formatCents, formatDateTime } from '$lib/payments.js';

  interface Props {
    data: { payments: PaymentOrder[]; flags: ServerFlags | null; status: PaymentOrderStatus | '' };
  }

  let { data }: Props = $props();

  const statuses = Object.keys(PAYMENT_ORDER_STATUS) as PaymentOrderStatus[];

  function handleFilter(e: Event) {
    const value = (e.currentTarget as HTMLSelectElement).value;
    goto(value ? `${base}/payments?status=${value}` : `${base}/payments`);
  }
</script>

<div class="flex items-center justify-between mb-6">
  <h1 class="text-2xl font-bold">Payment Orders</h1>
  <div class="flex items-center gap-2">
    <label for="statusFilter" class="text-xs text-base-content/50">Status</label>
    <select id="statusFilter" class="select select-bordered select-sm" value={data.status} onchange={handleFilter}>
      <option value="">All</option>
      {#each statuses as s}
        <option value={s}>{PAYMENT_ORDER_STATUS[s].label}</option>
      {/each}
    </select>
  </div>
</div>

{#if data.payments.length === 0}
  <div class="text-center py-16 text-base-content/40">
    <Icon name="payments" class="w-12 h-12 mx-auto mb-3 opacity-30" />
    <p class="text-lg">No payment orders{data.status ? ` with status ${PAYMENT_ORDER_STATUS[data.status].label}` : ''}</p>
    <p class="text-sm mt-1">Payment orders appear when a subscriber uploads a pain.001 file via BTU.</p>
  </div>
{:else}
  <div class="overflow-x-auto bg-base-200 rounded-xl">
    <table class="table table-sm">
      <thead>
        <tr>
          <th>Order ID</th>
          <th>Partner / User</th>
          <th>Service</th>
          <th>Message ID</th>
          <th>Debtor</th>
          <th class="text-right"># Tx</th>
          <th class="text-right">Total</th>
          <th>VoP</th>
          <th>Status</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {#each data.payments as payment (payment.id)}
          <tr class="hover:bg-base-300/50">
            <td>
              <a href="{base}/payments/{payment.id}" class="link link-hover font-mono font-medium">{payment.orderId}</a>
            </td>
            <td class="font-mono text-sm">{payment.partnerId} / {payment.userId}</td>
            <td class="font-mono text-xs">
              {payment.serviceName}{payment.serviceOption ? `/${payment.serviceOption}` : ''}
              <div class="text-base-content/50">{payment.msgName}</div>
            </td>
            <td class="font-mono text-xs max-w-[10rem] truncate" title={payment.msgId}>{payment.msgId}</td>
            <td class="text-sm">
              {payment.debtorName ?? '-'}
              {#if payment.debtorIban}
                <div class="font-mono text-xs text-base-content/50">{payment.debtorIban}</div>
              {/if}
            </td>
            <td class="text-right font-mono text-sm">{payment.transactions.length}</td>
            <td class="text-right font-mono font-medium whitespace-nowrap">
              {formatCents(payment.totalCents, payment.transactions[0]?.currency ?? 'EUR')}
            </td>
            <td>
              <span class="badge badge-sm {VOP_STATUS[payment.vopGroupStatus].badge}" title={payment.vopGroupStatus}>
                {VOP_STATUS[payment.vopGroupStatus].label}
              </span>
            </td>
            <td>
              <span class="badge badge-sm whitespace-nowrap {PAYMENT_ORDER_STATUS[payment.status].badge}">
                {PAYMENT_ORDER_STATUS[payment.status].label}
              </span>
            </td>
            <td class="text-xs whitespace-nowrap text-base-content/60">{formatDateTime(payment.createdAt)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
