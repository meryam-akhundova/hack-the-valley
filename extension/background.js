// Clicking the toolbar icon opens the monitor page in a pinned tab.
// The monitor page holds the serial connection, so it must stay open.
const MONITOR_URL = chrome.runtime.getURL('monitor.html');

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: MONITOR_URL, pinned: true });
});

// Never start with pages stuck dimmed.
function resetDim() {
  chrome.storage.local.set({ slouchState: { slouching: false } });
}
chrome.runtime.onStartup.addListener(resetDim);
chrome.runtime.onInstalled.addListener(resetDim);
