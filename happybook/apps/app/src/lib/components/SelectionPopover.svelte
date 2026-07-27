<script lang="ts">
  const COLORS = ['#ffd54a', '#7ed491', '#7fb8ff', '#ff9ac2'];

  let {
    x,
    y,
    armed = false,
    onHighlight,
    onClear,
    onLink,
  }: {
    x: number;
    y: number;
    armed?: boolean;
    onHighlight: (color: string) => void;
    onClear: () => void;
    onLink: () => void;
  } = $props();
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="popover" style={`left:${x}px; top:${y}px;`} onclick={(e) => e.stopPropagation()}>
  {#if armed}
    <button class="link-btn" onclick={onLink}>Link to this selection</button>
  {:else}
    {#each COLORS as color (color)}
      <button
        class="swatch"
        style={`background:${color}`}
        aria-label={`Highlight ${color}`}
        onclick={() => onHighlight(color)}
      ></button>
    {/each}
    <button class="swatch clear" aria-label="Remove highlights here" title="Remove highlights here" onclick={onClear}></button>
    <span class="sep"></span>
    <button class="link-btn" onclick={onLink}>Link…</button>
  {/if}
</div>

<style>
  .popover {
    position: absolute;
    transform: translate(-50%, -100%) translateY(-8px);
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: #26221d;
    color: #eee;
    border-radius: 0.5rem;
    padding: 0.4rem 0.5rem;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    z-index: 30;
    white-space: nowrap;
  }
  .swatch {
    width: 1.35rem;
    height: 1.35rem;
    border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.6);
    cursor: pointer;
    padding: 0;
  }
  .clear {
    position: relative;
    background: transparent;
  }
  .clear::after {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    width: 1.3rem;
    height: 2px;
    background: rgba(255, 255, 255, 0.75);
    transform: translate(-50%, -50%) rotate(-45deg);
  }
  .sep {
    width: 1px;
    height: 1.1rem;
    background: rgba(255, 255, 255, 0.25);
  }
  .link-btn {
    background: none;
    border: none;
    color: #f0a58a;
    font-weight: 600;
    cursor: pointer;
    font-size: 0.95rem;
    padding: 0.25rem 0.35rem;
  }
</style>
