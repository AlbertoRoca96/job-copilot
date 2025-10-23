// js/voice-assistant.js — Realtime voice wired to OpenAI via Supabase Edge
// Adds: page snapshot -> server; and client-side executor for ui_navigate actions.

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

  // ---------- Page snapshot ----------
  function textOf(el) {
    return (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
  }
  function collectPageSnapshot() {
    const links = Array.from(document.querySelectorAll("a"))
      .slice(0, 80)
      .map(a => ({ text: textOf(a), href: a.getAttribute("href") || "" }))
      .filter(x => x.text);
    const buttons = Array.from(document.querySelectorAll("button"))
      .slice(0, 60)
      .map(b => ({ text: textOf(b) }))
      .filter(x => x.text);
    const headings = Array.from(document.querySelectorAll("h1,h2,h3"))
      .slice(0, 30)
      .map(h => textOf(h))
      .filter(Boolean);
    return {
      url: location.href,
      title: document.title,
      links, buttons, headings
    };
  }

  // ---------- Edge calls ----------
  async function callAssistant(payload){
    const enriched = { ...payload, page: collectPageSnapshot() };
    const { data, error } = await supabase.functions.invoke("assistant", { body: enriched });
    if (error) throw new Error(error.message || "assistant failed");
    return data;
  }
  async function getRealtimeSession(options = {}){
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
      setTimeout(resolve, 1500);
    });
  }

  // ---------- Execute actions returned by the agent ----------
  const ROUTES = {
    home:       "/job-copilot/",
    profile:    "/job-copilot/profile",     // adjust if your site uses a different path
    power_edit: "/job-copilot/#power-edit",
    feedback:   "/job-copilot/#feedback",
  };

  function findByLabel(label) {
    const needle = (label || "").toLowerCase();
    const els = [
      ...document.querySelectorAll("a,button,[role='button']")
    ];
    // Prefer elements whose text starts with the label
    let best = null;
    for (const el of els) {
      const t = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").toLowerCase();
      if (!t) continue;
      if (t === needle) return el;
      if (t.startsWith(needle)) best = best || el;
      else if (t.includes(needle) && !best) best = el;
    }
    return best;
  }

  function speakLine(s) {
    if (realtimeOn && dc && dc.readyState === "open" && s) {
      dc.send(JSON.stringify({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: s }] }
      }));
      dc.send(JSON.stringify({ type: "response.create" }));
    }
  }

  function executeActions(actions) {
    if (!Array.isArray(actions) || !actions.length) return;

    for (const a of actions) {
      try {
        switch (a.type) {
          case "navigate": {
            const url = a.page && ROUTES[a.page] ? ROUTES[a.page] : null;
            if (url) { location.href = url; speakLine(`Navigating to ${a.page?.replace("_"," ")}`); }
            else if (a.target_label) {
              const el = findByLabel(a.target_label);
              if (el && el.tagName.toLowerCase() === "a") { (el).click(); speakLine(`Opening ${a.target_label}`); }
            }
            break;
          }
          case "click": {
            const el = findByLabel(a.target_label);
            if (el) { el.click(); speakLine(`Clicked ${a.target_label}`); }
            break;
          }
          case "focus": {
            const el = findByLabel(a.target_label);
            if (el) { el.focus(); speakLine(`Focused ${a.target_label}`); }
            break;
          }
          case "scroll": {
            if (a.amount === "top")      window.scrollTo({ top: 0, behavior: "smooth" });
            else if (a.amount === "bottom") window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
            else if (a.amount === "page_up")   window.scrollBy({ top: -window.innerHeight, behavior: "smooth" });
            else if (a.amount === "page_down") window.scrollBy({ top:  window.innerHeight, behavior: "smooth" });
            break;
          }
          case "read": {
            const target = a.target_label ? findByLabel(a.target_label) : null;
            let text = "";
            if (target) text = (target.closest("section") || target).innerText || "";
            else text = (document.querySelector("main")?.innerText || document.body.innerText || "").trim();
            text = text.slice(0, 800);
            if (text) speakLine(text);
            break;
          }
          case "say": {
            speakLine(a.say || "");
            break;
          }
        }
      } catch (e) {
        // ignore individual action failures to keep sequence robust
      }
    }
  }

  // ---------- Realtime ----------
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
      inboundAudioEl.autoplay = true; inboundAudioEl.playsInline = true;
      inboundAudioEl.style.display = "none"; document.body.appendChild(inboundAudioEl);

      pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      pc.ontrack = (e) => { if (!inboundAudioEl.srcObject) inboundAudioEl.srcObject = e.streams[0]; };
      pc.addTransceiver("audio", { direction: "recvonly" });
      micStream.getTracks().forEach(t => pc.addTrack(t, micStream));
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") line("Assistant","Realtime connected.");
        if (pc.connectionState === "failed")    line("Assistant","WebRTC failed.");
      };

      dc = pc.createDataChannel("oai-events");
      dc.onopen = () => line("Assistant","Data channel open.");
      dc.onclose = () => line("Assistant","Data channel closed.");
      dc.onmessage = async (e) => {
        // Try to detect a user transcript from Realtime events and turn it into actions.
        try {
          const msg = JSON.parse(e.data);
          // There are several event shapes; handle generously.
          // Example (not guaranteed): {type:"input_audio_transcription.completed", transcript:"go to profile"}
          const t1 = msg?.transcript || msg?.text;
          const t2 = msg?.delta; // e.g., response.output_text.delta (we only act on completed events)
          if (msg?.type === "input_audio_transcription.completed" && t1) {
            line("You", t1);
            const username = await getUsername();
            const resp = await callAssistant({ text: t1, username });
            const out = resp?.reply || "(no reply)";
            executeActions(resp?.actions);
            line("Assistant", out);
            speakLine(out);
          } else if (msg?.type === "response.completed" && typeof t2 === "string") {
            // ignore; this is assistant's output text delta stream
          }
        } catch { /* non-JSON messages: ignore */ }
      };

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
    dc.send(JSON.stringify({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] }
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
      const resp = await callAssistant({ text, username });
      const out  = resp?.reply || "(no reply)";
      executeActions(resp?.actions);
      if (realtimeOn && dc && dc.readyState === "open") speakLine(out);
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
