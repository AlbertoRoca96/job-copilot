/* DomAgent — page snapshot + DOM action runner + cloud runner bridge
 * Snapshot now includes "targets" inventory (visible links/buttons).
 * askAssistant() runs returned actions automatically.
 */
(function (w) {
  const DomAgent = {};

  // Supabase client (optional; falls back to direct fetch)
  const hasSB = !!w.supabase;
  const sb = hasSB ? (w.__sbclient || (w.__sbclient = w.supabase.createClient(w.SUPABASE_URL, w.SUPABASE_ANON_KEY))) : null;
  const PROJECT_REF = (w.SUPABASE_URL || "").split("https://")[1]?.split(".")[0] || "";
  const ASSISTANT_URL = PROJECT_REF ? `https://${PROJECT_REF}.functions.supabase.co/assistant` : "";

  // Live region for announcements
  const live = document.createElement("div");
  live.id = "assistant-live";
  live.setAttribute("aria-live", "polite");
  live.setAttribute("aria-atomic", "true");
  Object.assign(live.style, { position: "fixed", left: "-9999px", top: "0" });
  document.body.appendChild(live);

  // -------- utilities --------
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  function announce(text){ if (text) { live.textContent = text; console.debug("[assistant]", text); } }
  function sameOrigin(u){ try { return new URL(u, location.href).origin === location.origin; } catch { return false; } }
  function isVisible(el){
    if (!el) return false;
    const r = el.getClientRects?.();
    return !!r && r.length > 0 && !!(el.offsetWidth || el.offsetHeight || (r && r.length));
  }

  function bestLabel(el){
    return (
      el.getAttribute?.("aria-label") || el.getAttribute?.("title") || el.getAttribute?.("name") ||
      (typeof el.value === "string" ? el.value : "") ||
      el.innerText || el.textContent || ""
    ).toString().replace(/\s+/g, " ").trim().slice(0, 120);
  }

  function cssEscapeSafe(s){
    const esc = (w.CSS && w.CSS.escape) ? w.CSS.escape : (x => x);
    return esc(String(s));
  }

  function quickSelector(el){
    if (!el) return "";
    if (el.id) return `#${cssEscapeSafe(el.id)}`;
    const da = el.getAttribute?.("data-action"); if (da) return `[data-action="${cssEscapeSafe(da)}"]`;
    const name = el.getAttribute?.("name"); if (name) return `[name="${cssEscapeSafe(name)}"]`;
    const cls = (el.className || "").toString().trim().split(/\s+/)[0] || "";
    return cls ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase();
  }

  function snapshotTargets(limit = 40){
    const nodes = document.querySelectorAll('a,button,[role="button"],input[type="button"],input[type="submit"],[data-action]');
    const out = [];
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      const role = el.tagName && el.tagName.toLowerCase() === "a" ? "link" : "button";
      out.push({
        role,
        text: bestLabel(el),
        href: el.getAttribute?.("href") || "",
        selector: quickSelector(el)
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  function snapshotPage(maxChars = 6000) {
    const url = location.href;
    const title = document.title || "";
    let text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    if (text.length > maxChars) text = text.slice(0, maxChars);
    const targets = snapshotTargets();
    return { url, title, text, targets };
  }

  // -------- finders --------
  function matchText(el, re){
    const t = (el.innerText || el.textContent || "").trim();
    const aria = el.getAttribute?.("aria-label") || el.getAttribute?.("title") || el.getAttribute?.("name") || el.getAttribute?.("value") || "";
    return re.test(t) || re.test(String(aria));
  }
  function findByText(txt){
    const re = new RegExp(txt, "i");
    const groups = [
      "button, [role='button'], input[type='button'], input[type='submit']",
      "a, [role='link']",
      "body *"
    ];
    for (const sel of groups) {
      const list = document.querySelectorAll(sel);
      for (const el of list) if (isVisible(el) && matchText(el, re)) return el;
    }
    return null;
  }
  function findInput({ selector, placeholder }) {
    if (selector) return document.querySelector(selector);
    if (placeholder) {
      const re = new RegExp(placeholder, "i");
      const els = document.querySelectorAll("input, textarea, [contenteditable='true']");
      for (const el of els) {
        const ph = el.getAttribute("placeholder") || "";
        const name = el.getAttribute("name") || "";
        const aria = el.getAttribute("aria-label") || el.getAttribute("title") || "";
        if (re.test(ph) || re.test(name) || re.test(aria)) return el;
      }
    }
    return null;
  }

  // -------- runner --------
  async function runActions(actions = []) {
    for (const a of actions) {
      if (!a || !a.type) continue;

      if (a.type === "navigate") {
        let href = a.url || (a.path ? new URL(a.path, location.origin).toString() : "");
        if (!href && a.text) {
          const link = findByText(a.text);
          if (link && link.getAttribute?.("href")) href = new URL(link.getAttribute("href"), location.href).toString();
        }
        if (href && sameOrigin(href)) { announce(a.announce || "Navigating."); location.href = href; return; }
        announce("Blocked cross-origin navigation.");
      }

      else if (a.type === "click") {
        let el = a.selector ? document.querySelector(a.selector) : null;
        if (!el && a.text) el = findByText(a.text);
        if (el && el.click) { announce(a.announce || `Clicking ${a.text || a.selector || ""}`); el.click(); await delay(60); }
        else announce(`Couldn't find ${a.text || a.selector || "target"}.`);
      }

      else if (a.type === "input" || a.type === "type") {
        const el = findInput(a) || (a.selector ? document.querySelector(a.selector) : null);
        if (el) {
          if ("value" in el) el.value = a.value ?? "";
          else if (el.isContentEditable) el.textContent = a.value ?? "";
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          announce(a.announce || "Filled input."); await delay(30);
        } else announce(`Couldn't find input ${a.selector || a.placeholder || ""}.`);
      }

      else if (a.type === "scroll") {
        if (a.to === "top") window.scrollTo({ top: 0, behavior: "smooth" });
        else if (a.to === "bottom") window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
        else if (typeof a.y === "number") window.scrollTo({ top: a.y, behavior: "smooth" });
        else if (a.selector) {
          const el = document.querySelector(a.selector);
          if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        announce(a.announce || "Scrolling."); await delay(100);
      }

      else if (a.type === "focus") {
        const el = a.selector ? document.querySelector(a.selector) : (a.text ? findByText(a.text) : null);
        if (el && el.focus) { el.focus(); announce(a.announce || "Focused."); await delay(20); }
      }

      else if (a.type === "announce") announce(a.text || a.announce || "");
      else if (a.type === "snapshot") console.debug("snapshot:", snapshotPage());
    }
  }

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

  async function askAssistant(textOrOptions, opts = {}) {
    const payload = typeof textOrOptions === "string" ? { text: textOrOptions } : (textOrOptions || {});
    payload.username = String(opts.username || payload.username || "there");
    payload.page_snapshot = snapshotPage();

    let json = null;
    if (sb) {
      const { data, error } = await sb.functions.invoke("assistant", { body: payload });
      if (error) return { reply: `Error: ${error.message || "assistant failed"}`, actions: [] };
      json = data;
    } else if (ASSISTANT_URL) {
      const r = await fetch(ASSISTANT_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      json = await r.json();
    } else {
      return { reply: "Error: No Supabase client or functions URL available.", actions: [] };
    }

    const normalized = normalizeAssistantResponse(json);
    if (normalized.actions?.length) await runActions(normalized.actions);
    return normalized;
  }

  // Optional recorder (tidy, JS only)
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
    const out = recording; recording = null; announce("Recording stopped."); return out;
  }
  function onClick(e) {
    if (!recording) return;
    const t = e.target;
    const label = (t && (t.innerText || t.textContent) || "").trim().slice(0, 100);
    recording.steps.push({ action: "clickText", text: label || "Submit" });
  }
  function onKey(e) {
    if (!recording) return;
    if (["Enter","Escape","Tab"].includes(e.key)) recording.steps.push({ action: "press", key: e.key });
  }

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
      const r = await fetch(ASSISTANT_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      json = await r.json();
    }
    return json;
  }

  w.DomAgent = { snapshotPage, askAssistant, runActions, startRecorder, stopRecorder, runInCloud };
})(window);
