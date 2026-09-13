<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { base } from '$app/paths';
  import StateBadge from '$lib/components/StateBadge.svelte';
  import CertFingerprint from '$lib/components/CertFingerprint.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { activateSubscriber, suspendSubscriber, reactivateSubscriber, deleteSubscriber, updateSubscriber } from '$lib/api.js';
  import type { SignatureClass, Subscriber } from '$lib/types.js';

  interface Props {
    data: { subscriber: Subscriber };
  }

  let { data }: Props = $props();

  const sub = $derived(data.subscriber);

  const hasSignatureKey = $derived(!!sub.keys.signatureCertificate);
  const hasAuthKey = $derived(!!sub.keys.authenticationCertificate);
  const hasEncKey = $derived(!!sub.keys.encryptionCertificate);
  const keyCount = $derived([hasSignatureKey, hasAuthKey, hasEncKey].filter(Boolean).length);

  let sigPemOpen = $state(false);
  let authPemOpen = $state(false);
  let encPemOpen = $state(false);

  async function handleActivate() {
    try {
      await activateSubscriber(sub.partnerId, sub.userId);
      await invalidateAll();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Activation failed');
    }
  }

  async function handleSuspend() {
    if (!confirm(`Suspend subscriber ${sub.partnerId}/${sub.userId}? They will be unable to make EBICS requests until reactivated.`)) return;
    try {
      await suspendSubscriber(sub.partnerId, sub.userId);
      await invalidateAll();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Suspend failed');
    }
  }

  async function handleReactivate() {
    try {
      await reactivateSubscriber(sub.partnerId, sub.userId);
      await invalidateAll();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Reactivation failed');
    }
  }

  const SIGNATURE_CLASS_OPTIONS: { value: SignatureClass; label: string; description: string }[] = [
    {
      value: 'E',
      label: 'single signature',
      description: 'Authorises an order alone: uploads with a signature flag are executed immediately.',
    },
    {
      value: 'A',
      label: 'first signature',
      description:
        'Needs a further signature of another user with class E, A or B. Uploads requesting EDS wait in the VEU, other uploads with a signature flag are rejected with 090003.',
    },
    {
      value: 'B',
      label: 'second signature',
      description:
        'Needs a further signature of another user with class E or A. Uploads requesting EDS wait in the VEU, other uploads with a signature flag are rejected with 090003.',
    },
    {
      value: 'T',
      label: 'transport signature (technical user)',
      description:
        'Submits orders without authorising them. Uploads requesting EDS wait in the VEU for other users, other uploads with a signature flag are rejected with 090003. Cannot sign (HVE) or cancel (HVS) orders; HVU and HVZ list no orders and HVD/HVT answer 091007.',
    },
  ];
  const signatureClassOption = $derived(
    SIGNATURE_CLASS_OPTIONS.find((option) => option.value === sub.signatureClass) ?? SIGNATURE_CLASS_OPTIONS[0]!,
  );

  let savingPermissions = $state(false);

  async function saveSettings(patch: Partial<Pick<Subscriber, 'protocolDownloadsAllowed' | 'signatureClass'>>, revert: () => void) {
    savingPermissions = true;
    try {
      await updateSubscriber(sub.partnerId, sub.userId, patch);
      await invalidateAll();
    } catch (err) {
      revert();
      alert(err instanceof Error ? err.message : 'Update failed');
    } finally {
      savingPermissions = false;
    }
  }

  function handleProtocolDownloads(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const allowed = input.checked;
    saveSettings({ protocolDownloadsAllowed: allowed }, () => (input.checked = !allowed));
  }

  function handleSignatureClass(e: Event) {
    const select = e.currentTarget as HTMLSelectElement;
    const previous = sub.signatureClass;
    saveSettings({ signatureClass: select.value as SignatureClass }, () => (select.value = previous));
  }

  async function handleDelete() {
    if (!confirm(`Delete subscriber ${sub.partnerId}/${sub.userId}?`)) return;
    try {
      await deleteSubscriber(sub.partnerId, sub.userId);
      goto(`${base}/subscribers`);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Delete failed');
    }
  }
</script>

<div class="mb-6">
  <a href="{base}/subscribers" class="text-sm text-base-content/50 hover:text-base-content inline-flex items-center gap-1">
    <Icon name="chevronLeft" class="w-3.5 h-3.5" /> Subscribers
  </a>
</div>

