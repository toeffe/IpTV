(function () {
  const KEY = 'toeffe-theme';
  const root = document.documentElement;

  function syncToggle() {
    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    const isLight = root.dataset.theme === 'light';
    btn.textContent = isLight ? 'Dark page' : 'Bright page';
    const aria = isLight
      ? 'Switch to a dark page background (easier in low light)'
      : 'Switch to a bright page background (easier in daylight)';
    btn.setAttribute('aria-label', aria);
    btn.setAttribute('title', aria);
    btn.setAttribute('aria-pressed', String(isLight));
  }

  document.getElementById('themeToggle')?.addEventListener('click', function () {
    const next = root.dataset.theme === 'light' ? 'dark' : 'light';
    root.dataset.theme = next;
    root.style.colorScheme = next === 'light' ? 'light' : 'dark';
    try { localStorage.setItem(KEY, next); } catch (e) {}
    syncToggle();
  });

  syncToggle();

  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function (e) {
    let stored = null;
    try { stored = localStorage.getItem(KEY); } catch (err) {}
    if (stored === 'light' || stored === 'dark') return;
    const next = e.matches ? 'light' : 'dark';
    root.dataset.theme = next;
    root.style.colorScheme = next === 'light' ? 'light' : 'dark';
    syncToggle();
  });
})();
