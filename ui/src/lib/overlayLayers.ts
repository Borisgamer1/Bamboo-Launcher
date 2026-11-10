import { useLayoutEffect } from "react";

type OverlayTier = "menu" | "toast";

let menuCount = 0;
let toastCount = 0;

const sync = () => {
  const tier: OverlayTier | "" = menuCount > 0 ? "menu" : toastCount > 0 ? "toast" : "";
  if (tier) document.documentElement.dataset.overlayTier = tier;
  else delete document.documentElement.dataset.overlayTier;
};

export function useOverlayLayer(tier: OverlayTier, active: boolean) {
  useLayoutEffect(() => {
    if (!active) return;
    if (tier === "menu") menuCount += 1;
    else toastCount += 1;
    sync();
    return () => {
      if (tier === "menu") menuCount = Math.max(0, menuCount - 1);
      else toastCount = Math.max(0, toastCount - 1);
      sync();
    };
  }, [tier, active]);
}
