<script lang="ts">
  import { usbSupported, syncNotebook, type DeviceSyncResult } from '$lib/mtp-sync';

  let { notebookId }: { notebookId: string } = $props();

  let busy = $state(false);
  let result = $state<DeviceSyncResult | null>(null);
  let error = $state<string | null>(null);

  function summary(r: DeviceSyncResult): string {
    const parts = [`${r.uploaded.length} sent`, `${r.skipped.length} current`];
    if (r.removed.length) parts.push(`${r.removed.length} removed`);
    if (r.missing.length) parts.push(`${r.missing.length} not local yet`);
    return `${r.deviceName}: ${parts.join(', ')}`;
  }

  async function run() {
    busy = true;
    error = null;
    result = null;
    try {
      result = await syncNotebook(notebookId);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Sync failed.';
    } finally {
      busy = false;
    }
  }
</script>

{#if usbSupported()}
  <button
    class="device-sync"
    disabled={busy}
    onclick={run}
    title="Copy this notebook's documents to a USB e-reader over MTP"
  >
    {busy ? 'Syncing…' : '⇄ E-reader'}
  </button>
  {#if result}
    <span class="sync-note ok" title={summary(result)}>{summary(result)}</span>
  {:else if error}
    <span class="sync-note err">{error}</span>
  {/if}
{/if}

<style>
  .device-sync {
    background: none;
    border: 1px solid var(--border, #d0d0d0);
    border-radius: 6px;
    padding: 0.25rem 0.6rem;
    cursor: pointer;
    font: inherit;
    white-space: nowrap;
  }
  .device-sync:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .sync-note {
    font-size: 0.8rem;
    max-width: 16rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sync-note.ok {
    color: #2e6b43;
  }
  .sync-note.err {
    color: #8c2f23;
  }
</style>
