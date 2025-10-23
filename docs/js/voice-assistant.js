// js/voice-assistant.js — Realtime voice wired to OpenAI via Supabase Edge
// • Typed messages always call /assistant (tool agent).
// • If Realtime is ON, the agent's reply is spoken by the model.
// • Executes server-proposed DOM actions (navigate/click/input/scroll/focus/announce/snapshot).
// • NEW: Local intent parser (client-side) so commands like “open power edit”,
//   “go to profile”, “scroll to bottom”, “click sign in” work even when the model
//   doesn’t return actions.
// • NEW: Hide/Show — panel collapses to a FAB and keeps listening until you press Stop.

(function () {
  // ---------- Supabase ----------
  const supabase = (window.supabase || (() => { throw new Error("supabase.js not loaded"); })())
    .createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

  // ---------- UI bootstrap (use existing if present; else create) ----------
  let panel = document.getElementById("va-panel");
  let logEl  = document.getElementById("va-log");
  let input  = document.getElementById("va-input");
  let send   = document.getElementById("va-send");
  let listen = document.getElementById("va-listen");
  let stop   = document.getElementById("va-stop");
  let hideBtn= document.getElementById("va-hide");
  let fabBtn = document.getElementById("va-fab");

  function ensureWidget() {
    if (panel && logEl && input && send && listen && stop && hideBtn) return;

    panel = document.createElement("div");
    panel.id = "va-panel";
    panel.style.cssText =
      "position:fixed;right:16px;bottom:16px;width:340px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.1);font:14px system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;z-index:9999";
    panel.innerHTML = `
      <div style="padding:10px 12px;border-bottom:1px solid #eee;display:flex;gap:8px;align-items:center;justify-content:space-between">
        <div style="display:flex;gap:8px;align-items:center">
          <button id="va-listen" type="button">Listen</button>
          <button id="va-stop"   type="button">Stop</button>
        </div>
        <button id="va-hide" type="button" title="Hide (keeps listening)">Hide</button>
      </div>
      <div id="va-log" style="height:220px;overflow:auto;padding:10px 12px"></div>
      <div style="display:flex;gap:8px;padding:10px 12px;border-top:1px solid #eee">
        <input id="va-input" type="text" style="flex:1" placeholder="Type a message… (/search … or /files)"/>
        <button id="va-send" type="button">Send</button>
      </div>
    `;
    document.body.appendChild(panel);

    fabBtn = document.createElement("button");
    fabBtn.id = "va-fab";
    fabBtn.type = "button";
    fabBtn.textContent = "Assistant";
    fabBtn.style.cssText =
      "display:none;position:fixed;right:16px;bottom:16px;padding:10px 12px;border-radius:9999px;border:1px solid #e5e7eb;background:#fff;box-shadow:0 8px 24px rgba(0,0,0,.12);z-index:9999";
    document.body.appendChild(fabBtn);

    logEl  = panel.querySelector("#va-log");
    input  = panel.querySelector("#va-input");
    send   = panel.querySelector("#va-send");
    listen = panel.querySelector("#va-listen");
    stop   = panel.querySelector("#va-stop");
    hideBtn= panel.querySelector("#va-hide");
  }
  ensureWidget();

  // ---------- Hide / Show (panel hides; audio keeps streaming until Stop) ----------
  function showPanel(){ panel.style.display = "";  fabBtn.style.display = "none"; }
  function hidePanel(){ panel.style.display = "none"; fabBtn.style.display = ""; }
  hideBtn?.addEventListener("click", hidePanel);
  fabBtn?.addEventListener("click", showPanel);

  // ---------- Accessibility (ARIA live announcements) ----------
  let live = document.getElementById("va-aria-live");
  if (!live) {
    live = document.createElement("div");
    live.id = "va-aria-live";
    live.setAttribute("aria-live", "polite");
    live.setAttribute("aria-atomic", "true");
    live.style.cssText = "position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden";
    document.body.appendChild(live);
  }
  function announce(text){ live.textContent = text || ""; }

  // ---------- Log helpers ----------
  function esc(s){ return String(s||"").replace(/[&<>]/g,c=>({ "&":"&amp;","<":"&lt;",">":"&gt;" }[c])); }
  function line(role, text){
    const d = document.createElement("div");
    d.style.margin = "6px 0";
    d.innerHTML = `<strong>${esc(role)}:</strong> ${esc(text)}`;
    logEl.appendChild(d);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ---------- Auth display name ----------
  async function getUsername(){
    try {
      const { data } = await supabase.auth.getUser();
      const u = data && data.user;
      if (!u) return "there";
      const n = (u.user_metadata && (u.user_metadata.full_name || u.user_metadata.name)) || null;
      if (n) return n;
      if (u.email) return u.email.split("@")[0];
      return "there";
    } catch { return "there"; }
  }

  // ---------- Edge calls ----------
  async function callAssistant(payload){
    const { data, error } = await supabase.functions.invoke("assistant", { body: payload });
    if (error) throw new Error(error.message || "assistant failed");
    return data;
  }
  async function getRealtimeSession(options = {}){
    const { data, error } = await supabase.functions.invoke("realtime-session", { body: options });
    if (error) throw new Error(error.message || "realtime-session failed");
    if (!data || !data.ephemeral_key || !data.session_url) throw new Error("Invalid realtime-session response");
    return data;
  }

  // ---------- WebRTC state ----------
  let pc = null;
  let dc = null;
  let micStream = null;
  let inboundAudioEl = null;
  let realtimeOn = false;

  function cleanupRealtime(){
    realtimeOn = false;
    try { if (dc) dc.close(); } catch {}
    try { if (pc) pc.close(); } catch {}
    try { if (micStream) micStream.getTracks().forEach(t=>t.stop()); } catch {}
    if (inboundAudioEl) { try { inboundAudioEl.pause(); inboundAudioEl.srcObject = null; } catch {} inboundAudioEl.remove(); }
    pc = dc = micStream = inboundAudioEl = null;
  }

  function waitForICE(pc){
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      function check() {
        if (pc.iceGatheringState === "complete") {
          pc.removeEventListener("icegatheringstatechange", check);
          resolve();
        }
      }
      pc.addEventListener("icegatheringstatechange", check);
      setTimeout(resolve, 1500);
    });
  }

  async function startRealtime(){
    if (realtimeOn) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      line("Assistant", "This browser does not support microphone capture.");
      return;
    }

    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const { ephemeral_key, session_url } = await getRealtimeSession();

      inboundAudioEl = document.createElement("audio");
      inboundAudioEl.autoplay = true;
      inboundAudioEl.playsInline = true;
      inboundAudioEl.style.display = "none";
      document.body.appendChild(inboundAudioEl);

      pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });

      pc.ontrack = (e) => { if (!inboundAudioEl.srcObject) inboundAudioEl.srcObject = e.streams[0]; };
      pc.addTransceiver("audio", { direction: "recvonly" });

      micStream.getTracks().forEach(t => pc.addTrack(t, micStream));

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") line("Assistant","Realtime connected.");
        if (pc.connectionState === "failed")    line("Assistant","WebRTC failed.");
      };

      dc = pc.createDataChannel("oai-events");
      dc.onopen  = () => line("Assistant","Data channel open.");
      dc.onclose = () => line("Assistant","Data channel closed.");
      // Note: you can inspect e.data for streaming events if you want
      dc.onmessage = () => {};

      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      await waitForICE(pc);

      const sdpAnswer = await fetch(session_url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${ephemeral_key}`, "Content-Type": "application/sdp" },
        body: pc.localDescription.sdp,
      }).then(r => r.text());

      const answer = { type: "answer", sdp: sdpAnswer };
      await pc.setRemoteDescription(answer);

      realtimeOn = true;
      line("Assistant", "Listening… (say something or type to make me speak back)");
    } catch (e) {
      const name = (e && (e.name || e.code)) || "";
      if (name === "NotFoundError" || name === "DevicesNotFoundError")       line("Assistant", "Requested device not found. Check microphone availability.");
      else if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError")
        line("Assistant", "Microphone permission denied.");
      else if (name === "InvalidStateError")                                  line("Assistant", "Audio system is in an invalid state. Reload the page and try again.");
      else                                                                     line("Assistant", "Start error: " + (e.message || e));
      cleanupRealtime();
    }
  }

  function stopRealtime(){ cleanupRealtime(); line("Assistant","Stopped."); }

  function sendRealtimeText(text){
    if (!realtimeOn || !dc || dc.readyState !== "open") {
      line("Assistant", "Realtime is not connected. Click Listen first.");
      return;
    }
    dc.send(JSON.stringify({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] }
    }));
    dc.send(JSON.stringify({ type: "response.create" }));
  }

  // ---------- DOM helpers ----------
  function norm(s){ return String(s||"").replace(/\s+/g," ").trim().toLowerCase(); }
  function q(el, sel){ try { return el.querySelector(sel); } catch { return null; } }

  function findByText(text){
    const target = norm(text);
    const tags = ["button","a","summary","div","span"];
    for (const t of tags){
      const nodes = Array.from(document.getElementsByTagName(t));
      for (const n of nodes){
        const label = n.getAttribute("aria-label") || n.getAttribute("title") || n.textContent || "";
        if (norm(label).includes(target)) return n;
      }
    }
    const roleBtns = Array.from(document.querySelectorAll('[role="button"]'));
    for (const n of roleBtns){
      const label = n.getAttribute("aria-label") || n.getAttribute("title") || n.textContent || "";
      if (norm(label).includes(target)) return n;
    }
    return null;
  }

  function safeSameOrigin(url){
    try { return new URL(url, window.location.href).origin === window.location.origin; }
    catch { return false; }
  }

  function extractVisibleText(limit = 8000){
    const parts = [];
    const sel = "h1,h2,h3,h4,main p,section p,button,a";
    document.querySelectorAll(sel).forEach(n => {
      const t = (n.textContent || "").replace(/\s+/g," ").trim();
      if (t && t.length > 2) parts.push(t);
    });
    return parts.join("\n").slice(0, limit);
  }

  async function executeActions(actions){
    if (!Array.isArray(actions) || actions.length === 0) return;
    for (const a of actions){
      try {
        switch (a.type) {
          case "announce": { if (a.text) announce(a.text); break; }
          case "navigate": {
            const href = a.url || a.path || "";
            if (!href) break;
            const u = new URL(href, window.location.href);
            if (!safeSameOrigin(u.href)) { line("Assistant", "Blocked navigation to different origin."); break; }
            if (a.announce) announce(a.announce);
            window.location.href = u.href;
            return; // page reloads
          }
          case "click": {
            let el = null;
            if (a.selector) el = q(document, a.selector);
            if (!el && a.text) el = findByText(a.text);
            if (el && typeof el.click === "function") { if (a.announce) announce(a.announce); el.click(); }
            else line("Assistant", "Could not find element to click (" + (a.text || a.selector || "unknown") + ").");
            break;
          }
          case "input": {
            let el = null;
            if (a.selector) el = q(document, a.selector);
            if (!el && a.placeholder) el = Array.from(document.querySelectorAll("input,textarea"))
              .find(e => norm(e.getAttribute("placeholder")).includes(norm(a.placeholder)));
            if (el && "value" in el) {
              if (typeof el.focus === "function") el.focus();
              el.value = a.value || "";
              try { el.dispatchEvent(new Event("input", { bubbles: true })); } catch {}
              if (a.announce) announce(a.announce);
            } else line("Assistant", "Could not find input " + (a.selector || a.placeholder || "") + ".");
            break;
          }
          case "scroll": {
            if (a.to === "top") window.scrollTo({ top: 0, behavior: "smooth" });
            else if (a.to === "bottom") window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
            else if (typeof a.y === "number") window.scrollTo({ top: a.y, behavior: "smooth" });
            else if (a.selector) { const el = q(document, a.selector); if (el) el.scrollIntoView({ behavior: "smooth", block: "center" }); }
            if (a.announce) announce(a.announce);
            break;
          }
          case "focus": {
            let el = null;
            if (a.selector) el = q(document, a.selector);
            if (!el && a.text) el = findByText(a.text);
            if (el && typeof el.focus === "function") { el.focus(); if (a.announce) announce(a.announce); }
            break;
          }
          case "snapshot": {
            const username = await getUsername();
            const payload = {
              text: a.prompt || "Summarize this page and guide me to the next step.",
              username,
              page_snapshot: {
                url: window.location.href,
                title: document.title,
                text: extractVisibleText(),
              },
            };
            const resp = await callAssistant(payload);
            const out = (resp && resp.reply) || "(no reply)";
            line("Assistant", out);
            if (resp && resp.actions) await executeActions(resp.actions);
            break;
          }
          default: break;
        }
      } catch (e) {
        line("Assistant", "Action error (" + a.type + "): " + (e.message || e));
      }
    }
  }

  // ---------- Local intent parser (client fallback) ----------
  function detectLocalActions(raw) {
    const t = (raw || "").toLowerCase();
    const out = [];
    if (/(^| )(home|go home|back to home)( |$)/.test(t)) out.push({ type: "navigate", path: "/job-copilot/", announce: "Going Home." });
    if (/(open|go to).*(power edit)/.test(t)) out.push({ type: "click", text: "Open Power Edit", announce: "Opening Power Edit." });
    if (/(go to|open).*(profile)/.test(t)) out.push({ type: "click", text: "Go to Profile", announce: "Opening Profile." });
    if (/give feedback|open feedback|feedback/.test(t)) out.push({ type: "click", text: "Give Feedback", announce: "Opening Feedback." });
    if (/start editing|start.*editing/.test(t)) out.push({ type: "click", text: "Start editing", announce: "Starting editor." });
    if (/sign in|log in|login/.test(t)) out.push({ type: "click", text: "Sign in", announce: "Opening sign in." });
    if (/scroll to bottom|scroll down/.test(t)) out.push({ type: "scroll", to: "bottom", announce: "Scrolling to bottom." });
    if (/scroll to top|scroll up/.test(t)) out.push({ type: "scroll", to: "top", announce: "Scrolling to top." });
    const m = t.match(/click (the )?(.+)/); if (m) out.push({ type: "click", text: m[2] });
    return out.slice(0, 10);
  }

  // ---------- Text flow ----------
  async function sendText(){
    const text = (input.value || "").trim();
    if (!text) return;
    line("You", text);
    input.value = "";

    // Immediate local fallback so things click even if the model doesn’t plan actions
    const local = detectLocalActions(text);
    if (local.length) await executeActions(local);

    try {
      const username = await getUsername();
      const resp = await callAssistant({ text, username });
      const out = (resp && resp.reply) || "(no reply)";

      if (realtimeOn && dc && dc.readyState === "open") {
        dc.send(JSON.stringify({
          type: "conversation.item.create",
          item: { type: "message", role: "user", content: [{ type: "input_text", text: out }] }
        }));
        dc.send(JSON.stringify({ type: "response.create" }));
      }

      line("Assistant", out);
      if (resp && resp.actions) await executeActions(resp.actions);
    } catch (e) {
      line("Assistant", "Error: " + (e.message || e));
    }
  }

  // ---------- Wire UI ----------
  send?.addEventListener("click", sendText);
  input?.addEventListener("keydown", (e)=>{ if (e.key === "Enter") sendText(); });
  listen?.addEventListener("click", startRealtime);   // user gesture (iOS friendly)
  stop?.addEventListener("click", stopRealtime);

  // ---------- Greeting ----------
  window.addEventListener("load", async () => {
    try {
      const username = await getUsername();
      const resp = await callAssistant({ greet: true, username });
      line("Assistant", (resp && resp.reply) || (`Hello ${username}, how may I assist you today?`));
    } catch (e) {
      const username = await getUsername();
      line("Assistant", `Hello ${username}, how may I assist you today?`);
      console.warn("assistant greet failed:", e);
    }
  });

  // Console helpers
  window.JobCopilotAssistant = {
    start: startRealtime,
    stop: stopRealtime,
    send: (t)=>{ input.value = t; sendText(); },
    snapshot: async (prompt) => { await executeActions([{ type: "snapshot", prompt }]); }
  };
})();
