<script lang="ts">
  import { useRegisterSW } from 'virtual:pwa-register/svelte';

  const CHECK_INTERVAL_MS = 60 * 60 * 1000;

  let reg: ServiceWorkerRegistration | undefined;
  let status: 'idle' | 'checking' | 'current' | 'updating' = $state('idle');

  // autoUpdate mode: the plugin runtime reloads the page as soon as an
  // updated worker activates, so no prompt UI is needed here — this
  // component only schedules checks and offers a manual force-check.
  useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      reg = registration;
      if (!registration) return;
      setInterval(() => void registration.update(), CHECK_INTERVAL_MS);
      // Installed PWAs mostly discover deploys when brought back to the
      // foreground, not on the hourly timer.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void registration.update();
      });
    },
  });

  async function forceCheck() {
    if (status === 'checking' || status === 'updating') return;
    if (!reg) {
      // Dev mode or SW-less browser: nothing to compare against.
      status = 'current';
      setTimeout(() => (status = 'idle'), 1500);
      return;
    }
    status = 'checking';
    try {
      await reg.update();
      if (reg.installing || reg.waiting) {
        status = 'updating'; // the page reloads once the new worker activates
      } else {
        status = 'current';
        setTimeout(() => (status = 'idle'), 1500);
      }
    } catch {
      status = 'idle';
    }
  }

  const shortVersion = __BUILD_VERSION__.split(' ')[0];
</script>

<button
  class="version"
  data-status={status}
  onclick={forceCheck}
  title={`Build ${__BUILD_VERSION__} — click to check for updates`}
>
  {#if status === 'checking'}
    Checking…
  {:else if status === 'updating'}
    Updating…
  {:else if status === 'current'}
    Up to date
  {:else}
    {shortVersion}
  {/if}
</button>

<style>
  .version {
    font: inherit;
    font-size: 0.78rem;
    font-variant-numeric: tabular-nums;
    color: var(--muted);
    background: none;
    border: 1px solid var(--rule);
    border-radius: 999px;
    padding: 0.1rem 0.55rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .version:hover {
    color: var(--ink);
  }
  .version[data-status='current'] {
    color: #3fa860;
    border-color: #3fa860;
  }
  .version[data-status='updating'] {
    color: var(--accent);
    border-color: var(--accent);
  }
</style>
