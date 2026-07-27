<script lang="ts">
  import { hostedLogin, loginPasskey, logout, registerPasskey } from '$lib/auth';
  import { currentUser } from '$lib/sync-client';

  let busy = $state(false);
  let menuOpen = $state(false);

  async function run(fn: () => Promise<void>) {
    busy = true;
    menuOpen = false;
    try {
      await fn();
    } catch (err) {
      console.warn('auth failed, offering hosted flow', err);
      if (confirm('Passkey sign-in did not complete here. Use the hosted sign-in page instead?')) {
        hostedLogin();
      }
    } finally {
      busy = false;
    }
  }
</script>

{#if $currentUser}
  <button class="ghost" disabled={busy} onclick={() => run(logout)}>Sign out</button>
{:else}
  <div class="auth">
    <button class="primary" disabled={busy} onclick={() => run(loginPasskey)}>
      {busy ? '…' : 'Sign in'}
    </button>
    <button class="ghost" disabled={busy} onclick={() => (menuOpen = !menuOpen)} aria-label="More sign-in options">▾</button>
    {#if menuOpen}
      <div class="menu">
        <button onclick={() => run(registerPasskey)}>Create account (passkey)</button>
        <button onclick={() => hostedLogin()}>Hosted sign-in page</button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .auth {
    position: relative;
    display: flex;
    gap: 0.25rem;
  }
  .primary {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 0.45rem;
    padding: 0.4rem 0.9rem;
    font-weight: 600;
    cursor: pointer;
  }
  .ghost {
    background: none;
    border: 1px solid var(--rule);
    border-radius: 0.45rem;
    padding: 0.4rem 0.6rem;
    cursor: pointer;
    color: inherit;
  }
  .menu {
    position: absolute;
    right: 0;
    top: calc(100% + 0.35rem);
    background: var(--card);
    border: 1px solid var(--rule);
    border-radius: 0.5rem;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
    display: flex;
    flex-direction: column;
    min-width: 13rem;
    z-index: 40;
  }
  .menu button {
    background: none;
    border: none;
    text-align: left;
    padding: 0.6rem 0.8rem;
    cursor: pointer;
    color: inherit;
  }
  .menu button:hover {
    background: var(--well);
  }
</style>
