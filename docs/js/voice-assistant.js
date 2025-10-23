// js/voice-assistant.js — Realtime voice wired to OpenAI via Supabase Edge
// - Click "Listen" to start Realtime (mic -> model, model -> audio track).
// - "Stop" tears down the PeerConnection.
// - Typed messages always call the /assistant tool-using agent; if Realtime is ON,
//   the agent's text reply is spoken back via the Realtime datachannel.
//
// Requires:
//  - window.SUPABASE_URL, window.SUPABASE_ANON_KEY (already in your pages)
//  - supabase.js loaded
//  - Supabase Edge functions:
//      * assistant (tool-using agent: web search, crawl, repo tree, etc.)
//      * realtime-session (returns { ephemeral_key, session_url })
//
// This file is resilient: if your page doesn't have the expected elements,
// it renders a tiny widget so you can still test everything.

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
      <div id="va-log" style="height:220px;overflow:auto;padding:10px 12px"></div>
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
    return data;
  }
  async function getRealtimeSession(options = {}){
    // { ephemeral_key, session_url }
    const { data, error } = await supabase.functions.invoke("realtime-session", { body: options });
    if (error) throw new Error(error.message || "realtime-session failed");
    if (!data?.ephemeral_key || !data?.session_url) throw new Error("Invalid realtime-session response");
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
      setTimeout(resolve, 1500); // safety timeout
    });
  }

  async function startRealtime(){
    if (realtimeOn) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      line("Assistant", "This browser does not support microphone capture.");
      return;
    }

    try {
      // 1) Ask for mic (user gesture required)
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // 2) Mint ephemeral key + session url from Edge
      const { ephemeral_key, session_url } = await getRealtimeSession();

      // 3) Create remote audio element (must be created on user gesture for iOS)
      inboundAudioEl = document.createElement("audio");
      inboundAudioEl.autoplay = true;
      inboundAudioEl.playsInline = true;
      inboundAudioEl.style.display = "none";
      document.body.appendChild(inboundAudioEl);

      // 4) Peer connection + tracks
      pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });

      pc.ontrack = (e) => {
        if (!inboundAudioEl.srcObject) inboundAudioEl.srcObject = e.streams[0];
      };
      // Ensure we can receive audio from the model
      pc.addTransceiver("audio", { direction: "recvonly" });

      // Add our mic upstream
      micStream.getTracks().forEach(t => pc.addTrack(t, micStream));

      // Optional: debug ICE/state
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") line("Assistant","Realtime connected.");
        if (pc.connectionState === "failed") line("Assistant","WebRTC failed.");
      };

      // 5) Datachannel for text and control
      dc = pc.createDataChannel("oai-events");
      dc.onopen = () => line("Assistant","Data channel open.");
      dc.onclose = () => line("Assistant","Data channel closed.");
      dc.onmessage = (e) => {
        // Realtime server events (JSON). You may log/inspect as needed.
        // console.log("Realtime message:", e.data);
      };

      // 6) Offer/answer with the Realtime endpoint using the **ephemeral key**
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      await waitForICE(pc);

      const sdpAnswer = await fetch(session_url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${ephemeral_key}`,
          "Content-Type": "application/sdp",
        },
        body: pc.localDescription.sdp,
      }).then(r => r.text());

      const answer = { type: "answer", sdp: sdpAnswer };
      await pc.setRemoteDescription(answer);

      realtimeOn = true;
      line("Assistant", "Listening… (say something or type to make me speak back)");
    } catch (e) {
      const name = e && (e.name || e.code) || "";
      if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        line("Assistant", "Requested device not found. Check microphone availability.");
      } else if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
        line("Assistant", "Microphone permission denied.");
      } else if (name === "InvalidStateError") {
        line("Assistant", "Audio system is in an invalid state. Reload the page and try again.");
      } else {
        line("Assistant", `Start error: ${e.message || e}`);
      }
      cleanupRealtime();
    }
  }

  function stopRealtime(){
    cleanupRealtime();
    line("Assistant","Stopped.");
  }

  // Send a text prompt so the model *speaks* back over the Realtime connection
  function sendRealtimeText(text){
    if (!realtimeOn || !dc || dc.readyState !== "open") {
      line("Assistant", "Realtime is not connected. Click Listen first.");
      return;
    }
    // Create a conversation item (user text) and then request a response
    dc.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }]
      }
    }));
    dc.send(JSON.stringify({ type: "response.create" }));
  }

  // ---------- Text flow (ALWAYS use tool-agent; speak reply if Realtime ON) ----------
  async function sendText(){
    const text = (input.value || "").trim();
    if (!text) return;
    line("You", text);
    input.value = "";

    try {
      const username = await getUsername();
      // Always call the tool-using agent on the server
      const resp = await callAssistant({ text, username });
      const out = resp?.reply || "(no reply)";

      // If Realtime is connected, have the model speak the agent's reply
      if (realtimeOn && dc && dc.readyState === "open") {
        dc.send(JSON.stringify({
          type: "conversation.item.create",
          item: { type: "message", role: "user", content: [{ type: "input_text", text: out }] }
        }));
        dc.send(JSON.stringify({ type: "response.create" }));
      }

      line("Assistant", out);
    } catch (e) {
      line("Assistant", `Error: ${e.message || e}`);
    }
  }

  // ---------- Wire UI ----------
  send?.addEventListener("click", sendText);
  input?.addEventListener("keydown", (e)=>{ if (e.key === "Enter") sendText(); });
  listen?.addEventListener("click", startRealtime);   // user gesture: good for iOS
  stop?.addEventListener("click", stopRealtime);

  // ---------- Smoke-test greeting on load ----------
  window.addEventListener("load", async () => {
    try {
      const username = await getUsername();
      const resp = await callAssistant({ greet: true, username });
      line("Assistant", resp?.reply || `Hello ${username}, how may I assist you today?`);
    } catch (e) {
      const username = await getUsername();
      line("Assistant", `Hello ${username}, how may I assist you today?`);
      console.warn("assistant greet failed:", e);
    }
  });

  // Small API for console/testing
  window.JobCopilotAssistant = {
    start: startRealtime,
    stop: stopRealtime,
    send: (t)=>{ input.value = t; sendText(); },
  };
})();
