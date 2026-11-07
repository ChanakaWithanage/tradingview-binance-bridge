// A content script survives popup closure. It only asks the worker to read the
// visible TradingView tab; it does NOT inspect TradingView internals or trade.
(() => {
  if (window !== window.top) return;
  let pending = false;
  setInterval(async () => {
    if (pending || document.visibilityState !== 'visible') return;
    pending = true;
    try { await chrome.runtime.sendMessage({ type: 'POLL' }); }
    catch (_) { /* extension disabled/reloaded */ }
    finally { pending = false; }
  }, 2500);
})();