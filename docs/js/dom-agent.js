/* DomAgent — page snapshot + DOM action runner + cloud runner bridge
 * - askAssistant(textOrOptions): sends page snapshot + user text to Supabase Edge Function "assistant"
 *   RETURNS a normalized { reply, actions? }   (maps { error } -> reply: "Error: …")
 * - runActions(actions): executes navigate/click/input/scroll/focus/announce/snapshot
 */

(function (w) {
  const DomAgent = {};

  // Try supabase-js if present; otherwise fall back to direct fetch.
  const hasSB = !!w.supabase;
  const sb = hasSB ? w.supabase.createClient(w.SUPABASE_URL, w.SUPABASE_ANON_KEY) : null;
  const PROJECT_REF = (w.SUPABASE_URL || "").split("https://")[1]?.split(".")[0] || "";
  const ASSISTANT_URL = PROJECT_REF
    ? `https://${PROJECT_REF}.functions.supabase.co/assistant`
    : "";

  // live region for announcements
  const live = document.createElement("div");
  live.id = "assistant-live";
  live.setAttribute("aria-live", "polite");
  live.setAttribute("aria-atomic", "true");
  live.style.position = "fixed";
  live.style.left = "-9999px";
  live.style.top = "0";
  document.body.appendChild(live);

  // -------- snapshot --------
  function snapshotPage(maxChars = 6000) {
    const url = location.href;
    const title = document.title || "";
    let text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    if (text.length > maxChars) text = text.slice(0, maxChars);
    return { url, title, text };
  }

  // -------- util finders --------
  function elMatchesText(list, re) {
    for (const el of list) {
      const t = (el.innerText || el.textContent || "").trim();
      if (re.test(t)) return el;
    }
    return null;
  }
  function findByText(txt) {
    const re = new RegExp(txt, "i");
    let el =
      elMatchesText(document.querySelectorAll("button, [role='button']"), re) ||
      elMatchesText(document.querySelectorAll("a, [role='link']"), re);
    if (el) return el;
    el = elMatchesText(document.querySelectorAll("input[type='button'],input[type='submit']"), re);
    if (el) return el;
    return elMatchesText(document.querySelectorAll("body *"), re);
  }
  function findInput({ selector, placeholder }) {
    if (selector) return document.querySelector(selector);
    if (placeholder) {
      const re = new RegExp(placeholder, "i");
      const els = document.querySelectorAll("input, textarea, [contenteditable='true']");
      for (const el of els) {
        const ph = el.getAttribute("placeholder") || "";
        const name = el.getAttribute("name") || "";
        const aria = el.getAttribute("aria-label") || "";
        if (re.test(ph) || re.test(name) || re.test(aria)) return el;
      }
    }
    return null;
  }

  // -------- runner --------
  function announce(text) {
    if (!text) return;
    live.textContent = text;
    console.debug("[assistant]", text);
  }
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  function sameOrigin(u) {
    try { return new URL(u, location.href).origin === location.origin; } catch { return false; }
  }

  async function runActions(actions = []) {
    for (const a of actions) {
      if (!a || !a.type) continue;

      if (a.type === "navigate") {
        const href = a.url ? a.url : a.path ? new URL(a.path, location.origin).toString() : null;
        if (href && sameOrigin(href)) {
          announce(a.announce || "Navigating.");
          location.href = href;
          return; // new page
        } else {
          announce("Blocked cross-origin navigation.");
        }
      }

      else if (a.type === "click") {
        let el = a.selector ? document.querySelector(a.selector) : null;
        if (!el && a.text) el = findByText(a.text);
        if (el) {
          announce(a.announce || `Clicking ${a.text || a.selector || ""}`);
          el.click();
          await delay(50);
        } else {
          announce(`Couldn't find ${a.text || a.selector || "target"}.`);
        }
      }

      else if (a.type === "input") {
        const el = findInput(a) || (a.selector ? document.querySelector(a.selector) : null);
        if (el) {
          if ("value" in el) el.value = a.value ?? "";
          else if (el.isContentEditable) el.textContent = a.value ?? "";
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          announce(a.announce || "Filled input.");
          await delay(20);
        }
      }

      else if (a.type === "scroll") {
        if (a.to === "top") window.scrollTo({ top: 0, behavior: "smooth" });
        else if (a.to === "bottom") window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
        else if (typeof a.y === "number") window.scrollTo({ top: a.y, behavior: "smooth" });
        else if (a.selector) { const el = document.querySelector(a.selector); if (el) el.scrollIntoView({ behavior: "smooth", block: "center" }); }
        announce(a.announce || "Scrolling.");
        await delay(80);
      }

      else if (a.type === "focus") {
        const el = a.selector ? document.querySelector(a.selector) : a.text ? findByText(a.text) : null;
        if (el && el.focus) { el.focus(); announce(a.announce || "Focused."); await delay(20); }
      }

      else if (a.type === "announce") {
        announce(a.text || a.announce || "");
      }

      else if (a.type === "snapshot") {
        console.debug("snapshot:", snapshotPage());
      }
    }
  }

  // -------- normalization --------
  function normalizeAssistantResponse(json) {
    if (!json) return { reply: "(no response)", actions: [] };
    if (json.error) return { reply: `Error: ${json.error}`, actions: [] };
    const reply =
      json.reply ??
      json.text ??
      (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) ??
      "";
    return { reply: reply || "(no reply)", actions: Array.isArray(json.actions) ? json.actions : [] };
  }

  // -------- ask assistant (with snapshot) --------
  async function askAssistant(textOrOptions, opts = {}) {
    const payload = typeof textOrOptions === "string"
      ? { text: textOrOptions }
      : (textOrOptions || {});
    payload.username = String(opts.username || payload.username || "there");
    payload.page_snapshot = snapshotPage();

    let json = null;
    if (sb) {
      // Edge Function always returns 200 with JSON; read body and decide client-side.
      const { data, error } = await sb.functions.invoke("assistant", { body: payload });
      if (error) {
        // This path is now rare (network/runtime). Surface it.
        return { reply: `Error: ${error.message || "assistant failed"}`, actions: [] };
      }
      json = data;
    } else if (ASSISTANT_URL) {
      const r = await fetch(ASSISTANT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      json = await r.json();
    } else {
      return { reply: "Error: No Supabase client or functions URL available.", actions: [] };
    }

    const normalized = normalizeAssistantResponse(json);
    if (normalized.actions?.length) await runActions(normalized.actions);
    return normalized; // { reply, actions? }
  }

  // -------- recorder (optional) --------
  let recording = null;
  function startRecorder() {
    if (recording) return recording;
    recording = { steps: [] };
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey, true);
    announce("Recording started.");
    return recording;
  }
  function stopRecorder() {
    if (!recording) return { steps: [] };
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("keydown", onKey, true);
    const out = recording;
    recording = null;
    announce("Recording stopped.");
    return out;
  }
  function onClick(e) {
    if (!recording) return;
    const t = e.target;
    const label = (t.innerText || t.textContent || "").trim().slice(0, 100);
    recording.steps.push({ action: "clickText", text: label || "Submit" });
  }
  function onKey(e) {
    if (!recording) return;
    if (["Enter", "Escape", "Tab"].includes(e.key)) {
      recording.steps.push({ action: "press", key: e.key });
    }
  }

  // Execute recorded plan in Cloudflare via assistant bridge
  async function runInCloud(steps, opts = {}) {
    const payload = {
      browser_task: {
        startUrl: opts.startUrl || location.href,
        steps: steps || [],
        timeoutMs: opts.timeoutMs || 45000,
        viewport: opts.viewport || { width: 1280, height: 900 }
      }
    };
    let json = null;
    if (sb) {
      const { data, error } = await sb.functions.invoke("assistant", { body: payload });
      if (error) return { reply: `Error: ${error.message || "browser_task failed"}`, actions: [] };
      json = data;
    } else if (ASSISTANT_URL) {
      const r = await fetch(ASSISTANT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      json = await r.json();
    }
    return json; // passthrough of the worker bridge result
  }

  // export
  w.DomAgent = {
    snapshotPage,
    askAssistant,
    runActions,
    startRecorder,
    stopRecorder,
    runInCloud
  };
})(window);
