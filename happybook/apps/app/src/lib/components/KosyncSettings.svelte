<script lang="ts">
  import { currentUser } from '$lib/sync-client';

  type Settings =
    | { enabled: false }
    | { enabled: true; username: string; password: string; passwordGrouped: string; url: string };

  let open = $state(false);
  let busy = $state(false);
  let settings = $state<Settings | null>(null);
  let copied = $state<'url' | 'username' | 'password' | null>(null);

  async function load() {
    const res = await fetch('/api/kosync-settings');
    if (res.ok) settings = (await res.json()) as Settings;
  }

  async function toggle() {
    open = !open;
    if (open && !settings) void load();
  }

  async function call(method: 'POST' | 'DELETE') {
    busy = true;
    try {
      const res = await fetch('/api/kosync-settings', { method });
      if (res.ok) settings = (await res.json()) as Settings;
    } finally {
      busy = false;
    }
  }

  function regenerate() {
    if (settings?.enabled && !confirm('Replace the current credentials? Your device will need to log in again.')) return;
    void call('POST');
  }

  function disable() {
    if (!confirm('Disable progress sync? The credentials will stop working.')) return;
    void call('DELETE');
  }

  async function copy(kind: 'url' | 'username' | 'password', text: string) {
    await navigator.clipboard.writeText(text);
    copied = kind;
    setTimeout(() => (copied = null), 1500);
  }
</script>

{#if $currentUser}
  <div class="kosync">
    <button class="ghost" onclick={toggle}>Progress</button>
    {#if open}
      <div class="panel">
        <h3>Sync reading progress</h3>
        {#if !settings}
          <p class="muted">Loading…</p>
        {:else if !settings.enabled}
          <p class="muted">
            Keep your place across devices: KOReader's progress sync can point at happybook, so
            the page you stop on follows you between your e-reader and the web.
          </p>
          <button class="primary" disabled={busy} onclick={() => void call('POST')}>
            {busy ? '…' : 'Enable progress sync'}
          </button>
        {:else}
          {@const s = settings}
          <div class="row">
            <span class="label">Server URL</span>
            <code>{s.url}</code>
            <button class="ghost small" onclick={() => copy('url', s.url)}>
              {copied === 'url' ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div class="row">
            <span class="label">Username</span>
            <code>{s.username}</code>
            <button class="ghost small" onclick={() => copy('username', s.username)}>
              {copied === 'username' ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div class="row">
            <span class="label">Password</span>
            <code class="pw">{s.passwordGrouped}</code>
            <button class="ghost small" onclick={() => copy('password', s.password)}>
              {copied === 'password' ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p class="muted">
            In KOReader: Tools, Progress sync, Custom sync server, then this URL. Use
            <strong>Login</strong> (not Register) with the username and password above. Type the
            password in lowercase without spaces; the device hashes what you type, so it must
            match exactly.
          </p>
          <div class="actions">
            <button class="ghost small" disabled={busy} onclick={regenerate}>Regenerate</button>
            <button class="ghost small danger" disabled={busy} onclick={disable}>Disable</button>
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .kosync {
    position: relative;
  }
  .ghost {
    background: none;
    border: 1px solid var(--rule);
    border-radius: 0.45rem;
    padding: 0.4rem 0.6rem;
    cursor: pointer;
    color: inherit;
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
  .panel {
    position: absolute;
    right: 0;
    top: calc(100% + 0.35rem);
    background: var(--card);
    border: 1px solid var(--rule);
    border-radius: 0.5rem;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
    padding: 0.8rem;
    width: min(22rem, calc(100vw - 2rem));
    z-index: 40;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  h3 {
    margin: 0;
    font-size: 0.95rem;
  }
  .muted {
    margin: 0;
    color: var(--muted);
    font-size: 0.8rem;
    line-height: 1.4;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .label {
    flex-shrink: 0;
    font-size: 0.75rem;
    color: var(--muted);
    width: 5.5rem;
  }
  code {
    flex: 1;
    min-width: 0;
    font-size: 0.75rem;
    background: var(--well);
    border-radius: 0.3rem;
    padding: 0.3rem 0.4rem;
    overflow-x: auto;
    white-space: nowrap;
  }
  .pw {
    font-size: 0.9rem;
    letter-spacing: 0.05em;
  }
  .small {
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
  }
  .danger {
    color: var(--accent);
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
  }
</style>
