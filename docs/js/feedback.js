// docs/js/feedback.js
// Floating feedback FAB + modal (Bug / Suggestion / Question / Praise)
// Captures optional screenshot (html2canvas) + console buffer.
// Submits to Edge Function: "feedback-submit".

/* global html2canvas */
(async function () {
  await new Promise(r => window.addEventListener("load", r));

  // Ensure Supabase client present (re-uses globals you already set)
  const supabase = (window.supabase || await (async () => {
    const s = document.createElement("script");
    s.src = "https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.js";
    s.defer = true;
    await new Promise((res, rej) => { s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    return window.supabase;
  })()).createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

  // Console buffer
  const consoleBuffer = [];
  ["log","warn","error"].forEach(level => {
    const orig = console[level];
    console[level] = function (...args) {
      try { consoleBuffer.push({ level, args: args.map(String), t: Date.now() }); } catch {}
      orig.apply(console, args);
    };
  });
  window.addEventListener("error", (e) => consoleBuffer.push({ level:"error", args:[String(e.message||"error")], t:Date.now() }));
  window.addEventListener("unhandledrejection", (e) => consoleBuffer.push({ level:"error", args:[String(e.reason||"rejection")], t:Date.now() }));

  // Styles
  const css = `
#feedbackFab{position:fixed;right:16px;bottom:16px;z-index:9999;background:#111;color:#fff;border:none;border-radius:999px;padding:10px 14px;cursor:pointer;box-shadow:0 4px 18px rgba(0,0,0,.15)}
#feedbackFab:hover{opacity:.92}
#fbOverlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;z-index:9998}
#fbModal{position:fixed;left:50%;top:54px;transform:translateX(-50%);width:min(720px,calc(100vw - 24px));max-height:calc(100vh - 108px);overflow:auto;background:#fff;border:1px solid #e5e5e5;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.25);padding:12px;display:none;z-index:9999}
#fbModal h3{margin:4px 0 8px}
.fb-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.fb-pill{border:1px solid #ddd;border-radius:999px;padding:4px 10px;cursor:pointer;background:#f8f8f8}
.fb-pill[data-active="true"]{background:#111;color:#fff;border-color:#111}
.fb-ctl{width:100%;padding:10px;border:1px solid #e0e0e0;border-radius:8px}
.fb-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}
.fb-muted{color:#666;font-size:12px}
.fb-inline{display:inline-flex;gap:6px;align-items:center}
.fb-tag{display:inline-block;border:1px solid #eee;background:#fafafa;border-radius:6px;padding:2px 6px;font-size:12px}
  `;
  const style = document.createElement("style"); style.textContent = css; document.head.appendChild(style);

  // DOM
  const fab = document.createElement("button");
  fab.id = "feedbackFab"; fab.type = "button"; fab.textContent = "🪲 Feedback";
  document.body.appendChild(fab);

  const overlay = document.createElement("div"); overlay.id = "fbOverlay"; document.body.appendChild(overlay);
  const modal = document.createElement("div"); modal.id = "fbModal"; document.body.appendChild(modal);

  modal.innerHTML = `
    <h3>Tell us what you think</h3>
    <div class="fb-row" role="tablist" aria-label="Feedback type">
      ${["bug","suggestion","question","praise"].map((t,i)=>`<button class="fb-pill" data-type="${t}" ${i===0?'data-active="true"':''}>${t[0].toUpperCase()+t.slice(1)}</button>`).join("")}
    </div>
    <div class="fb-row" style="margin-top:8px">
      <input id="fbSubject" class="fb-ctl" type="text" placeholder="Short summary (optional)" />
    </div>
    <div class="fb-row">
      <textarea id="fbMessage" class="fb-ctl" rows="6" placeholder="Describe the issue or idea… (Please avoid pasting sensitive info)"></textarea>
    </div>
    <div class="fb-row"><input id="fbEmail" class="fb-ctl" type="email" placeholder="Email (optional, for follow-up)" /></div>
    <div class="fb-row fb-muted">
      <label class="fb-inline"><input type="checkbox" id="fbIncludeShot" checked/> Include screenshot</label>
      <label class="fb-inline"><input type="checkbox" id="fbIncludeConsole" checked/> Include console errors</label>
      <label class="fb-inline"><input type="checkbox" id="fbHighPriority"/> Mark as high severity</label>
    </div>
    <div class="fb-row">
      <details style="width:100%">
        <summary class="fb-muted">Advanced</summary>
        <div class="fb-row" style="margin-top:6px"><textarea id="fbSteps" class="fb-ctl" rows="4" placeholder="Steps to reproduce (optional)"></textarea></div>
        <div class="fb-row fb-muted">
          <span class="fb-tag">Page: <strong id="fbPageTag"></strong></span>
          <span class="fb-tag">URL: <strong id="fbUrlTag"></strong></span>
          <span class="fb-tag">UA: <strong id="fbUaTag"></strong></span>
        </div>
      </details>
    </div>
    <div class="fb-actions">
      <a id="fbIdeasLink" class="fb-muted" href="feedback.html" target="_blank" rel="noopener">Open full feedback page ↗</a>
      <button id="fbCancel" type="button" class="fb-pill">Cancel</button>
      <button id="fbSend"   type="button" class="fb-pill" style="background:#2e7d32;color:#fff;border-color:#2e7d32">Send</button>
    </div>
    <div id="fbStatus" class="fb-muted" role="status" aria-live="polite" style="margin-top:6px"></div>
  `;

  const pills = [...modal.querySelectorAll(".fb-pill[data-type]")];
  let fType = "bug";
  pills.forEach(b => b.addEventListener("click", () => {
    pills.forEach(x => x.dataset.active = "false");
    b.dataset.active = "true"; fType = b.dataset.type || "bug";
  }));

  modal.querySelector("#fbPageTag").textContent = document.querySelector("h1,h2")?.textContent?.trim() || "unknown";
  modal.querySelector("#fbUrlTag").textContent  = location.href;
  modal.querySelector("#fbUaTag").textContent   = navigator.userAgent;

  const open = () => { overlay.style.display="block"; modal.style.display="block"; modal.querySelector("#fbMessage").focus(); };
  const close = () => { overlay.style.display="none"; modal.style.display="none"; };
  overlay.addEventListener("click", close);
  modal.querySelector("#fbCancel").addEventListener("click", close);
  document.getElementById("feedbackFab").addEventListener("click", open);

  async function captureScreenshot() {
    if (!window.html2canvas) {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js";
      await new Promise((res, rej) => { s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    }
    const canvas = await html2canvas(document.body, {
      ignoreElements: el => el.id === "fbModal" || el.id === "fbOverlay" || el.closest?.("[data-no-screenshot]")
    });
    return canvas.toDataURL("image/png", 0.92);
  }

  modal.querySelector("#fbSend").addEventListener("click", async () => {
    const subject = modal.querySelector("#fbSubject").value.trim();
    const message = modal.querySelector("#fbMessage").value.trim();
    const email   = modal.querySelector("#fbEmail").value.trim();
    const includeShot = modal.querySelector("#fbIncludeShot").checked;
    const includeConsole = modal.querySelector("#fbIncludeConsole").checked;
    const high = modal.querySelector("#fbHighPriority").checked;
    const steps = modal.querySelector("#fbSteps").value.trim();
    const status = modal.querySelector("#fbStatus");

    if (!message) { status.textContent = "Please enter a message."; return; }
    status.textContent = "Sending…";

    let screenshot_data_url = null;
    if (includeShot) {
      try { screenshot_data_url = await captureScreenshot(); } catch {}
    }

    try {
      const payload = {
        type: fType,
        subject,
        message,
        email: email || undefined,
        page: document.querySelector("h1,h2")?.textContent?.trim() || undefined,
        url: location.href,
        app_version: window.APP_VERSION || undefined,
        user_agent: navigator.userAgent,
        severity: high ? "high" : undefined,
        steps: steps || undefined,
        console: includeConsole ? consoleBuffer.slice(-200) : undefined,
        replay_url: window.FEEDBACK_SESSION_URL || undefined,
        screenshot_data_url
      };
      const { data, error } = await supabase.functions.invoke("feedback-submit", { body: payload });
      if (error) { status.textContent = "Server error: " + (error.message || "failed"); return; }
      status.textContent = "Thanks! Feedback ID: " + (data?.id || "sent");
      setTimeout(close, 1200);
    } catch (e) {
      status.textContent = "Error: " + (e?.message || e);
    }
  });
})();
