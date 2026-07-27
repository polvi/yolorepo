/** Svelte action: focus an input on mount with its contents selected. */
export function focusAndSelect(node: HTMLInputElement): void {
  node.focus();
  node.select();
}
