/* js/voice-assistant.js  —  FULL REWRITE (2025-10-24)
   Advanced voice assistant:
   - Realtime speech chat (OpenAI WebRTC) with live mic + streamed audio reply.
   - Fallback TTS + typed chat if WebRTC or mic is unavailable.
   - “/search …” command routes to a server agent that searches the web and proposes repo file changes.
   - Clean UI: floating FAB -> panel with Listen/Stop, transcript, and results.
*/

(function () {
  // ---------- DOM ----------
  const ui = (() => {
    const fab = document.createElement('button');
    fab.className = 'btn fab';
    fab.id = 'assistantFab';
    fab.type = 'button';
    fab.title = 'Assistant';
    fab.textContent = 'Assistant';
    Object.assign(fab.style, { position:'fixed', right:'16px', bottom:'16px', zIndex: 9999 });

    const panel = document.createElement('div');
    panel.id = 'assistantPanel';
    panel.setAttribute('role','dialog');
    panel.setAttribute('aria-label','Voice assistant');
    Object.assign(panel.style, {
      position:'fixed', right:'16px', bottom:'76px', width:'380px', maxWidth:'92vw',
      background:'#fff', border:'1px solid #e5e7eb', borderRadius:'12px',
      boxShadow:'0 10px 30px rgba(0,0,0,.15)', padding:'12px', display:'none', zIndex:9999
    });

    panel.innerHTML = `
      <div class="row" style="justify-content:space-between;align-items:center;gap:8px">
        <strong>Ask or say a command</strong>
        <div class="row" style="gap:6px">
          <button id="vaListen" class="btn" type="button">Listen</button>
          <button id="vaStop" class="btn" type="button">Stop</button>
          <button id="vaClose" class="btn" type="button" aria-label="Close">×</button>
        </div>
      </div>
      <div id="vaLog" style="height:220px; overflow:auto; border:1px solid #eee; border-radius:8px; padding:8px; margin:8px 0; font:13px/1.4 system-ui, sans-serif;"></div>
      <div class="row" style="gap:6px">
        <input id="vaInput" class="ctl" type="text" placeholder="Try: /search the best ATS practices" style="flex:1 1 auto">
        <button id="vaSend" class="btn primary" type="button">Send</button>
      </div>
      <div id="vaHint" class="muted" style="margin-top:6px">
        Tip: Say anything. Use <code>/search …</code> to let me browse and propose file changes.
      </div>
    `;

    document.body.appendChild(fab);
    document.body.appendChild(panel);

    const q = id => panel.querySelector(id);
    return {
      fab,
      panel,
      listenBtn: q('#vaListen'),
      stopBtn: q('#vaStop'),
      closeBtn: q('#vaClose'),
      log: q('#vaLog'),
      box: q('#vaInput'),
      sendBtn: q('#vaSend'),
      show() { panel.style.display = 'block'; },
      hide() { panel.style.display = 'none'; }
    };
  })();

  const SUPABASE = (() => {
    if (!window.supabase && window.SUPABASE_URL && window.SUPABASE_ANON_KEY) {
      console.warn('Supabase UMD not yet ready, voice assistant will retry after load.');
    }
    function client() { return window.supabase?.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY); }
    return { client };
  })();

  // ---------- Small helpers ----------
  const log = (html) => { ui.log.insertAdjacentHTML('beforeend', `<div style="margin:6px 0">${html}</div>`); ui.log.scrollTop = ui.log.scrollHeight; };
  const esc = s => String(s||'').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  function say(text) {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.0; u.pitch = 1.0;
      window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
    } catch {}
  }

  // ---------- Realtime session (WebRTC) ----------
  let pc = null, dc = null, localStream = null, remoteAudioEl = null, isListening = false;

  async function startRealtime() {
    const sb = SUPABASE.client();
    if (!sb) throw new Error('Supabase not ready');

    // Ask backend for an ephemeral Realtime session (voice enabled)
    const { data, error } = await sb.functions.invoke('realtime-session', {
      body: { model: 'gpt-4o-realtime-preview', voice: 'alloy', modalities: ['audio','text'] }
    });
    if (error) throw new Error(error.message || 'Failed to get Realtime session');

    // Create mic stream
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true }); // mic capture. 

    // Set up RTCPeerConnection
    pc = new RTCPeerConnection();
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') stopRealtime(); };

    // Play remote audio
    pc.ontrack = (e) => {
      if (!remoteAudioEl) {
        remoteAudioEl = document.createElement('audio');
        remoteAudioEl.autoplay = true;
        remoteAudioEl.playsInline = true;
        remoteAudioEl.style.display = 'none';
        document.body.appendChild(remoteAudioEl);
      }
      remoteAudioEl.srcObject = e.streams[0];
    };

    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

    // Data channel for events
    dc = pc.createDataChannel('oai-events');
    dc.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'response.output_text.delta' && msg.delta) {
          // live text stream
        } else if (msg.type === 'response.output_text.done' && msg.text) {
          log(`<div><strong>Assistant:</strong> ${esc(msg.text)}</div>`);
        } else if (msg.type === 'response.error') {
          log(`<div class="error">Error: ${esc(msg.error?.message || 'unknown')}</div>`);
        }
      } catch { /* ignore non-JSON control frames */ }
    };

    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);

    // Exchange SDP with OpenAI Realtime over HTTPS using the ephemeral token. 
    const resp = await fetch(data.session_url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${data.ephemeral_key}`, 'Content-Type': 'application/sdp' },
      body: offer.sdp
    });
    const answer = { type: 'answer', sdp: await resp.text() };
    await pc.setRemoteDescription(answer);

    // Kick a first response so it greets the user
    dc?.send(JSON.stringify({
      type: 'response.create',
      response: {
        instructions: 'You are Job Copilot, a concise, proactive voice assistant for resume tailoring and job search. Be brief and helpful.',
        modalities: ['audio','text'],
        audio: { voice: 'alloy' }
      }
    }));

    isListening = true;
  }

  function stopRealtime() {
    try { dc?.close(); } catch {}
    try { pc?.close(); } catch {}
    try { localStream?.getTracks()?.forEach(t => t.stop()); } catch {}
    pc = dc = localStream = null;
    isListening = false;
  }

  // Send a typed user message into the realtime session
  function realtimeSendText(text) {
    if (!dc) return false;
    dc.send(JSON.stringify({ type: 'response.create', response: { instructions: text, modalities:['audio','text'], audio:{voice:'alloy'} } }));
    return true;
  }

  // ---------- Tool-using “web agent” over HTTP ----------
  async function runWebAgent(query) {
    const sb = SUPABASE.client();
    if (!sb) throw new Error('Supabase not ready');
    log(`<div><strong>You:</strong> ${esc(query)}</div>`);
    const { data, error } = await sb.functions.invoke('assistant', { body: { query } });
    if (error) { log(`<div class="error">Error: ${esc(error.message||'invoke failed')}</div>`); say('Sorry, the web agent failed.'); return; }

    // Render summary + proposed file list
    if (data?.summary) log(`<div><strong>Summary:</strong> ${esc(data.summary)}</div>`);
    if (Array.isArray(data?.proposed_changes) && data.proposed_changes.length) {
      const items = data.proposed_changes.map(pc => `<li><code>${esc(pc.path)}</code> — ${esc(pc.reason||'change')}</li>`).join('');
      log(`<div style="margin-top:6px"><strong>Proposed file changes:</strong><ul>${items}</ul></div>`);
      say('I proposed a file change plan. Tell me which files you want me to rewrite next.');
    } else {
      say('I searched the web and summarized findings.');
    }
  }

  // ---------- UI wiring ----------
  ui.fab.onclick = () => (ui.panel.style.display === 'none' ? ui.show() : ui.hide());
  ui.closeBtn.onclick = ui.hide;

  ui.listenBtn.onclick = async () => {
    if (isListening) return;
    ui.listenBtn.disabled = true;
    try {
      // Prefer realtime if possible, else fall back to plain TTS greeting
      if (navigator.mediaDevices?.getUserMedia) {
        await startRealtime();
        log('<em>Listening… speak to me.</em>');
      } else {
        log('<em>Microphone not available on this device.</em>');
        say('Microphone not available on this device.');
      }
    } catch (e) {
      log(`<div class="error">Start error: ${esc(e?.message||e)}</div>`);
      say('Sorry, I could not start voice mode.');
    } finally {
      ui.listenBtn.disabled = false;
    }
  };

  ui.stopBtn.onclick = () => { stopRealtime(); log('<em>Stopped.</em>'); };

  ui.sendBtn.onclick = async () => {
    const txt = ui.box.value.trim();
    if (!txt) return;
    ui.box.value = '';
    if (txt.startsWith('/search ')) {
      stopRealtime(); // switch to tool mode for determinism
      await runWebAgent(txt.replace(/^\/search\s+/,''));
      return;
    }
    log(`<div><strong>You:</strong> ${esc(txt)}</div>`);
    if (!realtimeSendText(txt)) {
      // fallback simple reply (no WebRTC)
      const sb = SUPABASE.client();
      try {
        const { data, error } = await sb.functions.invoke('assistant', { body: { query: txt } });
        if (error) throw new Error(error.message || 'invoke failed');
        const reply = data?.summary || data?.text || '(no reply)';
        log(`<div><strong>Assistant:</strong> ${esc(reply)}</div>`);
        say(reply);
      } catch (e) {
        log(`<div class="error">Error: ${esc(e?.message||e)}</div>`);
      }
    }
  };

  // Open panel automatically on first load so users discover it
  window.addEventListener('load', () => {
    // If the page already includes a floating assistant button, replace it.
    const oldFab = document.getElementById('progressFab');
    if (oldFab) oldFab.parentNode.removeChild(oldFab);
    ui.show();
  });
})();
