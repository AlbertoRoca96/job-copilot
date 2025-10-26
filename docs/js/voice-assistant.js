// js/voice-assistant.js
// Realtime voice UI + uses DomAgent to:
//  - send page snapshot + text to the "assistant" Edge Function
//  - execute returned DOM actions across your whole site

(function () {
  // ---------- Supabase ----------
  const supabase = (window.supabase || (() => { throw new Error("supabase.js not loaded"); })())
    .createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

  // ---------- UI ----------
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
        <input id="va-input" type="text" style="flex:1" placeholder="Type a message… (e.g., “open power edit”)"/>
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

  function showPanel(){ panel.style.display = "";  fabBtn.style.display = "none"; }
  function hidePanel(){ panel.style.display = "none"; fabBtn.style.display = ""; }
  hideBtn?.addEventListener("click", hidePanel);
  fabBtn?.addEventListener("click", showPanel);

  // ---------- ARIA live ----------
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

  // ---------- Log ----------
  function esc(s){ return String(s||"").replace(/[&<>]/g,c=>({ "&":"&amp;","<":"&lt;",">":"&gt;" }[c])); }
  function line(role, text){
    const d = document.createElement("div");
    d.style.margin = "6px 0";
    d.innerHTML = `<strong>${esc(role)}:</strong> ${esc(text)}`;
    logEl.appendChild(d);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ---------- Auth ----------
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

  // ---------- Realtime ----------
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
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      line("Assistant", "This browser does not support microphone capture.");
      return;
    }
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // get ephemeral session token for OpenAI Realtime
      const { data, error } = await supabase.functions.invoke("realtime-session", {
        body: { model: "gpt-4o-realtime-preview", voice: "alloy", modalities: ["audio","text"] }
      });
      if (error) throw new Error(error.message || "realtime-session failed");
      const { ephemeral_key, session_url } = data;

      inboundAudioEl = document.createElement("audio");
      inboundAudioEl.autoplay = true; inboundAudioEl.playsInline = true; inboundAudioEl.style.display = "none";
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
      else if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") line("Assistant", "Microphone permission denied.");
      else if (name === "InvalidStateError")                                  line("Assistant", "Audio system is in an invalid state. Reload and try again.");
      else                                                                     line("Assistant", "Start error: " + (e.message || e));
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

  // ---------- local intent fallback ----------
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

  // ---------- send text ----------
  async function sendText(){
    const text = (input.value || "").trim();
    if (!text) return;
    line("You", text);
    input.value = "";

    // local fallback acts immediately
    const local = detectLocalActions(text);
    if (local.length) await window.DomAgent.runActions(local);

    try {
      const username = await getUsername();
      const resp = await window.DomAgent.askAssistant({ text, username });
      const out = (resp && resp.reply) || "(no reply)";

      if (realtimeOn && dc && dc.readyState === "open") {
        sendRealtimeText(out);
      }

      line("Assistant", out);
      // DomAgent already executed resp.actions
    } catch (e) {
      line("Assistant", "Error: " + (e.message || e));
    }
  }

  // ---------- Wire UI ----------
  send?.addEventListener("click", sendText);
  input?.addEventListener("keydown", (e)=>{ if (e.key === "Enter") sendText(); });
  listen?.addEventListener("click", startRealtime);
  stop?.addEventListener("click", stopRealtime);

  // ---------- Greeting ----------
  window.addEventListener("load", async () => {
    try {
      const username = await getUsername();
      const resp = await window.DomAgent.askAssistant({ greet: true, username });
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
    snapshot: async (prompt) => { await window.DomAgent.runActions([{ type: "snapshot", prompt }]); },
    record: () => window.DomAgent.startRecorder(),
    stopRecord: () => window.DomAgent.stopRecorder(),
    cloudRun: (steps, opts) => window.DomAgent.runInCloud(steps, opts),
  };
})();