<div class="flex items-start justify-between mb-6">
  <div>
    <h1 class="text-2xl font-bold font-mono">{sub.partnerId} / {sub.userId}</h1>
    <div class="flex items-center gap-3 mt-2">
      <StateBadge state={sub.state} />
      <span class="text-sm text-base-content/50">
        Created {new Date(sub.createdAt + 'Z').toLocaleDateString()}
      </span>
      <span class="text-sm text-base-content/30">|</span>
      <span class="text-sm text-base-content/50">
        Updated {new Date(sub.updatedAt + 'Z').toLocaleString()}
      </span>
    </div>
  </div>
  <div class="flex gap-2">
    {#if sub.state === 'INITIALIZED'}
      <button class="btn btn-success btn-sm gap-1.5" onclick={handleActivate}>Activate</button>
    {/if}
    {#if sub.state === 'READY'}
      <button class="btn btn-warning btn-outline btn-sm gap-1.5" onclick={handleSuspend}>
        Suspend
      </button>
    {/if}
    {#if sub.state === 'SUSPENDED'}
      <button class="btn btn-success btn-sm gap-1.5" onclick={handleReactivate}>
        Reactivate
      </button>
    {/if}
    <button class="btn btn-ghost btn-sm text-error gap-1.5" onclick={handleDelete}>
      <Icon name="trash" class="w-3.5 h-3.5" /> Delete
    </button>
  </div>
</div>

<!-- State-specific alerts -->
{#if sub.state === 'NEW'}
  <div class="bg-info/10 border border-info/20 rounded-xl p-4 mb-6 text-sm">
    <div class="font-medium text-info mb-1">Awaiting Key Initialization</div>
    Client needs to send both INI (signature key) and HIA (authentication + encryption keys) before activation.
  </div>
{:else if sub.state === 'PARTIALLY_INITIALIZED_INI'}
  <div class="bg-warning/10 border border-warning/20 rounded-xl p-4 mb-6 text-sm">
    <div class="font-medium text-warning mb-1">INI Complete — Waiting for HIA</div>
    Signature key received. Client still needs to send HIA with authentication and encryption keys.
  </div>
{:else if sub.state === 'PARTIALLY_INITIALIZED_HIA'}
  <div class="bg-warning/10 border border-warning/20 rounded-xl p-4 mb-6 text-sm">
    <div class="font-medium text-warning mb-1">HIA Complete — Waiting for INI</div>
    Authentication and encryption keys received. Client still needs to send INI with signature key.
  </div>
{:else if sub.state === 'INITIALIZED'}
  <div class="bg-info/10 border border-info/20 rounded-xl p-4 mb-6 text-sm">
    <div class="font-medium text-info mb-1">Ready for Activation</div>
    All keys received (INI + HIA complete). Click <strong>Activate</strong> to enable EBICS access.
  </div>
{:else if sub.state === 'READY'}
  <div class="bg-success/10 border border-success/20 rounded-xl p-4 mb-6 text-sm">
    <div class="font-medium text-success mb-1">Active</div>
    Subscriber can perform EBICS operations. Keys can be rotated via PUB (signature), HCA (auth+encryption), or HCS (all keys).
  </div>
{:else if sub.state === 'SUSPENDED'}
  <div class="bg-error/10 border border-error/20 rounded-xl p-4 mb-6 text-sm">
    <div class="font-medium text-error mb-1">Suspended</div>
    All EBICS requests from this subscriber are rejected. This may have been triggered by an SPR request from the client or by an admin action. Click <strong>Reactivate</strong> to restore access.
  </div>
{/if}

<!-- Permissions -->
<h2 class="text-lg font-semibold mb-4">Permissions</h2>
<div class="bg-base-200 rounded-xl p-4 mb-6 flex flex-col gap-4">
  <div class="flex items-start gap-3">
    <select
      class="select select-bordered select-sm font-mono w-20 shrink-0"
      aria-label="Signature class"
      value={sub.signatureClass}
      disabled={savingPermissions}
      onchange={handleSignatureClass}
    >
      {#each SIGNATURE_CLASS_OPTIONS as option (option.value)}
        <option value={option.value}>{option.value}</option>
      {/each}
    </select>
    <span class="min-w-0">
      <span class="text-sm font-medium">Signature class {sub.signatureClass}: {signatureClassOption.label}</span>
      <span class="block text-xs text-base-content/50 mt-0.5">{signatureClassOption.description}</span>
    </span>
  </div>
  <label class="flex items-start gap-3 cursor-pointer">
    <input
      type="checkbox"
      class="toggle toggle-success toggle-sm mt-0.5"
      checked={sub.protocolDownloadsAllowed}
      disabled={savingPermissions}
      onchange={handleProtocolDownloads}
    />
    <span>
      <span class="text-sm font-medium">Protocol downloads (<span class="font-mono">HAC</span>, <span class="font-mono">PTK</span>)</span>
      <span class="block text-xs text-base-content/50 mt-0.5">
        When off, HAC and PTK downloads of this subscriber are refused with <span class="font-mono">090003</span>
        (EBICS_AUTHORISATION_ORDER_TYPE_FAILED) and HKD/HTD no longer list them as permissions of this user.
      </span>
    </span>
  </label>
</div>

<!-- Key overview -->
<div class="flex items-center justify-between mb-4">
  <h2 class="text-lg font-semibold">Keys</h2>
  <span class="text-xs text-base-content/40">{keyCount}/3 keys submitted</span>
</div>

<div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
  <div class="bg-base-200 rounded-xl p-4">
    <div class="flex items-center justify-between mb-2">
      <h3 class="text-sm font-semibold">Signature</h3>
      {#if sub.keys.signatureVersion}
        <span class="badge badge-outline badge-xs font-mono">{sub.keys.signatureVersion}</span>
      {/if}
    </div>
    {#if sub.keys.signatureCertificate}
      <div class="text-[11px] text-base-content/40 uppercase tracking-wider mb-1">SHA-256</div>
      <CertFingerprint pem={sub.keys.signatureCertificate} />
      <div class="mt-2">
        <button class="text-xs text-base-content/50 hover:text-base-content" onclick={() => sigPemOpen = !sigPemOpen}>
          {sigPemOpen ? 'Hide' : 'Show'} PEM
        </button>
        {#if sigPemOpen}
          <pre class="text-xs bg-base-300 p-2 rounded-lg mt-1 overflow-x-auto whitespace-pre-wrap break-all max-h-32">{sub.keys.signatureCertificate}</pre>
        {/if}
      </div>
    {:else}
      <p class="text-sm text-base-content/30 italic">Not submitted</p>
      <p class="text-xs text-base-content/20 mt-1">Set via INI or PUB</p>
    {/if}
  </div>

  <div class="bg-base-200 rounded-xl p-4">
    <div class="flex items-center justify-between mb-2">
      <h3 class="text-sm font-semibold">Authentication</h3>
      {#if sub.keys.authenticationVersion}
        <span class="badge badge-outline badge-xs font-mono">{sub.keys.authenticationVersion}</span>
      {/if}
    </div>
    {#if sub.keys.authenticationCertificate}
      <div class="text-[11px] text-base-content/40 uppercase tracking-wider mb-1">SHA-256</div>
      <CertFingerprint pem={sub.keys.authenticationCertificate} />
      <div class="mt-2">
        <button class="text-xs text-base-content/50 hover:text-base-content" onclick={() => authPemOpen = !authPemOpen}>
          {authPemOpen ? 'Hide' : 'Show'} PEM
        </button>
        {#if authPemOpen}
          <pre class="text-xs bg-base-300 p-2 rounded-lg mt-1 overflow-x-auto whitespace-pre-wrap break-all max-h-32">{sub.keys.authenticationCertificate}</pre>
        {/if}
      </div>
    {:else}
      <p class="text-sm text-base-content/30 italic">Not submitted</p>
      <p class="text-xs text-base-content/20 mt-1">Set via HIA or HCA/HCS</p>
    {/if}
  </div>

  <div class="bg-base-200 rounded-xl p-4">
    <div class="flex items-center justify-between mb-2">
      <h3 class="text-sm font-semibold">Encryption</h3>
      {#if sub.keys.encryptionVersion}
        <span class="badge badge-outline badge-xs font-mono">{sub.keys.encryptionVersion}</span>
      {/if}
    </div>
    {#if sub.keys.encryptionCertificate}
      <div class="text-[11px] text-base-content/40 uppercase tracking-wider mb-1">SHA-256</div>
      <CertFingerprint pem={sub.keys.encryptionCertificate} />
      <div class="mt-2">
        <button class="text-xs text-base-content/50 hover:text-base-content" onclick={() => encPemOpen = !encPemOpen}>
          {encPemOpen ? 'Hide' : 'Show'} PEM
        </button>
        {#if encPemOpen}
          <pre class="text-xs bg-base-300 p-2 rounded-lg mt-1 overflow-x-auto whitespace-pre-wrap break-all max-h-32">{sub.keys.encryptionCertificate}</pre>
        {/if}
      </div>
    {:else}
      <p class="text-sm text-base-content/30 italic">Not submitted</p>
      <p class="text-xs text-base-content/20 mt-1">Set via HIA or HCA/HCS</p>
    {/if}
  </div>
</div>

<!-- Key management reference -->
<div class="bg-base-200 rounded-xl p-4">
  <h3 class="text-sm font-semibold mb-2">Key Management Reference</h3>
  <div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
    <div>
      <div class="font-mono font-bold mb-0.5">INI</div>
      <div class="text-base-content/50">Initial signature key upload</div>
    </div>
    <div>
      <div class="font-mono font-bold mb-0.5">HIA</div>
      <div class="text-base-content/50">Initial auth + encryption keys</div>
    </div>
    <div>
      <div class="font-mono font-bold mb-0.5">PUB</div>
      <div class="text-base-content/50">Rotate signature key</div>
    </div>
    <div>
      <div class="font-mono font-bold mb-0.5">HCA</div>
      <div class="text-base-content/50">Rotate auth + encryption keys</div>
    </div>
    <div>
      <div class="font-mono font-bold mb-0.5">HCS</div>
      <div class="text-base-content/50">Rotate all three keys</div>
    </div>
    <div>
      <div class="font-mono font-bold mb-0.5">SPR</div>
      <div class="text-base-content/50">Client-initiated suspension</div>
    </div>
    <div>
      <div class="font-mono font-bold mb-0.5">HPB</div>
      <div class="text-base-content/50">Download bank public keys</div>
    </div>
  </div>
</div>
