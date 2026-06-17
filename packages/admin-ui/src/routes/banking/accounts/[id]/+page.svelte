<script lang="ts">
  import { untrack } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import { base } from '$app/paths';
  import {
    createBooking,
    getStatementUrl,
    listAccountsForPartner,
    grantAccountAccess,
    revokeAccountAccess,
  } from '$lib/api.js';
  import Icon from '$lib/components/Icon.svelte';
  import type { Account, Person, Booking, Subscriber } from '$lib/types.js';

  interface Props {
    data: {
      account: Account;
      bookings: Booking[];
      person: Person;
      subscribers: Subscriber[];
    };
  }

  let { data }: Props = $props();

  // Booking form
  let showBookingForm = $state(false);
  let bkAmountEur = $state('');
  let bkDate = $state(new Date().toISOString().slice(0, 10));
  let bkCounterpartyName = $state('');
  let bkCounterpartyIban = $state('');
  let bkCounterpartyBic = $state('');
  let bkRemittance = $state('');
  let bkEndToEndId = $state('');
  let bkCode = $state('NTRF');
  let bkCreating = $state(false);
  let bkError = $state('');

  // Partner access
  let partnerAccess = $state<Record<string, number[]>>({});
  let loadingAccess = $state(true);
  let grantPartnerId = $state('');

  // Statement
  let stmtFormat = $state<'camt.053' | 'mt940'>('camt.053');

  // Booking detail expand
  let expandedBooking = $state<number | null>(null);

  function formatCents(cents: number, cur: string): string {
    return (cents / 100).toLocaleString('de-DE', { style: 'currency', currency: cur });
  }

  function formatDate(d: string): string {
    return new Date(d).toLocaleDateString('de-DE');
  }

  async function loadPartnerAccess() {
    loadingAccess = true;
    const uniquePartners = [...new Set(data.subscribers.map((s) => s.partnerId))];
    const access: Record<string, number[]> = {};
    await Promise.all(
      uniquePartners.map(async (pid) => {
        try {
          const accounts = await listAccountsForPartner(pid);
          access[pid] = accounts.map((a) => a.id);
        } catch {
          access[pid] = [];
        }
      }),
    );
    partnerAccess = access;
    loadingAccess = false;
  }

  $effect(() => {
    const subscribers = data.subscribers;
    const accountId = data.account.id;
    untrack(() => loadPartnerAccess());
  });

  const partnersWithAccess = $derived(
    Object.entries(partnerAccess).filter(([, ids]) => ids.includes(data.account.id)).map(([pid]) => pid),
  );

  async function handleGrant() {
    if (!grantPartnerId.trim()) return;
    try {
      await grantAccountAccess(grantPartnerId.trim(), data.account.id);
      grantPartnerId = '';
      await loadPartnerAccess();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Grant failed');
    }
  }

  async function handleRevoke(partnerId: string) {
    try {
      await revokeAccountAccess(partnerId, data.account.id);
      await loadPartnerAccess();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Revoke failed');
    }
  }

  async function handleCreateBooking() {
    const cents = Math.round(parseFloat(bkAmountEur) * 100);
    if (isNaN(cents) || !bkDate) return;
    bkCreating = true;
    bkError = '';
    try {
      await createBooking(data.account.id, {
        amountCents: cents,
        valueDate: bkDate,
        bookingDate: bkDate,
        counterpartyName: bkCounterpartyName.trim() || undefined,
        counterpartyIban: bkCounterpartyIban.trim() || undefined,
        counterpartyBic: bkCounterpartyBic.trim() || undefined,
        remittanceInfo: bkRemittance.trim() || undefined,
        endToEndId: bkEndToEndId.trim() || undefined,
        transactionCode: bkCode.trim() || 'NTRF',
      });
      showBookingForm = false;
      bkAmountEur = '';
      bkCounterpartyName = '';
      bkCounterpartyIban = '';
      bkCounterpartyBic = '';
      bkRemittance = '';
      bkEndToEndId = '';
      await invalidateAll();
    } catch (e) {
      bkError = e instanceof Error ? e.message : 'Failed to create booking';
    } finally {
      bkCreating = false;
    }
  }

  function downloadStatement() {
    const url = getStatementUrl(data.account.id, stmtFormat);
    window.open(url, '_blank');
  }

  function toggleBooking(id: number) {
    expandedBooking = expandedBooking === id ? null : id;
  }
