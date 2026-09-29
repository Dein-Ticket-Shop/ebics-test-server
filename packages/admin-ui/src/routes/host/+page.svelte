<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import KeyCard from '$lib/components/KeyCard.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { configureHost, rotateBankKeys } from '$lib/api.js';
  import type { EnvFlag, EnvFlagValue, HostConfig } from '$lib/types.js';

  interface Props {
    data: { host: HostConfig | null; envFlags: EnvFlag[] | null };
  }

  let { data }: Props = $props();

  /** Splits a description into text and `code` parts (odd indexes are code) */
  function descriptionParts(description: string): string[] {
    return description.split('`');
  }

  function formatValue(value: EnvFlagValue): string {
    return String(value);
  }

  function allowedValues(flag: EnvFlag): string {
    return (flag.options ?? ['true', 'false']).join(' | ');
  }

  let showReconfigure = $state(false);
  let newHostId = $state('');
  let reconfiguring = $state(false);

  let rotating = $state(false);
  let signWithPreviousKeys = $state(true);

  async function handleRotateBankKeys() {
    if (!confirm('Generate new bank keys? Subscribers get EBICS_BANK_PUBKEY_UPDATE_REQUIRED until they run HPB again.')) return;
    rotating = true;
    try {
      await rotateBankKeys(signWithPreviousKeys);
      await invalidateAll();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to rotate bank keys');
    } finally {
      rotating = false;
    }
  }

  async function handleReconfigure() {
    if (!newHostId.trim()) return;
    if (!confirm(`This will regenerate all bank keys. Existing subscribers may need to re-initialize. Continue?`)) return;
    reconfiguring = true;
    try {
      await configureHost(newHostId.trim());
      showReconfigure = false;
      newHostId = '';
      await invalidateAll();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to reconfigure');
    } finally {
      reconfiguring = false;
    }
  }
</script>

<h1 class="text-2xl font-bold mb-6">Host Configuration</h1>

{#if !data.host}
  <div class="alert alert-warning mb-6">
    Host is not configured. This should not happen — the server auto-configures on startup.
  </div>
{:else}
  <div class="bg-base-200 rounded-xl p-5 mb-6">
    <div class="flex items-center justify-between">
      <div>
        <div class="text-xs text-base-content/50 mb-0.5">Host ID</div>
        <div class="text-xl font-mono font-bold">{data.host.hostId}</div>
      </div>
      <button class="btn btn-ghost btn-sm gap-1.5" onclick={() => showReconfigure = !showReconfigure}>
        <Icon name="edit" class="w-3.5 h-3.5" />
        Reconfigure
      </button>
    </div>
  </div>

  {#if showReconfigure}
    <div class="bg-base-200 rounded-xl p-5 mb-6 ring-1 ring-warning/30">
      <h3 class="text-sm font-semibold text-warning mb-1">Reconfigure Host</h3>
      <p class="text-xs text-base-content/50 mb-3">This regenerates bank key pairs. Existing subscribers will need to re-run HPB.</p>
      <div class="flex gap-2">
        <input
          type="text"
          class="input input-bordered input-sm flex-1"
          bind:value={newHostId}
          placeholder="New Host ID"
        />
        <button class="btn btn-warning btn-sm" disabled={reconfiguring || !newHostId.trim()} onclick={handleReconfigure}>
          {reconfiguring ? 'Applying...' : 'Apply'}
        </button>
      </div>
    </div>
  {/if}

  <div class="flex items-center justify-between mb-4">
    <h2 class="text-lg font-semibold">Bank Keys</h2>
    <div class="flex items-center gap-3">
      <label class="label cursor-pointer gap-2 text-xs">
        <input type="checkbox" class="checkbox checkbox-xs" bind:checked={signWithPreviousKeys} />
        Sign with previous keys
      </label>
      <button class="btn btn-ghost btn-sm gap-1.5" disabled={rotating} onclick={handleRotateBankKeys}>
        {rotating ? 'Rotating...' : 'Rotate bank keys'}
      </button>
    </div>
  </div>
  <p class="text-xs text-base-content/50 mb-4">
    Rotating simulates a bank key change: requests with the old key digests get
    <code class="font-mono bg-base-300 rounded px-1">EBICS_BANK_PUBKEY_UPDATE_REQUIRED</code> (091008) until the
    subscriber runs HPB again. Signed with the previous keys, clients can adopt the new certificates without a manual
    check (EBICS 3.0.2 chapter 4.6.2); self-signed, they have to compare the hashes again.
  </p>

  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
    <KeyCard
      label="Authentication"
      version={data.host.bankKeys.authenticationVersion}
      certificate={data.host.bankKeys.authenticationCertificate}
      publicKeyDigest={data.host.bankKeys.authenticationPublicKeyDigest}
    />
    <KeyCard
      label="Encryption"
      version={data.host.bankKeys.encryptionVersion}
      certificate={data.host.bankKeys.encryptionCertificate}
      publicKeyDigest={data.host.bankKeys.encryptionPublicKeyDigest}
    />
  </div>
{/if}

{#if data.envFlags}
  <h2 class="text-lg font-semibold mt-8 mb-1">Environment flags</h2>
  <p class="text-xs text-base-content/50 mb-4">
    Read from the server environment on every request. Set them when starting the server; they cannot be changed here.
  </p>
  <div class="overflow-x-auto bg-base-200 rounded-xl">
    <table class="table table-sm align-top">
      <thead>
        <tr>
          <th>Flag</th>
          <th>Value</th>
          <th>Default</th>
          <th>Allowed</th>
          <th class="min-w-80">Description</th>
        </tr>
      </thead>
      <tbody>
        {#each data.envFlags as flag (flag.key)}
          <tr>
            <td>
              <div class="text-sm font-medium whitespace-nowrap">{flag.label}</div>
              <div class="font-mono text-xs text-base-content/60">{flag.env}</div>
            </td>
            <td>
              <div class="flex flex-col items-start gap-1">
                {#if flag.type === 'boolean'}
                  <span class="badge badge-sm {flag.value ? 'badge-success' : 'badge-ghost'}">{flag.value ? 'on' : 'off'}</span>
                {:else}
                  <span class="badge badge-sm badge-info font-mono whitespace-nowrap">{formatValue(flag.value)}</span>
                {/if}
                {#if flag.ignored}
                  <span class="badge badge-sm badge-warning whitespace-nowrap" title="Not a recognised value, the default applies">
                    ignored: {flag.raw}
                  </span>
                {:else if flag.raw !== null}
                  <span class="text-xs text-base-content/50">set</span>
                {:else}
                  <span class="text-xs text-base-content/40">default</span>
                {/if}
              </div>
            </td>
            <td class="font-mono text-xs whitespace-nowrap">{formatValue(flag.defaultValue)}</td>
            <td class="font-mono text-xs whitespace-nowrap">{allowedValues(flag)}</td>
            <td class="text-xs text-base-content/70">
              {#each descriptionParts(flag.description) as part, i (i)}
                {#if i % 2 === 1}<code class="font-mono bg-base-300 rounded px-1">{part}</code>{:else}{part}{/if}
              {/each}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
