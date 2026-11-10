
export type PaletteKeyAction =
  | { type: "none" }
  | { type: "close" }
  | { type: "close-panel" }
  | { type: "move"; delta: 1 | -1 }
  | { type: "move-panel"; delta: 1 | -1 }
  | { type: "open-panel" }
  | { type: "run" }
  | { type: "run-secondary" }
  | { type: "settings" }
  | { type: "digit"; index: number };

export interface PaletteKeyInput {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export interface PaletteKeyState {
  query: string;
  selected: number;
  count: number;
  panelOpen: boolean;
}

const NONE: PaletteKeyAction = { type: "none" };

export function resolvePaletteKey(
  input: PaletteKeyInput,
  state: PaletteKeyState
): PaletteKeyAction {
  const ctrl = Boolean(input.ctrlKey || input.metaKey);

  if (input.key === "Escape") {
    return state.panelOpen ? { type: "close-panel" } : { type: "close" };
  }

  if (input.key === "ArrowDown") {
    return state.panelOpen ? { type: "move-panel", delta: 1 } : { type: "move", delta: 1 };
  }

  if (input.key === "ArrowUp") {
    return state.panelOpen ? { type: "move-panel", delta: -1 } : { type: "move", delta: -1 };
  }

  if (input.key === "Tab") {
    return state.panelOpen ? { type: "close-panel" } : { type: "open-panel" };
  }

  if (input.key === "Enter") {
    if (state.panelOpen) return { type: "run" };
    return ctrl ? { type: "run-secondary" } : { type: "run" };
  }

  if (ctrl && input.key === ",") return { type: "settings" };

  if (
    !ctrl &&
    !input.altKey &&
    !state.panelOpen &&
    state.query.length === 0 &&
    /^[1-9]$/.test(input.key)
  ) {
    const index = Number(input.key) - 1;
    if (index < state.count) return { type: "digit", index };
  }

  return NONE;
}

export function wrapIndex(index: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return 0;
  return (index + delta + count) % count;
}
