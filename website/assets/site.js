(() => {
  const header = document.querySelector("[data-header]");
  if (!header) return;

  const button = header.querySelector(".menu-btn");
  const nav = document.getElementById("site-nav");
  const setOpen = (open) => {
    header.classList.toggle("nav-open", open);
    if (!button) return;
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", open ? "Menü schließen" : "Menü öffnen");
  };

  if (button && nav) {
    button.addEventListener("click", () => setOpen(!header.classList.contains("nav-open")));
    nav.addEventListener("click", (event) => {
      if (event.target.closest("a")) setOpen(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") setOpen(false);
    });
    window.matchMedia("(min-width: 961px)").addEventListener("change", (event) => {
      if (event.matches) setOpen(false);
    });
  }

  const onScroll = () => header.classList.toggle("is-scrolled", window.scrollY > 6);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
})();
