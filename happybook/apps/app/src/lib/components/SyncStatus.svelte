<script lang="ts">
  import { syncState } from '$lib/sync-client';

  const LABELS: Record<string, string> = {
    'local-only': 'Local only',
    idle: 'Synced',
    syncing: 'Syncing…',
    offline: 'Offline',
    error: 'Sync error',
  };
</script>

<span class="status" data-state={$syncState} title={$syncState === 'local-only' ? 'Sign in to back up and sync your notebooks' : undefined}>
  <span class="dot"></span>
  <span class="label">{LABELS[$syncState]}</span>
</span>

<style>
  .status {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.78rem;
    color: var(--muted);
    white-space: nowrap;
  }
  .dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--muted);
  }
  .status[data-state='idle'] .dot {
    background: #3fa860;
  }
  .status[data-state='syncing'] .dot {
    background: #d9a13b;
    animation: pulse 1s infinite alternate;
  }
  .status[data-state='error'] .dot,
  .status[data-state='offline'] .dot {
    background: #c0392b;
  }
  @keyframes pulse {
    to {
      opacity: 0.4;
    }
  }
  @media (max-width: 420px) {
    .label {
      display: none; /* the dot alone carries the state on tiny screens */
    }
  }
</style>
