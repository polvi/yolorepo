<script lang="ts">
  import { currentUser } from '$lib/sync-client';

  type Settings =
    | { enabled: false }
    | { enabled: true; password: string; passwordGrouped: string; url: string };

  let open = $state(false);
  let busy = $state(false);
  let settings = $state<Settings | null>(null);
  let copied = $state<'url' | 'password' | null>(null);

  async function load() {
    const res = await fetch('/api/opds-settings');
    if (res.ok) settings = (await res.json()) as Settings;
  }

  async function toggle() {
    open = !open;
    if (open && !settings) void load();
  }

  async function call(method: 'POST' | 'DELETE') {
    busy = true;
    try {
      const res = await fetch('/api/opds-settings', { method });
      if (res.ok) settings = (await res.json()) as Settings;
    } finally {
      busy = false;
    }
  }

  function regenerate() {
    if (settings?.enabled && !confirm('Replace the current password? Your e-reader will need the new one.')) return;
    void call('POST');
  }

  function disable() {
    if (!confirm('Disable the OPDS catalog? The password will stop working.')) return;
    void call('DELETE');
  }

  async function copy(kind: 'url' | 'password', text: string) {
    await navigator.clipboard.writeText(text);
    copied = kind;
    setTimeout(() => (copied = null), 1500);
  }
</script>

{#if $currentUser}
  <div class="opds">
    <button class="ghost" onclick={toggle}>OPDS</button>
    {#if open}
      <div class="panel">
        <h3>Read on your e-reader</h3>
        {#if !settings}
          <p class="muted">Loading…</p>
        {:else if !settings.enabled}
          <p class="muted">
            Publish your books as an OPDS catalog so KOReader (or any OPDS reader) can browse and
            download them, protected by a generated password.
          </p>
          <button class="primary" disabled={busy} onclick={() => void call('POST')}>
            {busy ? '…' : 'Enable OPDS catalog'}
          </button>
        {:else}
          {@const s = settings}
          <div class="row">
            <span class="label">Catalog URL</span>
            <code>{s.url}</code>
            <button class="ghost small" onclick={() => copy('url', s.url)}>
              {copied === 'url' ? 'Copied' : 'Copy'}
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
            Enter the URL exactly as shown, including https:// — most readers will not follow
            the redirect from http. Username: <strong>reader</strong> (any value works, but many
            readers send no password at all when the username is blank). Capitalization and
            spaces in the password don't matter.
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
  .opds {
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
