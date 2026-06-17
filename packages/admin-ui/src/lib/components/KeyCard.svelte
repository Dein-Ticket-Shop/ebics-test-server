<script lang="ts">
  import CertFingerprint from './CertFingerprint.svelte';

  interface Props {
    label: string;
    version: string | undefined;
    certificate: string | undefined;
  }

  const { label, version, certificate }: Props = $props();

  let showPem = $state(false);
</script>

<div class="bg-base-200 rounded-xl p-4">
    <h3 class="card-title text-sm">
      {label}
      {#if version}
        <span class="badge badge-outline badge-xs">{version}</span>
      {/if}
    </h3>
    {#if certificate}
      <div>
        <span class="text-xs text-base-content/60">SHA-256:</span>
        <CertFingerprint pem={certificate} />
      </div>
      <button class="btn btn-ghost btn-xs mt-1" onclick={() => showPem = !showPem}>
        {showPem ? 'Hide' : 'Show'} PEM
      </button>
      {#if showPem}
        <pre class="text-xs bg-base-300 p-2 rounded-lg overflow-x-auto mt-1 whitespace-pre-wrap break-all">{certificate}</pre>
      {/if}
    {:else}
      <p class="text-sm text-base-content/40 italic">No key submitted yet</p>
    {/if}
</div>
