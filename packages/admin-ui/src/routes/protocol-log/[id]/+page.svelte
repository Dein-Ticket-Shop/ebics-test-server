<script lang="ts">
  import { base } from '$app/paths';
  import Icon from '$lib/components/Icon.svelte';
  import type { ProtocolLogEntry } from '$lib/types.js';

  interface Props {
    data: { entry: ProtocolLogEntry };
  }

  let { data }: Props = $props();
  let entry = $derived(data.entry);

  let copiedRequest = $state(false);
  let copiedResponse = $state(false);
  let copiedAll = $state(false);

  function formatTime(iso: string): string {
    return new Date(iso + 'Z').toLocaleString();
  }

  function returnCodeClass(code?: string): string {
    if (!code) return '';
    if (code === '000000') return 'text-success';
    if (code.startsWith('01')) return 'text-info';
    return 'text-error';
  }

  function formatXml(xml: string): string {
    let indent = 0;
    return xml
      .replace(/></g, '>\n<')
      .split('\n')
      .map((line) => {
        line = line.trim();
        if (!line) return '';
        if (line.startsWith('</')) indent = Math.max(0, indent - 1);
        const result = '  '.repeat(indent) + line;
        if (line.startsWith('<') && !line.startsWith('</') && !line.startsWith('<?') && !line.endsWith('/>') && !line.includes('</')) {
          indent++;
        }
        return result;
      })
      .filter(Boolean)
      .join('\n');
  }

  async function copyToClipboard(text: string, flag: 'request' | 'response' | 'all') {
    await navigator.clipboard.writeText(text);
    if (flag === 'request') { copiedRequest = true; setTimeout(() => copiedRequest = false, 2000); }
    if (flag === 'response') { copiedResponse = true; setTimeout(() => copiedResponse = false, 2000); }
    if (flag === 'all') { copiedAll = true; setTimeout(() => copiedAll = false, 2000); }
  }

  function buildClaudePrompt(): string {
    const meta = [
      `EBICS Protocol Exchange #${entry.id}`,
      `Time: ${formatTime(entry.createdAt)}`,
      entry.rootElement ? `Root Element: ${entry.rootElement}` : null,
      entry.orderType ? `Order Type: ${entry.orderType}` : null,
      entry.partnerId ? `Subscriber: ${entry.partnerId}/${entry.userId}` : null,
      entry.transactionId ? `Transaction ID: ${entry.transactionId}` : null,
      entry.transactionPhase ? `Phase: ${entry.transactionPhase}` : null,
      entry.returnCode ? `Return Code: ${entry.returnCode}` : null,
      entry.durationMs !== undefined ? `Duration: ${entry.durationMs}ms` : null,
    ].filter(Boolean).join('\n');

    return `${meta}

--- REQUEST XML ---
${entry.requestXml}

--- RESPONSE XML ---
${entry.responseXml}`;
  }
</script>

<div class="mb-6">
  <a href="{base}/protocol-log" class="btn btn-ghost btn-sm gap-1 mb-4">
    <Icon name="chevronLeft" class="w-4 h-4" />
    Back to Protocol Log
  </a>

  <div class="flex items-center justify-between">
    <h1 class="text-2xl font-bold">Exchange #{entry.id}</h1>
    <button
      class="btn btn-primary btn-sm gap-2"
      onclick={() => copyToClipboard(buildClaudePrompt(), 'all')}
    >
      <Icon name="clipboard" class="w-4 h-4" />
      {copiedAll ? 'Copied!' : 'Copy for Claude'}
    </button>
  </div>
</div>

<div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
  <div class="bg-base-200 rounded-lg p-3">
    <div class="text-[11px] font-medium text-base-content/40 uppercase tracking-wider mb-1">Time</div>
    <div class="font-mono text-sm">{formatTime(entry.createdAt)}</div>
  </div>
  <div class="bg-base-200 rounded-lg p-3">
    <div class="text-[11px] font-medium text-base-content/40 uppercase tracking-wider mb-1">Order Type</div>
    <div>
      {#if entry.orderType}
        <span class="badge badge-outline">{entry.orderType}</span>
      {:else}
        <span class="text-base-content/30">-</span>
      {/if}
    </div>
  </div>
  <div class="bg-base-200 rounded-lg p-3">
    <div class="text-[11px] font-medium text-base-content/40 uppercase tracking-wider mb-1">Return Code</div>
    <div class="font-mono text-lg font-bold {returnCodeClass(entry.returnCode)}">{entry.returnCode ?? '-'}</div>
  </div>
  <div class="bg-base-200 rounded-lg p-3">
    <div class="text-[11px] font-medium text-base-content/40 uppercase tracking-wider mb-1">Duration</div>
    <div class="font-mono text-sm">{entry.durationMs !== undefined ? `${entry.durationMs}ms` : '-'}</div>
  </div>
</div>

{#if entry.partnerId || entry.transactionId}
  <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
    {#if entry.partnerId}
      <div class="bg-base-200 rounded-lg p-3">
        <div class="text-[11px] font-medium text-base-content/40 uppercase tracking-wider mb-1">Subscriber</div>
        <div class="font-mono text-sm">{entry.partnerId}/{entry.userId}</div>
      </div>
    {/if}
    {#if entry.transactionId}
      <div class="bg-base-200 rounded-lg p-3 col-span-2">
        <div class="text-[11px] font-medium text-base-content/40 uppercase tracking-wider mb-1">Transaction ID</div>
        <div class="font-mono text-xs break-all">{entry.transactionId}</div>
      </div>
    {/if}
    {#if entry.transactionPhase}
      <div class="bg-base-200 rounded-lg p-3">
        <div class="text-[11px] font-medium text-base-content/40 uppercase tracking-wider mb-1">Phase</div>
        <div class="text-sm">{entry.transactionPhase}</div>
      </div>
    {/if}
  </div>
{/if}

<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
  <div>
    <div class="flex items-center justify-between mb-2">
      <h2 class="text-lg font-semibold">Request</h2>
      <button
        class="btn btn-ghost btn-xs gap-1"
        onclick={() => copyToClipboard(entry.requestXml, 'request')}
      >
        <Icon name="clipboard" class="w-3 h-3" />
        {copiedRequest ? 'Copied!' : 'Copy'}
      </button>
    </div>
    <div class="bg-base-200 rounded-xl p-4 overflow-x-auto">
      <pre class="text-xs font-mono whitespace-pre leading-relaxed">{formatXml(entry.requestXml)}</pre>
    </div>
  </div>

  <div>
    <div class="flex items-center justify-between mb-2">
      <h2 class="text-lg font-semibold">Response</h2>
      <button
        class="btn btn-ghost btn-xs gap-1"
        onclick={() => copyToClipboard(entry.responseXml, 'response')}
      >
        <Icon name="clipboard" class="w-3 h-3" />
        {copiedResponse ? 'Copied!' : 'Copy'}
      </button>
    </div>
    <div class="bg-base-200 rounded-xl p-4 overflow-x-auto">
      <pre class="text-xs font-mono whitespace-pre leading-relaxed">{formatXml(entry.responseXml)}</pre>
    </div>
  </div>
</div>
