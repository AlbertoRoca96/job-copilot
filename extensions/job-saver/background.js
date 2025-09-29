// background.js (service worker)
chrome.runtime.onInstalled.addListener(() => {
  // defaults
  chrome.storage.sync.set({
    supabaseUrl: "https://YOUR-PROJECT.functions.supabase.co",
    functionPath: "/save-job",
    userJwt: ""
  });
});

// keep last scrape stored per tab
const lastByTab = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "SCRAPE_RESULT" && sender.tab?.id != null) {
    lastByTab.set(sender.tab.id, msg.payload);
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === "GET_LAST" && sender.tab?.id != null) {
    sendResponse({ ok: true, payload: lastByTab.get(sender.tab.id) || null });
    return true;
  }
  if (msg?.type === "SAVE_JOB") {
    chrome.storage.sync.get(["supabaseUrl", "functionPath", "userJwt"], async (cfg) => {
      try {
        const url = (cfg.supabaseUrl || "").replace(/\/$/, "") + (cfg.functionPath || "");
        const r = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + (cfg.userJwt || "")
          },
          body: JSON.stringify(msg.payload)
        });
        const j = await r.json();
        sendResponse({ ok: r.ok, status: r.status, body: j });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    });
    return true; // async
  }
});