</script>

<div class="mb-6">
  <a href="{base}/banking/accounts" class="text-sm text-base-content/50 hover:text-base-content inline-flex items-center gap-1">
    <Icon name="chevronLeft" class="w-3.5 h-3.5" /> Accounts
  </a>
</div>

<!-- Account header -->
<div class="flex items-start justify-between mb-6">
  <div>
    <h1 class="text-2xl font-bold">{data.account.name}</h1>
    <div class="font-mono text-sm text-base-content/50 mt-1">{data.account.iban}</div>
    <div class="text-sm text-base-content/40 mt-0.5">
      Owner: <a href="{base}/banking/persons/{data.person.id}" class="link link-hover">{data.person.name}</a>
      <span class="mx-1.5 text-base-content/20">|</span>
      Account #{data.account.accountNumber}
      <span class="mx-1.5 text-base-content/20">|</span>
      {data.account.currency}
    </div>
  </div>
  <div class="text-right">
    <div class="text-xs text-base-content/50">Current Balance</div>
    <div class="font-mono text-2xl font-bold {data.account.currentBalanceCents >= 0 ? 'text-success' : 'text-error'}">
      {formatCents(data.account.currentBalanceCents, data.account.currency)}
    </div>
  </div>
</div>

<div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
  <!-- Partner Access -->
  <div class="bg-base-200 rounded-xl p-4">
    <h2 class="text-sm font-semibold mb-2">EBICS Partner Access</h2>
    {#if loadingAccess}
      <span class="text-xs text-base-content/40">Loading...</span>
    {:else if partnersWithAccess.length === 0}
      <p class="text-xs text-base-content/40 italic">No EBICS partners have access.</p>
    {:else}
      <div class="flex flex-wrap gap-2 mb-2">
        {#each partnersWithAccess as pid}
          <div class="badge badge-outline badge-sm gap-1.5 font-mono">
            {pid}
            <button class="text-error/70 hover:text-error text-xs leading-none" onclick={() => handleRevoke(pid)}>&times;</button>
          </div>
        {/each}
      </div>
    {/if}
    <div class="flex gap-2 mt-2">
      <select class="select select-bordered select-xs flex-1" bind:value={grantPartnerId}>
        <option value="">Select partner...</option>
        {#each [...new Set(data.subscribers.map((s) => s.partnerId))] as pid}
          {#if !partnersWithAccess.includes(pid)}
            <option value={pid}>{pid}</option>
          {/if}
        {/each}
      </select>
      <button class="btn btn-xs btn-outline" disabled={!grantPartnerId} onclick={handleGrant}>Grant</button>
    </div>
  </div>

  <!-- Statement Download -->
  <div class="bg-base-200 rounded-xl p-4">
    <h2 class="text-sm font-semibold mb-2">Statement Preview</h2>
    <p class="text-xs text-base-content/40 mb-3">Download generated bank statements for this account.</p>
    <div class="flex items-center gap-3">
      <select class="select select-bordered select-xs" bind:value={stmtFormat}>
        <option value="camt.053">camt.053 (ISO 20022 XML)</option>
        <option value="mt940">MT940 (SWIFT)</option>
      </select>
      <button class="btn btn-xs btn-outline gap-1.5" onclick={downloadStatement}>
        <Icon name="download" class="w-3.5 h-3.5" /> Download
      </button>
    </div>
  </div>
</div>

<!-- Bookings -->
<div class="flex items-center justify-between mb-4">
  <h2 class="text-lg font-semibold">Bookings <span class="text-base-content/40 font-normal text-sm">({data.bookings.length})</span></h2>
  <button class="btn btn-primary btn-sm gap-1.5" onclick={() => showBookingForm = true}>
    <Icon name="plus" class="w-4 h-4" /> New Booking
  </button>
</div>

{#if showBookingForm}
  <div class="bg-base-200 rounded-xl p-5 mb-4 ring-1 ring-primary/20">
    <h3 class="text-sm font-semibold mb-4">New Booking</h3>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <!-- Left: Payment details -->
      <div>
        <div class="text-[11px] text-base-content/40 uppercase tracking-wider mb-3">Payment</div>
        <div class="grid grid-cols-2 gap-x-3 gap-y-3">
          <div>
            <label for="bkAmt" class="block text-xs text-base-content/60 mb-1">Amount (EUR) *</label>
            <input id="bkAmt" type="number" step="0.01" class="input input-bordered input-sm w-full font-mono" bind:value={bkAmountEur} placeholder="-120.50" />
            <div class="text-[10px] text-base-content/30 mt-0.5">Negative = debit</div>
          </div>
          <div>
            <label for="bkDate" class="block text-xs text-base-content/60 mb-1">Value Date *</label>
            <input id="bkDate" type="date" class="input input-bordered input-sm w-full" bind:value={bkDate} />
          </div>
          <div>
            <label for="bkCode" class="block text-xs text-base-content/60 mb-1">Transaction Code</label>
            <input id="bkCode" type="text" class="input input-bordered input-sm w-full font-mono" bind:value={bkCode} />
          </div>
          <div>
            <label for="bkE2E" class="block text-xs text-base-content/60 mb-1">End-to-End ID</label>
            <input id="bkE2E" type="text" class="input input-bordered input-sm w-full font-mono" bind:value={bkEndToEndId} placeholder="E2E-001" />
          </div>
        </div>
      </div>

      <!-- Right: Counterparty -->
      <div>
        <div class="text-[11px] text-base-content/40 uppercase tracking-wider mb-3">Counterparty</div>
        <div>
          <label for="bkCpName" class="block text-xs text-base-content/60 mb-1">Name</label>
          <input id="bkCpName" type="text" class="input input-bordered input-sm w-full" bind:value={bkCounterpartyName} placeholder="Arbeitgeber GmbH" />
        </div>
        <div class="grid grid-cols-5 gap-3 mt-3">
          <div class="col-span-3">
            <label for="bkCpIban" class="block text-xs text-base-content/60 mb-1">IBAN</label>
            <input id="bkCpIban" type="text" class="input input-bordered input-sm w-full font-mono" bind:value={bkCounterpartyIban} placeholder="DE89370400440532013000" />
          </div>
          <div class="col-span-2">
            <label for="bkCpBic" class="block text-xs text-base-content/60 mb-1">BIC</label>
            <input id="bkCpBic" type="text" class="input input-bordered input-sm w-full font-mono" bind:value={bkCounterpartyBic} placeholder="COBADEFFXXX" />
          </div>
        </div>
      </div>
    </div>

    <!-- Full width: Reference -->
    <div class="mt-5">
      <div class="text-[11px] text-base-content/40 uppercase tracking-wider mb-3">Reference</div>
      <div>
        <label for="bkRef" class="block text-xs text-base-content/60 mb-1">Remittance Info / Verwendungszweck</label>
        <input id="bkRef" type="text" class="input input-bordered input-sm w-full" bind:value={bkRemittance} placeholder="Gehalt November 2025" />
      </div>
    </div>

    {#if bkError}
      <div class="alert alert-error mt-3 text-sm">{bkError}</div>
    {/if}
    <div class="flex gap-2 mt-5 justify-end border-t border-base-300 pt-4">
      <button class="btn btn-ghost btn-sm" onclick={() => showBookingForm = false}>Cancel</button>
      <button class="btn btn-primary btn-sm" disabled={bkCreating || !bkAmountEur || !bkDate} onclick={handleCreateBooking}>
        {bkCreating ? 'Creating...' : 'Create Booking'}
      </button>
    </div>
  </div>
{/if}

{#if data.bookings.length === 0}
  <div class="text-center py-10 text-base-content/40">
    <p>No bookings yet.</p>
  </div>
{:else}
  <div class="bg-base-200 rounded-xl overflow-hidden">
    <table class="table table-sm">
      <thead>
        <tr>
          <th class="w-8"></th>
          <th>Date</th>
          <th class="text-right">Amount</th>
          <th>Counterparty</th>
          <th>Remittance Info</th>
          <th>Code</th>
        </tr>
      </thead>
      <tbody>
        {#each data.bookings as booking}
          <tr class="hover:bg-base-300/50 cursor-pointer" onclick={() => toggleBooking(booking.id)}>
            <td class="text-base-content/30 text-xs">{expandedBooking === booking.id ? '▾' : '▸'}</td>
            <td class="whitespace-nowrap text-sm">{formatDate(booking.valueDate)}</td>
            <td class="text-right font-mono font-medium whitespace-nowrap {booking.amountCents >= 0 ? 'text-success' : 'text-error'}">
              {formatCents(booking.amountCents, booking.currency)}
            </td>
            <td class="text-sm">{booking.counterpartyName ?? '-'}</td>
            <td class="text-sm text-base-content/60 max-w-xs truncate">{booking.remittanceInfo ?? '-'}</td>
            <td><span class="badge badge-ghost badge-xs font-mono">{booking.transactionCode}</span></td>
          </tr>
          {#if expandedBooking === booking.id}
            <tr class="bg-base-300/30">
              <td colspan="6" class="px-6 py-3">
                <div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <div class="text-[11px] text-base-content/40 uppercase tracking-wide">Value Date</div>
                    <div class="font-mono mt-0.5">{booking.valueDate}</div>
                  </div>
                  <div>
                    <div class="text-[11px] text-base-content/40 uppercase tracking-wide">Booking Date</div>
                    <div class="font-mono mt-0.5">{booking.bookingDate}</div>
                  </div>
                  <div>
                    <div class="text-[11px] text-base-content/40 uppercase tracking-wide">Amount (cents)</div>
                    <div class="font-mono mt-0.5">{booking.amountCents}</div>
                  </div>
                  <div>
                    <div class="text-[11px] text-base-content/40 uppercase tracking-wide">Currency</div>
                    <div class="font-mono mt-0.5">{booking.currency}</div>
                  </div>
                  <div>
                    <div class="text-[11px] text-base-content/40 uppercase tracking-wide">Counterparty IBAN</div>
                    <div class="font-mono mt-0.5 text-xs">{booking.counterpartyIban ?? '-'}</div>
                  </div>
                  <div>
                    <div class="text-[11px] text-base-content/40 uppercase tracking-wide">Counterparty BIC</div>
                    <div class="font-mono mt-0.5">{booking.counterpartyBic ?? '-'}</div>
                  </div>
                  <div>
                    <div class="text-[11px] text-base-content/40 uppercase tracking-wide">Transaction Code</div>
                    <div class="font-mono mt-0.5">{booking.transactionCode}</div>
                  </div>
                  <div>
                    <div class="text-[11px] text-base-content/40 uppercase tracking-wide">End-to-End ID</div>
                    <div class="font-mono mt-0.5">{booking.endToEndId ?? '-'}</div>
                  </div>
                  <div class="col-span-2">
                    <div class="text-[11px] text-base-content/40 uppercase tracking-wide">Remittance Info</div>
                    <div class="mt-0.5">{booking.remittanceInfo ?? '-'}</div>
                  </div>
                  <div>
                    <div class="text-[11px] text-base-content/40 uppercase tracking-wide">Booking ID</div>
                    <div class="font-mono mt-0.5">{booking.id}</div>
                  </div>
                  <div>
                    <div class="text-[11px] text-base-content/40 uppercase tracking-wide">Created</div>
                    <div class="font-mono mt-0.5 text-xs">{booking.createdAt}</div>
                  </div>
                </div>
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </div>
{/if}
