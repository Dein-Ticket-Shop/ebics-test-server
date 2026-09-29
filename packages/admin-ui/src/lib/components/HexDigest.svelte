<script lang="ts">
  interface Props {
    /** Hex digest without separators */
    digest: string;
  }

  const { digest }: Props = $props();

  /** Upper-case byte pairs, 16 bytes per line, the way bank letters print hashes */
  const lines = $derived(
    (digest.toUpperCase().match(/.{1,32}/g) ?? []).map((line) => line.match(/.{2}/g)!.join(' ')),
  );
</script>

<code class="font-mono text-xs leading-5 whitespace-nowrap">
  {#each lines as line, i (i)}<span class="block">{line}</span>{/each}
</code>
