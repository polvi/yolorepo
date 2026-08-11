// Visit slider: index into the visits array (sorted by captured_at); the
// page toggles group visibility on change.

export interface TimelineEntry {
  visitId: string;
  capturedAt: number;
}

export function createTimeline(
  entries: TimelineEntry[],
  onChange: (index: number) => void
): { el: HTMLElement; set(index: number): void } {
  const el = document.createElement('div');
  el.className = 'viewer-timeline';
  const fmt = (ts: number) =>
    new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

  el.innerHTML = `
    <input type="range" min="0" max="${entries.length - 1}" step="1"
      value="${entries.length - 1}" aria-label="Visit" ${entries.length < 2 ? 'disabled' : ''} />
    <div class="dates">
      <span>${fmt(entries[0]!.capturedAt)}</span>
      <span class="current"></span>
      <span>${fmt(entries[entries.length - 1]!.capturedAt)}</span>
    </div>`;

  const input = el.querySelector('input')!;
  const current = el.querySelector('.current')!;
  const update = () => {
    const i = Number(input.value);
    current.textContent = fmt(entries[i]!.capturedAt);
    onChange(i);
  };
  input.addEventListener('input', update);

  return {
    el,
    set(index: number) {
      input.value = String(index);
      update();
    },
  };
}
