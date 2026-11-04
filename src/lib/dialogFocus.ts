
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      element.getAttribute("aria-hidden") !== "true" &&
      (element.offsetParent !== null || element.getClientRects().length > 0)
  );
}

export function nextFocusIndex(current: number, count: number, shift: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return shift ? count - 1 : 0;
  return shift ? (current - 1 + count) % count : (current + 1) % count;
}

export function resolveDialogKey(event: { key: string }): "close" | "tab" | "none" {
  if (event.key === "Escape") return "close";
  if (event.key === "Tab") return "tab";
  return "none";
}

let lastOutsideFocus: HTMLElement | null = null;
let tracking = false;

export function trackFocusOutsideDialogs(): void {
  if (tracking || typeof document === "undefined") return;
  tracking = true;
  document.addEventListener(
    "focusin",
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target === document.body) return;
      if (target.closest('[role="dialog"]')) return;
      lastOutsideFocus = target;
    },
    true
  );
}

export function captureReturnFocus(active: Element | null): HTMLElement | null {
  if (typeof document === "undefined") return null;
  if (active instanceof HTMLElement && active !== document.body) return active;
  return lastOutsideFocus;
}

export function resolveReturnFocus(
  captured: HTMLElement | null,
  fallback?: (() => HTMLElement | null) | null
): HTMLElement | null {
  if (typeof document === "undefined") return null;
  if (captured && document.contains(captured)) return captured;
  const explicit = fallback?.();
  if (explicit && document.contains(explicit)) return explicit;
  return defaultReturnFocus();
}

export function defaultReturnFocus(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const main = document.querySelector<HTMLElement>("main");
  return main && document.contains(main) ? main : null;
}
