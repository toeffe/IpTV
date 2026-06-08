(function () {
  var k = 'toeffe-theme';
  var t;
  var params = new URLSearchParams(window.location.search);
  var urlT = params.get('theme');
  if (urlT === 'light' || urlT === 'dark') {
    t = urlT;
    try { localStorage.setItem(k, t); } catch (e) {}
    try {
      var u = new URL(window.location.href);
      u.searchParams.delete('theme');
      history.replaceState(null, '', u.pathname + u.search + u.hash);
    } catch (e2) {}
  } else {
    var s = null;
    try { s = localStorage.getItem(k); } catch (e) {}
    if (s === 'light' || s === 'dark') {
      t = s;
    } else {
      t = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
  }
  document.documentElement.dataset.theme = t;
  document.documentElement.style.colorScheme = t === 'light' ? 'light' : 'dark';
})();
