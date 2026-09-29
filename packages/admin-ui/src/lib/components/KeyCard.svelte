<script lang="ts">
  import CertFingerprint from './CertFingerprint.svelte';
  import HexDigest from './HexDigest.svelte';

  interface Props {
    label: string;
    version: string | undefined;
    certificate: string | undefined;
    /** SHA-256 of the public key (hex), shown like the X002/E002 line of a bank letter */
    publicKeyDigest?: string;
  }

  const { label, version, certificate, publicKeyDigest }: Props = $props();

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
      {#if publicKeyDigest}
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 mt-2 overflow-x-auto">
          <dt class="text-xs" title="SHA-256 of the public key (hex exponent and modulus); unchanged when the certificate is renewed for the same key">
            <div class="font-mono font-semibold">{version ?? 'Key'}</div>
            <div class="text-base-content/50">public key</div>
          </dt>
          <dd><HexDigest digest={publicKeyDigest} /></dd>
          <dt class="text-xs" title="SHA-256 of the DER certificate">
            <div class="font-mono font-semibold">Zert</div>
            <div class="text-base-content/50">certificate</div>
          </dt>
          <dd><CertFingerprint pem={certificate} format="letter" /></dd>
        </dl>
      {:else}
        <div>
          <span class="text-xs text-base-content/60">SHA-256:</span>
          <CertFingerprint pem={certificate} />
        </div>
      {/if}
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
