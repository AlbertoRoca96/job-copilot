<!-- js/dom-agent.js -->
<script>
/**
 * DomAgent — lightweight client helper
 * - snapshotPage(): url/title/visible text for the model
 * - askAssistant(text): POSTs to Supabase Edge Function with snapshot
 * - runActions(actions): performs navigate/click/input/scroll/focus/announce/snapshot
 * - recorder: startRecorder()/stopRecorder() to capture steps, then runInCloud(steps)
 */

(function (w) {
  const DomAgent = {};

  // === CONFIG ===
  // 1) Supabase Edge Function (assistant)
  //    Replace with your project ref if different:
  const ASSISTANT_URL = 'https://imozfqawxpsasjdmgdkh.functions.supabase.co/assistant';
  // 2) Optional: local display name
  const DEFAULT_USERNAME = 'there';

  // live region for screenreader announcements
  const live = document.createElement('div');
  live.id = 'assistant-live';
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');
  live.style.position = 'fixed';
  live.style.left = '-9999px';
  live.style.top = '0';
  document.body.appendChild(live);

  // --- snapshot ---
  function snapshotPage(maxChars = 4000) {
    const url = location.href;
    const title = document.title || '';
    // innerText gives rendered, visible text (ignores script/style/hidden)
    let text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    if (text.length > maxChars) text = text.slice(0, maxChars);
    return { url, title, text };
  }

  // --- helper finds ---
  function elMatchesText(list, re) {
    for (const el of list) {
      const t = (el.innerText || el.textContent || '').trim();
      if (re.test(t)) return el;
    }
    return null;
  }
  function findByText(txt) {
    const re = new RegExp(txt, 'i');
    // prefer buttons/links
    let el = elMatchesText(document.querySelectorAll('button, [role="button"]'), re)
          || elMatchesText(document.querySelectorAll('a, [role="link"]'), re);
    if (el) return el;
    // fallback: any clickable-ish
    el = elMatchesText(document.querySelectorAll('input[type="button"], input[type="submit"]'), re);
    if (el) return el;
    return elMatchesText(document.querySelectorAll('body *'), re);
  }
  function findInput({ selector, placeholder }) {
    if (selector) return document.querySelector(selector);
    if (placeholder) {
      const re = new RegExp(placeholder, 'i');
      const els = document.querySelectorAll('input, textarea, [contenteditable="true"]');
      for (const el of els) {
        const ph = el.getAttribute('placeholder') || '';
        const name = el.getAttribute('name') || '';
        const aria = el.getAttribute('aria-label') || '';
        if (re.test(ph) || re.test(name) || re.test(aria)) return el;
      }
    }
    return null;
  }

  // --- action runner ---
  async function runActions(actions = []) {
    for (const a of actions) {
      if (!a || !a.type) continue;

      if (a.type === 'navigate') {
        const href = a.url
          ? a.url
          : a.path
          ? new URL(a.path, location.origin).toString()
          : null;
        if (href) {
          announce(a.announce || 'Navigating.');
          location.href = href;
          return; // stop further actions; new page will load
        }
      }

      else if (a.type === 'click') {
        let el = a.selector ? document.querySelector(a.selector) : null;
        if (!el && a.text) el = findByText(a.text);
        if (el) {
          announce(a.announce || `Clicking ${a.text || a.selector || ''}`);
          el.click();
          await delay(50);
        }
      }

      else if (a.type === 'input') {
        const el = findInput(a) || (a.selector ? document.querySelector(a.selector) : null);
        if (el) {
          if ('value' in el) el.value = a.value ?? '';
          else if (el.isContentEditable) el.textContent = a.value ?? '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          await delay(20);
        }
      }

      else if (a.type === 'scroll') {
        if (a.to === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
        else if (a.to === 'bottom') window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        else if (typeof a.y === 'number') window.scrollTo({ top: a.y, behavior: 'smooth' });
        await delay(80);
      }

      else if (a.type === 'focus') {
        const el = a.selector ? document.querySelector(a.selector) : null;
        if (el) { el.focus(); await delay(20); }
      }

      else if (a.type === 'announce') {
        announce(a.announce || a.text || '');
      }

      else if (a.type === 'snapshot') {
        // some flows may ask for a fresh snapshot mid-run
        const snap = snapshotPage();
        // no automatic round-trip here; your app can send it back if desired
        console.debug('snapshot:', snap);
      }
    }
  }

  function announce(text) {
    if (!text) return;
    live.textContent = text;
    console.debug('[assistant]', text);
  }
  const delay = (ms) => new Promise(r => setTimeout(r, ms));

  // --- talk to Edge Function ---
  async function askAssistant(userText, opts = {}) {
    const payload = {
      text: String(userText || ''),
      username: String(opts.username || DEFAULT_USERNAME),
      page_snapshot: snapshotPage()
    };
    const r = await fetch(ASSISTANT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'omit' // CORS handled server-side
    });
    const json = await r.json();
    if (json?.actions?.length) {
      await runActions(json.actions);
    }
    return json; // { reply, actions? }
  }

  // --- simple recorder (optional) ---
  let recording = null;
  function startRecorder() {
    if (recording) return recording;
    recording = { steps: [] };
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);
    announce('Recording started.');
    return recording;
  }
  function stopRecorder() {
    if (!recording) return { steps: [] };
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKey, true);
    const out = recording;
    recording = null;
    announce('Recording stopped.');
    return out;
  }
  function onClick(e) {
    if (!recording) return;
    const t = e.target;
    const label = (t.innerText || t.textContent || '').trim().slice(0, 100);
    recording.steps.push({ action: 'clickText', text: label || 'Submit' });
  }
  function onKey(e) {
    if (!recording) return;
    // only capture Enter/Escape/Tab style keys
    if (['Enter', 'Escape', 'Tab'].includes(e.key)) {
      recording.steps.push({ action: 'press', key: e.key });
    }
  }

  // Run a recorded plan in Cloudflare via Supabase function bridge (server calls Worker)
  async function runInCloud(steps, opts = {}) {
    const r = await fetch(ASSISTANT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The assistant function has a direct 'browser_task' lane we added — see server patch below.
      body: JSON.stringify({
        browser_task: {
          startUrl: opts.startUrl || location.href,
          steps: steps || [],
          timeoutMs: opts.timeoutMs || 45000,
          viewport: opts.viewport || { width: 1280, height: 900 }
        }
      })
    });
    return r.json(); // { ok, finalUrl, results, html, screenshot? }
  }

  DomAgent.snapshotPage = snapshotPage;
  DomAgent.askAssistant = askAssistant;
  DomAgent.runActions = runActions;
  DomAgent.startRecorder = startRecorder;
  DomAgent.stopRecorder = stopRecorder;
  DomAgent.runInCloud = runInCloud;

  w.DomAgent = DomAgent;
})(window);
</script>
