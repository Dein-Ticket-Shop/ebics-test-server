<script lang="ts">
  import type { SubscriberState } from '$lib/types.js';

  interface Props {
    state: SubscriberState;
  }

  const { state }: Props = $props();

  const colours: Record<SubscriberState, string> = {
    NEW: 'badge-neutral',
    PARTIALLY_INITIALIZED_INI: 'badge-warning',
    PARTIALLY_INITIALIZED_HIA: 'badge-warning',
    INITIALIZED: 'badge-info',
    READY: 'badge-success',
    SUSPENDED: 'badge-error',
  };

  const labels: Record<SubscriberState, string> = {
    NEW: 'New',
    PARTIALLY_INITIALIZED_INI: 'INI done',
    PARTIALLY_INITIALIZED_HIA: 'HIA done',
    INITIALIZED: 'Initialized',
    READY: 'Ready',
    SUSPENDED: 'Suspended',
  };
</script>

<span class="badge {colours[state]} badge-sm gap-1">{labels[state]}</span>
