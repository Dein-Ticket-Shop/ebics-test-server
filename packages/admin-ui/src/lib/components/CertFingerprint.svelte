<script lang="ts">
  import HexDigest from './HexDigest.svelte';

  interface Props {
    pem: string | undefined;
    /** colon: aa:bb:…; letter: AA BB … in lines of 16 bytes, like bank letters */
    format?: 'colon' | 'letter';
  }

  const { pem, format = 'colon' }: Props = $props();

  let fingerprint = $state('');

  async function computeFingerprint(cert: string) {
    const b64 = cert.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
    const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const hash = await crypto.subtle.digest('SHA-256', der);
    fingerprint = Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(':');
  }

  $effect(() => {
    if (pem) computeFingerprint(pem);
    else fingerprint = '';
  });
</script>

{#if fingerprint && format === 'letter'}
  <HexDigest digest={fingerprint.replaceAll(':', '')} />
{:else if fingerprint}
  <code class="text-xs break-all font-mono">{fingerprint}</code>
{:else if pem}
  <span class="text-base-content/50 text-xs">Computing...</span>
{:else}
  <span class="text-base-content/30 text-xs italic">Not set</span>
{/if}
