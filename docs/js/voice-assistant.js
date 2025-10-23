// js/voice-assistant.js — Realtime voice wired to OpenAI via Supabase Edge
// Typed messages always call the /assistant tool-using agent. If Realtime is ON,
// the agent's text reply is spoken via the Realtime datachannel. When the agent
// returns DOM actions, we execute them in the browser.
//
// Requires window.SUPABASE_URL, window.SUPABASE_ANON_KEY and supabase.js.

(function () {
  // ---------- Supabase ----------
  const supabase = (window.supabase || (() => { throw new Error("supabase.js not loaded"); })())
    .createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

  // ---------- UI bootstrap (use existing if present; else create) ----------
  let logEl  = document.getElementById("va-log");
  let input  = document.getElementById("va-input");
  let send   = document.getElementById("va-send");
  let listen = document.getElementById("va-listen");
  let stop   = document.getElementById("va-stop");

  function ensureWidget() {
    if (logEl && input && send && listen && stop) return;
    const box = document.createElement("div");
    box.style.cssText =
      "position:fixed;right:16px;bottom:16px;width:340px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.1);font:14px system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;z-index:9999";
    box.innerHTML = `
      <div style="padding:10px 12px;border-bottom:1px solid #eee;display:flex;gap:8px;align-items:center">
        <button id="va-listen" class="btn" type="button">Listen</button>
        <button id="va-stop" class="btn" type="button">Stop</button>
      </div>
      <div id="va-log" style="height:220px;overflow:auto;padding:10px 12px" aria-live="polite"></div>
      <div style="display:flex;gap:8px;padding:10px 12px;border-top:1px solid #eee">
        <input id="va-input" class="ctl" type="text" style="flex:1" placeholder="Type a message… (/search … or /files)"/>
        <button id="va-send" class="btn" type="button">Send</button>
      </div>
    `;
    document.body.appendChild(box);
    logEl  = box.querySelector("#va-log");
    input  = box.querySelector("#va-input");
    send   = box.querySelector("#va-send");
    listen = box.querySelector("#va-listen");
    stop   = box.querySelector("#va-stop");
  }
  ensureWidget();

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
      const u = data?.user;
      if (!u) return "there";
      const n = u.user_metadata?.full_name || u.user_metadata?.name;
      if (n) return n;
      if (u.email) return u.email.split("@")[0];
      return "there";
    } catch { return "there"; }
  }

  // ---------- Edge calls ----------
  async function callAssistant(payload){
    const { data, error } = await supabase.functions.invoke("assistant", { body: payload });
    if (error) throw new Error(error.message || "assistant failed");
    return data; // { reply, actions? }
  }
  async function getRealtimeSession(options = {}){
    const { data, error } = await supabase.functions.invoke("realtime-session", { body: options });
    if (error) throw new Error(error.message || "realtime-session failed");
    if (!data?.ephemeral_key || !data?.session_url) throw new Error("Invalid realtime-session response");
    return data;
  }

  // ---------- WebRTC state ----------
  let pc = null, dc = null, micStream = null, inboundAudioEl = null, realtimeOn = false;

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
    if (!navigator.mediaDevices?.getUserMedia) {
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
        if (pc.connectionState === "failed")     line("Assistant","WebRTC failed.");
      };

      dc = pc.createDataChannel("oai-events");
      dc.onopen  = () => line("Assistant","Data channel open.");
      dc.onclose = () => line("Assistant","Data channel closed.");
      dc.onmessage = (e) => { /* optional: console.log("Realtime message:", e.data); */ };

      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      await waitForICE(pc);

      const sdpAnswer = await fetch(session_url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${ephemeral_key}`, "Content-Type": "application/sdp" },
        body: pc.localDescription.sdp,
      }).then(r => r.text());
      await pc.setRemoteDescription({ type: "answer", sdp: sdpAnswer });

      realtimeOn = true;
      line("Assistant", "Listening… (say something or type to make me speak back)");
    } catch (e) {
      const name = e && (e.name || e.code) || "";
      if (name === "NotFoundError" || name === "DevicesNotFoundError")          line("Assistant", "Requested device not found. Check microphone availability.");
      else if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") line("Assistant", "Microphone permission denied.");
      else if (name === "InvalidStateError")                                     line("Assistant", "Audio system is in an invalid state. Reload the page and try again.");
      else                                                                        line("Assistant", `Start error: ${e.message || e}`);
      cleanupRealtime();
    }
  }

  function stopRealtime(){ cleanupRealtime(); line("Assistant","Stopped."); }

  function sendRealtimeText(text){
    if (!realtimeOn || !dc || dc.readyState !== "open") { line("Assistant", "Realtime is not connected. Click Listen first."); return; }
    dc.send(JSON.stringify({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] }
    }));
    dc.send(JSON.stringify({ type: "response.create" }));
  }

  // ---------- DOM Action Executor ----------
  function findByText(root, selectorList, text, role){
    const sel = selectorList || "*";
    const candidates = Array.from(root.querySelectorAll(sel));
    const norm = (s) => (s || "").replace(/\s+/g," ").trim().toLowerCase();
    const targetText = norm(text || "");
    return candidates.find(el => {
      const tag  = (el.tagName || "").toLowerCase();
      const roleGuess = (tag === "a" ? "link" : (tag === "button" ? "button" : ""));
      if (role && roleGuess && role !== roleGuess) return false;
      const t = norm(el.textContent || el.getAttribute("aria-label") || "");
      return t === targetText || (targetText && t.includes(targetText));
    });
  }

  function safeNavigate(url){
    try {
      const u = new URL(url, window.location.href);
      if (u.origin !== window.location.origin) { line("Assistant", "Blocked cross-origin navigation."); return; }
      window.location.href = u.href;
    } catch { /* ignore */ }
  }

  async function executeDomActions(actions){
    if (!Array.isArray(actions) || !actions.length) return;
    for (const a of actions) {
      try {
        if (a.type === "navigate" && a.url) {
          safeNavigate(a.url);
          continue;
        }
        if (a.type === "click") {
          let el = null;
          if (a.selector) el = document.querySelector(a.selector);
          if (!el && a.text) el = findByText(document, a.selector || "button, a, [role='button'], [role='link']", a.text, a.role);
          if (el) { (el as HTMLElement).click(); continue; }
        }
        if (a.type === "scroll") {
          if (a.target === "top")      window.scrollTo({ top: 0, behavior: "smooth" });
          else if (a.target === "bottom") window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
          else if (a.target === "selector" && a.selector) {
            const el = document.querySelector(a.selector); if (el) (el as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });
          }
          continue;
        }
        if (a.type === "focus") {
          let el = a.selector ? document.querySelector(a.selector) : null;
          if (!el && a.text) el = findByText(document, "input, textarea, [contenteditable='true']", a.text);
          if (el) { (el as HTMLElement).focus(); continue; }
        }
        if (a.type === "input" && a.text != null) {
          let el = a.selector ? document.querySelector(a.selector) : null;
          if (!el) el = document.querySelector("input, textarea");
          if (el) {
            (el as HTMLInputElement).value = a.text;
            (el as HTMLElement).dispatchEvent(new Event("input", { bubbles: true }));
            if (a.submit) {
              const form = (el as HTMLElement).closest("form");
              if (form) (form as HTMLFormElement).requestSubmit();
            }
            continue;
          }
        }
      } catch { /* ignore single action errors */ }
    }
  }

  // ---------- Text flow ----------
  async function sendText(){
    const text = (input.value || "").trim();
    if (!text) return;
    line("You", text);
    input.value = "";

    try {
      const username = await getUsername();
      const resp = await supabase.functions.invoke("assistant", { body: { text, username } });
      if (resp.error) throw new Error(resp.error.message || "assistant failed");
      const data = resp.data || {};
      const out  = data.reply || "(no reply)";

      // Speak via Realtime if connected
      if (realtimeOn && dc && dc.readyState === "open") {
        dc.send(JSON.stringify({
          type: "conversation.item.create",
          item: { type: "message", role: "user", content: [{ type: "input_text", text: out }] }
        }));
        dc.send(JSON.stringify({ type: "response.create" }));
      }

      // Execute any DOM actions
      await executeDomActions(data.actions);

      line("Assistant", out);
    } catch (e) {
      line("Assistant", `Error: ${e.message || e}`);
    }
  }

  // ---------- Wire UI ----------
  send?.addEventListener("click", sendText);
  input?.addEventListener("keydown", (e)=>{ if (e.key === "Enter") sendText(); });
  listen?.addEventListener("click", startRealtime);
  stop?.addEventListener("click", stopRealtime);

  // ---------- Smoke-test greeting on load ----------
  window.addEventListener("load", async () => {
    try {
      const username = await getUsername();
      const { data, error } = await supabase.functions.invoke("assistant", { body: { greet: true, username } });
      if (error) throw new Error(error.message || "assistant greet failed");
      await executeDomActions(data?.actions);
      line("Assistant", data?.reply || `Hello ${username}, how may I assist you today?`);
    } catch (e) {
      const username = await getUsername();
      line("Assistant", `Hello ${username}, how may I assist you today?`);
      console.warn("assistant greet failed:", e);
    }
  });

  // Small API for console/testing
  window.JobCopilotAssistant = {
    start: startRealtime,
    stop:  stopRealtime,
    send:  (t)=>{ input.value = t; sendText(); },
  };
})();
