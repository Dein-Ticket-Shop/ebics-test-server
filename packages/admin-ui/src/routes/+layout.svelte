<script lang="ts">
  import '../app.css';
  import { base } from '$app/paths';
  import { page } from '$app/state';
  import type { Snippet } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';

  interface Props {
    children: Snippet;
  }

  const { children }: Props = $props();

  const navItems = [
    { href: '/', label: 'Dashboard', icon: 'dashboard' },
    { href: '/subscribers', label: 'Subscribers', icon: 'subscribers' },
    { href: '/host', label: 'Host Config', icon: 'host' },
    { href: '/activity', label: 'Activity Log', icon: 'activity' },
    { href: '/protocol-log', label: 'Protocol Log', icon: 'protocol' },
  ];

  const bankingItems = [
    { href: '/banking', label: 'Bank Config', icon: 'bank', exact: true },
    { href: '/banking/persons', label: 'Persons', icon: 'persons', exact: false },
    { href: '/banking/accounts', label: 'Accounts', icon: 'accounts', exact: false },
  ];

  const paymentItems = [
    { href: '/payments', label: 'Payment Orders', icon: 'payments', exact: false },
    { href: '/hac', label: 'Customer Protocol', icon: 'hac', exact: false },
  ];

  function isActive(href: string, exact = false): boolean {
    const path = page.url.pathname;
    if (href === '/') return path === `${base}` || path === `${base}/`;
    if (exact) return path === `${base}${href}` || path === `${base}${href}/`;
    return path.startsWith(`${base}${href}`);
  }
</script>

<div class="drawer lg:drawer-open">
  <input id="drawer" type="checkbox" class="drawer-toggle" />
  <div class="drawer-content flex flex-col min-h-screen">
    <div class="navbar bg-base-100 border-b border-base-300 lg:hidden">
      <div class="flex-none">
        <label for="drawer" class="btn btn-ghost btn-square">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="inline-block h-5 w-5 stroke-current">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path>
          </svg>
        </label>
      </div>
      <div class="flex-1">
        <span class="text-lg font-bold">EBICS Admin</span>
      </div>
    </div>
    <main class="flex-1 p-6 bg-base-100">
      {@render children()}
    </main>
  </div>
  <div class="drawer-side">
    <label for="drawer" aria-label="close sidebar" class="drawer-overlay"></label>
    <nav class="bg-base-200 min-h-full w-64 flex flex-col">
      <div class="p-5 pb-2">
        <a href="{base}/" class="text-xl font-bold block tracking-tight">EBICS Admin</a>
        <div class="text-base-content/40 text-xs mt-0.5">H005 Test Server</div>
      </div>
      <div class="px-3 pt-4">
        <div class="text-[11px] font-medium text-base-content/40 uppercase tracking-wider px-3 mb-1">Protocol</div>
        <ul class="menu menu-sm gap-0.5 p-0 w-full [--menu-active-bg:var(--color-primary)] [--menu-active-fg:var(--color-primary-content)]">
          {#each navItems as item}
            <li>
              <a
                href="{base}{item.href}"
                class="gap-3 rounded-lg {isActive(item.href) ? 'menu-active font-semibold' : ''}"
                aria-current={isActive(item.href) ? 'page' : undefined}
              >
                <Icon
                  name={item.icon}
                  class="w-[18px] h-[18px] {isActive(item.href) ? '' : 'opacity-70'}"
                  strokeWidth={isActive(item.href) ? 2.25 : 1.5}
                />
                {item.label}
              </a>
            </li>
          {/each}
        </ul>
      </div>
      <div class="px-3 pt-5">
        <div class="text-[11px] font-medium text-base-content/40 uppercase tracking-wider px-3 mb-1">Banking</div>
        <ul class="menu menu-sm gap-0.5 p-0 w-full [--menu-active-bg:var(--color-primary)] [--menu-active-fg:var(--color-primary-content)]">
          {#each bankingItems as item}
            <li>
              <a
                href="{base}{item.href}"
                class="gap-3 rounded-lg {isActive(item.href, item.exact) ? 'menu-active font-semibold' : ''}"
                aria-current={isActive(item.href, item.exact) ? 'page' : undefined}
              >
                <Icon
                  name={item.icon}
                  class="w-[18px] h-[18px] {isActive(item.href, item.exact) ? '' : 'opacity-70'}"
                  strokeWidth={isActive(item.href, item.exact) ? 2.25 : 1.5}
                />
                {item.label}
              </a>
            </li>
          {/each}
        </ul>
      </div>
      <div class="px-3 pt-5">
        <div class="text-[11px] font-medium text-base-content/40 uppercase tracking-wider px-3 mb-1">Payments</div>
        <ul class="menu menu-sm gap-0.5 p-0 w-full [--menu-active-bg:var(--color-primary)] [--menu-active-fg:var(--color-primary-content)]">
          {#each paymentItems as item}
            <li>
              <a
                href="{base}{item.href}"
                class="gap-3 rounded-lg {isActive(item.href, item.exact) ? 'menu-active font-semibold' : ''}"
                aria-current={isActive(item.href, item.exact) ? 'page' : undefined}
              >
                <Icon
                  name={item.icon}
                  class="w-[18px] h-[18px] {isActive(item.href, item.exact) ? '' : 'opacity-70'}"
                  strokeWidth={isActive(item.href, item.exact) ? 2.25 : 1.5}
                />
                {item.label}
              </a>
            </li>
          {/each}
        </ul>
      </div>
      <div class="mt-auto p-4 pt-6">
        <div class="text-[11px] text-base-content/30 px-1">
          EBICS H005 Test Server v0.1.0
        </div>
      </div>
    </nav>
  </div>
</div>
