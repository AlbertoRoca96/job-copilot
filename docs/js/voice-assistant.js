// js/voice-assistant.js — resilient client + smoke-test greet

(function () {
  // ---- Supabase client ----
  const supabase = (window.supabase || (() => { throw new Error("supabase.js not loaded"); })())
    .createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

  // ---- UI plumbing (use existing elements if present; else create) ----
  let logEl  = document.getElementById("va-log");
  let input  = document.getElementById("va-input");
  let send   = document.getElementById("va-send");
  let listen = document.getElementById("va-listen");
  let stop   = document.getElementById("va-stop");

  function ensureWidget() {
    if (logEl && input && send) return;
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;right:16px;bottom:16px;width:320px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.1);font:14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif;z-index:9999;";
    box.innerHTML = `
      <div style="padding:10px 12px;border-bottom:1px solid #eee;display:flex;gap:8px;align-items:center">
        <button id="va-listen" class="btn" type="button">Listen</button>
        <button id="va-stop" class="btn" type="button">Stop</button>
      </div>
      <div id="va-log" style="height:200px;overflow:auto;padding:10px 12px"></div>
      <div style="display:flex;gap:8px;padding:10px 12px;border-top:1px solid #eee">
        <input id="va-input" class="ctl" type="text" style="flex:1" placeholder="Type a message…" />
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

  // Simple message rendering
  function addLine(role, text) {
    const div = document.createElement("div");
    div.style.margin = "6px 0";
    div.innerHTML = `<strong>${role}:</strong> ${escapeHtml(text)}`;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }
  function escapeHtml(s) {
    return String(s || "").replace(/[&<>]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;" }[c]));
  }

  // ---- Username helper ----
  async function getUsername() {
    try {
      const { data } = await supabase.auth.getUser();
      const u = data?.user;
      if (!u) return "there";
      const metaName = u.user_metadata?.full_name || u.user_metadata?.name;
      if (metaName) return metaName;
      if (u.email) return u.email.split("@")[0];
      return "there";
    } catch {
      return "there";
    }
  }

  // ---- Call assistant function ----
  async function callAssistant(payload) {
    const { data, error } = await supabase.functions.invoke("assistant", { body: payload });
    if (error) throw new Error(error.message || "Edge call failed");
    return data;
  }

  // ---- Send text -> assistant ----
  async function sendText() {
    const text = (input.value || "").trim();
    if (!text) return;
    addLine("You", text);
    input.value = "";
    try {
      const username = await getUsername();
      const resp = await callAssistant({ text, username });
      addLine("Assistant", resp?.reply || "(no reply)");
    } catch (e) {
      addLine("Assistant", `Error: ${e.message || e}`);
    }
  }

  // ---- Voice start/stop guards ----
  async function startListening() {
    // iOS Safari requires a user gesture; this handler is attached to a click.
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      addLine("Assistant", "This browser does not support microphone capture.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // (Optional) Start your Realtime flow here; for now we just stop immediately:
      stream.getTracks().forEach(t => t.stop());
      addLine("Assistant", "Mic OK. Realtime session can be started next.");
      // To wire Realtime: fetch ephemeral key from /realtime-session then do WebRTC.
    } catch (e) {
      const name = e && (e.name || e.code) || "";
      if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        addLine("Assistant", "Requested device not found. Check microphone availability.");
      } else if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
        addLine("Assistant", "Microphone permission denied.");
      } else if (name === "InvalidStateError") {
        addLine("Assistant", "Audio system is in an invalid state. Reload the page and try again.");
      } else {
        addLine("Assistant", `Mic error: ${e.message || e}`);
      }
    }
  }
  function stopListening() {
    // Your WebRTC cleanup would go here; we just acknowledge for now.
    addLine("Assistant", "Stopped.");
  }

  // ---- Wire UI ----
  send?.addEventListener("click", sendText);
  input?.addEventListener("keydown", (e) => { if (e.key === "Enter") sendText(); });
  listen?.addEventListener("click", startListening);
  stop?.addEventListener("click", stopListening);

  // ---- SMOKE TEST GREETING ON LOAD ----
  window.addEventListener("load", async () => {
    try {
      const username = await getUsername();
      const resp = await callAssistant({ greet: true, username });
      addLine("Assistant", resp?.reply || `Hello ${username}, how may I assist you today?`);
    } catch (e) {
      // Even if the function is unreachable, still greet locally so you see something.
      const username = await getUsername();
      addLine("Assistant", `Hello ${username}, how may I assist you today?`);
      console.warn("assistant greet failed:", e);
    }
  });

  // Expose a tiny hook if you want to push messages from elsewhere
  window.JobCopilotAssistant = {
    say: (text) => addLine("Assistant", text),
    send: (text) => { input.value = text; sendText(); },
  };
})();
