// Runs on every web page. Adds a dark overlay when the monitor says you're slouching.
(() => {
  let overlay = null;

  function getOverlay() {
    if (overlay && overlay.isConnected) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'slouch-dimmer-overlay';
    overlay.textContent = 'Sit up straight';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483647', 'pointer-events:none',
      'background:#000', 'opacity:0', 'transition:opacity 0.8s ease',
      'display:flex', 'align-items:flex-end', 'justify-content:center',
      'padding-bottom:10vh', 'color:#fff',
      'font:600 22px/1.2 system-ui, sans-serif', 'letter-spacing:0.02em'
    ].join(';');
    (document.body || document.documentElement).appendChild(overlay);
    return overlay;
  }

  function apply(state) {
    if (state && state.slouching) {
      const el = getOverlay();
      const target = String(state.dim ?? 0.6);
      // wait a frame so the fade-in transition actually animates
      requestAnimationFrame(() => { el.style.opacity = target; });
    } else if (overlay) {
      overlay.style.opacity = '0';
    }
  }

  chrome.storage.local.get('slouchState').then((r) => apply(r.slouchState));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.slouchState) apply(changes.slouchState.newValue);
  });
})();
