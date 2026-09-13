<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';
  import { broadcastRealtimeInfo, issueRealtimeToken, listKeptRealtimeMessages, listRealtimeConnections, notifyRealtime } from '$lib/api.js';
  import type { BtfNotification, KeptRealtimeMessages, RealtimeConnection, Subscriber, WssParameters } from '$lib/types.js';
  import { apiErrorMessage, formatDateTime } from '$lib/payments.js';

  interface Props {
    data: { connections: RealtimeConnection[]; kept: KeptRealtimeMessages[]; subscribers: Subscriber[] };
  }

  let { data }: Props = $props();

  const partners = $derived([...new Set(data.subscribers.map((s) => s.partnerId))].sort());
  const usersOf = (partnerId: string) => data.subscribers.filter((s) => s.partnerId === partnerId).map((s) => s.userId);

  // Connections
  let refreshed = $state<RealtimeConnection[] | null>(null);
  const connections = $derived(refreshed ?? data.connections);
  let refreshedKept = $state<KeptRealtimeMessages[] | null>(null);
  const kept = $derived(refreshedKept ?? data.kept);
  let refreshError = $state('');

  async function refresh() {
    try {
      [refreshed, refreshedKept] = await Promise.all([listRealtimeConnections(), listKeptRealtimeMessages()]);
      refreshError = '';
    } catch (e) {
      refreshError = apiErrorMessage(e, 'Refresh failed');
    }
  }

  $effect(() => {
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  });

  const deliveryText = ({ sent, kept }: { sent: number; kept?: number }) =>
    `Sent to ${sent} connection${sent === 1 ? '' : 's'}.` +
    (kept ? ` Kept for ${kept} customer${kept === 1 ? '' : 's'} without connection.` : '');

  // Token
  let tPartner = $state('');
  let tUser = $state('');
  let token = $state<WssParameters | null>(null);
  let tokenError = $state('');

  const basicAuth = $derived(
    token ? `Basic ${btoa(`${token.PARTNERID}${token.USERID ? `_${token.USERID}` : ''}:${token.TOKEN}`)}` : '',
  );

  async function handleIssueToken() {
    if (!tPartner) return;
    tokenError = '';
    try {
      token = await issueRealtimeToken({ partnerId: tPartner, userId: tUser || undefined });
    } catch (e) {
      tokenError = apiErrorMessage(e, 'Issuing a token failed');
    }
  }

  // Notification
  const PRESETS: { label: string; btf: BtfNotification }[] = [
    { label: 'camt.054 notifications', btf: { SERVICE: 'STM', SCOPE: 'DE', OPTION: 'SCI', CONTTYPE: 'ZIP', MSGNAME: 'camt.054' } },
    { label: 'camt.052 intraday report', btf: { SERVICE: 'STM', SCOPE: 'DE', CONTTYPE: 'ZIP', MSGNAME: 'camt.052' } },
    { label: 'pain.002 payment status', btf: { SERVICE: 'REP', SCOPE: 'DE', OPTION: 'SCI', CONTTYPE: 'ZIP', MSGNAME: 'pain.002' } },
    { label: 'pain.002 VoP report', btf: { SERVICE: 'REP', SCOPE: 'DE', OPTION: 'VOP', CONTTYPE: 'ZIP', MSGNAME: 'pain.002' } },
  ];
  const btfLabel = (btf: BtfNotification) => [btf.SERVICE, btf.SCOPE, btf.OPTION, btf.CONTTYPE, btf.MSGNAME].filter(Boolean).join('/');

  let nPartner = $state('');
  let nUser = $state('');
  let presetChecked = $state<boolean[]>(PRESETS.map(() => false));
  let free = $state({ SERVICE: '', SCOPE: '', OPTION: '', CONTTYPE: '', MSGNAME: '' });
  let orderTypesText = $state('');
  let notifyResult = $state('');
  let notifyError = $state('');

  async function handleNotify() {
    if (!nPartner) return;
    const btf: BtfNotification[] = PRESETS.filter((_, i) => presetChecked[i]).map((p) => p.btf);
    if (free.SERVICE.trim() && free.MSGNAME.trim()) {
      const entry: BtfNotification = { SERVICE: free.SERVICE.trim(), MSGNAME: free.MSGNAME.trim() };
      if (free.SCOPE.trim()) entry.SCOPE = free.SCOPE.trim();
      if (free.OPTION.trim()) entry.OPTION = free.OPTION.trim();
      if (free.CONTTYPE.trim()) entry.CONTTYPE = free.CONTTYPE.trim();
      btf.push(entry);
    }
    const orderTypes = orderTypesText
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    notifyResult = '';
    notifyError = '';
    try {
      notifyResult = deliveryText(await notifyRealtime({ partnerId: nPartner, userId: nUser || undefined, btf, orderTypes }));
      await refresh();
    } catch (e) {
      notifyError = apiErrorMessage(e, 'Sending the notification failed');
    }
  }

  // Info broadcast
  let infoText = $state('');
  let infoLang = $state('DE');
  let infoResult = $state('');
  let infoError = $state('');

  async function handleInfo() {
    if (!infoText.trim()) return;
    infoResult = '';
    infoError = '';
    try {
      infoResult = deliveryText(await broadcastRealtimeInfo({ text: infoText.trim(), lang: infoLang.trim() || 'DE' }));
      await refresh();
    } catch (e) {
      infoError = apiErrorMessage(e, 'Broadcast failed');
    }
  }
