// Realtime voice UI + DomAgent bridge
// New: Local speech-to-text (Web Speech API) pipes your spoken commands to DomAgent.askAssistant.
// Realtime WebRTC remains the same for TTS back to you (we send assistant replies to the datachannel).
(function () {
  if (!window.supabase) throw new Error("supabase.js not loaded");
  if (!window.SUPABASE_URL || !window.SUPABASE_ANON_KEY) {
    throw new Error("Missing SUPABASE_URL / SUPABASE_ANON_KEY on window");
  }
  const sb = window.__sbclient || (window.__sbclient = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY));

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
        <input id="va-input" type="text" style="flex:1" placeholder="Say or type: “open power edit”"/>
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
    if (role === "Assistant") announce(text);
  }

  // ---------- Auth helper ----------
  async function getUsername(){
    try {
      const { data } = await sb.auth.getUser();
      const u = data && data.user;
      if (!u) return "there";
      const n = (u.user_metadata && (u.user_metadata.full_name || u.user_metadata.name)) || null;
      if (n) return n;
      if (u.email) return u.email.split("@")[0];
      return "there";
    } catch { return "there"; }
  }

  // ---------- Realtime (unchanged behavior) ----------
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
      function check(){ if (pc.iceGatheringState === "complete"){ pc.removeEventListener("icegatheringstatechange", check); resolve(); } }
      pc.addEventListener("icegatheringstatechange", check);
      setTimeout(resolve, 1500);
    });
  }

  async function startRealtime(){
    if (realtimeOn) return;
    if (!navigator.mediaDevices?.getUserMedia) { line("Assistant", "This browser does not support microphone capture."); return; }
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const { data, error } = await sb.functions.invoke("realtime-session", {
        body: { model: "gpt-4o-realtime-preview", voice: "alloy", modalities: ["audio","text"] }
      });
      if (error) throw new Error(error.message || "realtime-session failed");
      const { ephemeral_key, session_url } = data || {};
      if (!ephemeral_key || !session_url) throw new Error("Realtime: missing ephemeral key or session URL.");

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
      await pc.setRemoteDescription({ type: "answer", sdp: sdpAnswer });

      realtimeOn = true;
      line("Assistant", "Listening… (speak, or type below)");
      startLocalSTT(); // NEW: start speech-to-text -> actions
    } catch (e) {
      const name = (e && (e.name || e.code)) || "";
      if (name === "NotFoundError" || name === "DevicesNotFoundError")       line("Assistant", "Requested device not found. Check microphone.");
      else if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") line("Assistant", "Microphone permission denied.");
      else if (name === "InvalidStateError")                                  line("Assistant", "Audio system is in an invalid state. Reload and try again.");
      else                                                                     line("Assistant", "Start error: " + (e.message || e));
      cleanupRealtime();
    }
  }

  function stopRealtime(){ cleanupRealtime(); stopLocalSTT(); line("Assistant","Stopped."); }

  // Send text to Realtime for TTS (so it speaks back)
  function sendRealtimeText(text){
    if (!realtimeOn || !dc || dc.readyState !== "open") return;
    dc.send(JSON.stringify({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] }
    }));
    dc.send(JSON.stringify({ type: "response.create" }));
  }

  // ---------- Local STT -> actions ----------
  let recog = null;
  function startLocalSTT(){
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { line("Assistant", "Speech recognition not supported in this browser."); return; }
    if (recog) return;
    try {
      recog = new SR();
      recog.lang = "en-US";
      recog.continuous = true;
      recog.interimResults = true;

      let buffer = "";
      let lastFinal = 0;

      recog.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          const txt = res[0].transcript;
          if (res.isFinal) {
            buffer += (buffer ? " " : "") + txt.trim();
            lastFinal = Date.now();
          }
        }
        if (buffer && Date.now() - lastFinal > 200) {
          const spoken = buffer;
          buffer = "";
          handleUserText(spoken); // speak → actions
        }
      };
      recog.onerror = (ev) => { console.debug("STT error", ev?.error); };
      recog.onend = () => { /* Chrome sometimes auto-stops; try to restart if still listening */ if (realtimeOn) try { recog.start(); } catch {} };
      recog.start();
      line("Assistant", "Speech recognition on. Say things like “open power edit”, “scroll down”, “click sign in”.");
    } catch (e) { console.debug("STT start failed", e); }
  }
  function stopLocalSTT(){ try { recog && recog.stop && recog.stop(); } catch {} recog = null; }

  // ---------- Unify text handling (typed or spoken) ----------
  async function handleUserText(text){
    const t = (text || "").trim();
    if (!t) return;
    line("You", t);

    // Try immediate local heuristics (client runs them)
    const local = window.DomAgent ? window.DomAgent.runActions : null;
    if (local) {
      // let server have the final say, but this allows immediate UI feedback
    }

    try {
      const username = await getUsername();
      const resp = await window.DomAgent.askAssistant({ text: t, username });
      const out = (resp && (resp.reply || resp.text)) || "(no reply)";
      if (realtimeOn && dc && dc.readyState === "open") sendRealtimeText(out);
      line("Assistant", out);
    } catch (e) {
      line("Assistant", "Error: " + (e.message || e));
    }
  }

  // ---------- Send button (typed) ----------
  function sendText(){ handleUserText(input.value || ""); input.value = ""; }

  document.getElementById("va-send")?.addEventListener("click", sendText);
  document.getElementById("va-input")?.addEventListener("keydown", (e)=>{ if (e.key === "Enter") sendText(); });
  document.getElementById("va-listen")?.addEventListener("click", startRealtime);
  document.getElementById("va-stop")?.addEventListener("click", stopRealtime);

  // ---------- Greeting ----------
  window.addEventListener("load", async () => {
    try {
      const username = await getUsername();
      const resp = await window.DomAgent.askAssistant({ greet: true, username });
      line("Assistant", (resp && (resp.reply || resp.text)) || (`Hello ${username}, how may I assist you today?`));
    } catch {
      const username = await getUsername();
      line("Assistant", `Hello ${username}, how may I assist you today?`);
    }
  });

  // Console helpers
  window.JobCopilotAssistant = {
    start: startRealtime,
    stop: stopRealtime,
    send: (t)=>{ input.value = t; sendText(); }
  };
})();
