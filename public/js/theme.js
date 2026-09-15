(function () {
  const KEY = "mrstark-theme-v3";

  function applyTheme(theme) {
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    document.querySelectorAll(".theme-toggle").forEach(function (button) {
      const icon = button.querySelector(".theme-icon");
      const label = button.querySelector(".theme-label");
      const dark = theme === "dark";
      if (icon) icon.textContent = dark ? "☀" : "☾";
      if (label) label.textContent = dark ? "Light mode" : "Dark mode";
      button.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
      button.setAttribute("title", dark ? "Switch to light mode" : "Switch to dark mode");
    });
  }

  // Default is LIGHT (white). A saved choice in the current theme version may override it.
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  applyTheme(saved === "dark" ? "dark" : "light");

  window.toggleMrStarkTheme = function () {
    const next = document.documentElement.getAttribute("data-theme") === "dark"
      ? "light" : "dark";
    applyTheme(next);
    try { localStorage.setItem(KEY, next); } catch (e) {}
  };

  document.addEventListener("click", function (event) {
    const button = event.target.closest(".theme-toggle");
    if (button) window.toggleMrStarkTheme();
  });

  // Header button is injected into common header/topbar areas where available.
  document.addEventListener("DOMContentLoaded", function () {
    const candidates = [
      document.querySelector(".topbar"),
      document.querySelector(".header"),
      document.querySelector(".page-header"),
      document.querySelector("main")
    ].filter(Boolean);

    if (!document.querySelector(".theme-toggle") && candidates.length) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "theme-toggle";
      button.innerHTML = '<span class="theme-icon">☾</span><span class="theme-label">Dark mode</span>';
      candidates[0].appendChild(button);
      applyTheme(document.documentElement.getAttribute("data-theme") || "light");
    }
  });
})();