</script>

<h1 class="text-2xl font-bold mb-2">Real-time Notifications</h1>
<p class="text-sm text-base-content/50 mb-6">
  EBICS clients fetch connection parameters with BTD <span class="font-mono">OTH/DE/wssparam</span> and receive
  <span class="font-mono">EBICS-HAA</span> messages over the WebSocket when new data is available.
</p>

<div class="flex items-center justify-between mb-3">
  <h2 class="text-lg font-semibold">Connections <span class="text-base-content/40 font-normal text-sm">({connections.length})</span></h2>
  <button class="btn btn-ghost btn-sm gap-1.5" onclick={refresh}>Refresh</button>
</div>
{#if refreshError}
  <div class="alert alert-error mb-3 text-sm">{refreshError}</div>
{/if}
{#if connections.length === 0}
  <div class="bg-base-200 rounded-xl p-6 mb-6 text-center text-base-content/40 text-sm">
    <Icon name="realtime" class="w-10 h-10 mx-auto mb-2 opacity-30" />
    No open WebSocket connections. The list refreshes every 5 seconds.
  </div>
{:else}
  <div class="overflow-x-auto bg-base-200 rounded-xl mb-6">
    <table class="table table-sm">
      <thead>
        <tr>
          <th>Partner</th>
          <th>User</th>
          <th>Connected since</th>
        </tr>
      </thead>
      <tbody>
        {#each connections as connection (connection.id)}
          <tr>
            <td class="font-mono">{connection.partnerId}</td>
            <td class="font-mono">{connection.userId ?? '-'}</td>
            <td class="text-sm">{formatDateTime(connection.connectedAt)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

{#if kept.length > 0}
  <h2 class="text-lg font-semibold mb-1">Kept messages</h2>
  <p class="text-xs text-base-content/50 mb-3">
    Kept with <span class="font-mono">EBICS_WSS_REPLAY</span> for customers without an open connection and sent when a client
    of the customer connects, as long as a token of the customer is valid.
  </p>
  <div class="overflow-x-auto bg-base-200 rounded-xl mb-6">
    <table class="table table-sm">
      <thead>
        <tr>
          <th>Partner</th>
          <th>Messages</th>
          <th>First delivery attempt</th>
        </tr>
      </thead>
      <tbody>
        {#each kept as entry (entry.partnerId)}
          <tr>
            <td class="font-mono">{entry.partnerId}</td>
            <td class="font-mono text-xs">{entry.messages.map((message) => message.MCLASS[0]?.NAME).join(', ')}</td>
            <td class="text-sm">{entry.messages[0]?.MCLASS[0] ? formatDateTime(entry.messages[0].MCLASS[0].TIMESTAMP) : '-'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
  <div class="bg-base-200 rounded-xl p-5">
    <h2 class="text-sm font-semibold mb-3">Issue token</h2>
    <div class="flex gap-2 items-end">
      <div>
        <label for="tPartner" class="block text-xs text-base-content/60 mb-1">Partner *</label>
        <select id="tPartner" class="select select-bordered select-sm font-mono" bind:value={tPartner}>
          <option value="">Select...</option>
          {#each partners as pid}
            <option value={pid}>{pid}</option>
          {/each}
        </select>
      </div>
      <div>
        <label for="tUser" class="block text-xs text-base-content/60 mb-1">User</label>
        <select id="tUser" class="select select-bordered select-sm font-mono" bind:value={tUser} disabled={!tPartner}>
          <option value="">(none)</option>
          {#each usersOf(tPartner) as uid}
            <option value={uid}>{uid}</option>
          {/each}
        </select>
      </div>
      <button class="btn btn-primary btn-sm" disabled={!tPartner} onclick={handleIssueToken}>Issue</button>
    </div>
    {#if tokenError}
      <div class="alert alert-error mt-3 text-sm">{tokenError}</div>
    {/if}
    {#if token}
      <pre class="bg-base-100 rounded-lg p-3 mt-3 text-xs overflow-x-auto">{JSON.stringify(token, null, 2)}</pre>
      <div class="text-xs text-base-content/60 mt-2 space-y-1">
        <div>Connect to <span class="font-mono">{token.URL}</span> with the header:</div>
        <div class="font-mono break-all bg-base-100 rounded p-2">Authorization: {basicAuth}</div>
        <div>
          The credential is base64("PARTNERID_USERID:TOKEN"), without "_USERID" when no user is set.
          OTT <span class="font-mono">Y</span> is a one-time token, <span class="font-mono">N</span> works until VALIDITY.
        </div>
      </div>
    {/if}
  </div>

  <div class="bg-base-200 rounded-xl p-5">
    <h2 class="text-sm font-semibold mb-3">Broadcast info</h2>
    <div class="flex gap-2 items-end">
      <div class="flex-1">
        <label for="infoText" class="block text-xs text-base-content/60 mb-1">Text *</label>
        <input id="infoText" type="text" class="input input-bordered input-sm w-full" bind:value={infoText} placeholder="Wartungsarbeiten heute ab 22 Uhr" />
      </div>
      <div class="w-20">
        <label for="infoLang" class="block text-xs text-base-content/60 mb-1">Language</label>
        <input id="infoLang" type="text" maxlength="2" class="input input-bordered input-sm w-full font-mono" bind:value={infoLang} />
      </div>
      <button class="btn btn-primary btn-sm" disabled={!infoText.trim()} onclick={handleInfo}>Send</button>
    </div>
    <p class="text-xs text-base-content/40 mt-2">INFO messages go to every open connection.</p>
    {#if infoResult}
      <div class="alert alert-success mt-3 text-sm">{infoResult}</div>
    {/if}
    {#if infoError}
      <div class="alert alert-error mt-3 text-sm">{infoError}</div>
    {/if}
  </div>
</div>

<div class="bg-base-200 rounded-xl p-5">
  <h2 class="text-sm font-semibold mb-3">Send notification (EBICS-HAA)</h2>
  <div class="flex gap-2 items-end mb-4">
    <div>
      <label for="nPartner" class="block text-xs text-base-content/60 mb-1">Partner *</label>
      <select id="nPartner" class="select select-bordered select-sm font-mono" bind:value={nPartner}>
        <option value="">Select...</option>
        {#each partners as pid}
          <option value={pid}>{pid}</option>
        {/each}
      </select>
    </div>
    <div>
      <label for="nUser" class="block text-xs text-base-content/60 mb-1">User</label>
      <select id="nUser" class="select select-bordered select-sm font-mono" bind:value={nUser} disabled={!nPartner}>
        <option value="">(none)</option>
        {#each usersOf(nPartner) as uid}
          <option value={uid}>{uid}</option>
        {/each}
      </select>
    </div>
  </div>

  <div class="text-[11px] text-base-content/40 uppercase tracking-wider mb-2">BTF</div>
  <div class="grid grid-cols-1 md:grid-cols-2 gap-2 mb-3">
    {#each PRESETS as preset, i}
      <label class="flex items-center gap-2 text-sm cursor-pointer">
        <input type="checkbox" class="checkbox checkbox-sm" bind:checked={presetChecked[i]} />
        {preset.label} <span class="font-mono text-xs text-base-content/50">{btfLabel(preset.btf)}</span>
      </label>
    {/each}
  </div>
  <div class="grid grid-cols-5 gap-2 mb-3">
    <input type="text" class="input input-bordered input-sm font-mono" placeholder="SERVICE" bind:value={free.SERVICE} />
    <input type="text" class="input input-bordered input-sm font-mono" placeholder="SCOPE" bind:value={free.SCOPE} />
    <input type="text" class="input input-bordered input-sm font-mono" placeholder="OPTION" bind:value={free.OPTION} />
    <input type="text" class="input input-bordered input-sm font-mono" placeholder="CONTTYPE" bind:value={free.CONTTYPE} />
    <input type="text" class="input input-bordered input-sm font-mono" placeholder="MSGNAME" bind:value={free.MSGNAME} />
  </div>
  <div class="mb-4">
    <label for="orderTypes" class="block text-xs text-base-content/60 mb-1">Order types (comma separated)</label>
    <input id="orderTypes" type="text" class="input input-bordered input-sm w-64 font-mono" bind:value={orderTypesText} placeholder="HAC" />
  </div>
  <div class="flex items-center gap-3">
    <button class="btn btn-primary btn-sm" disabled={!nPartner} onclick={handleNotify}>Send notification</button>
    {#if notifyResult}
      <span class="text-sm text-success">{notifyResult}</span>
    {/if}
  </div>
  {#if notifyError}
    <div class="alert alert-error mt-3 text-sm">{notifyError}</div>
  {/if}
</div>
