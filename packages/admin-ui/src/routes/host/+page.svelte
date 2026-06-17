<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import KeyCard from '$lib/components/KeyCard.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { configureHost } from '$lib/api.js';
  import type { HostConfig } from '$lib/types.js';

  interface Props {
    data: { host: HostConfig | null };
  }

  let { data }: Props = $props();

  let showReconfigure = $state(false);
  let newHostId = $state('');
  let reconfiguring = $state(false);

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

  <h2 class="text-lg font-semibold mb-4">Bank Keys</h2>

  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
    <KeyCard
      label="Authentication"
      version={data.host.bankKeys.authenticationVersion}
      certificate={data.host.bankKeys.authenticationCertificate}
    />
    <KeyCard
      label="Encryption"
      version={data.host.bankKeys.encryptionVersion}
      certificate={data.host.bankKeys.encryptionCertificate}
    />
  </div>
{/if}
