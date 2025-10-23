/* job-copilot — Voice Assistant (Cross-browser hardened, WCAG-first)
   - TTS via SpeechSynthesis; STT via (webkit)SpeechRecognition when available.
   - Defers speech until first user interaction (autoplay policy compliant).
   - Works on Windows/macOS/Linux and iOS/Android (notch-safe, HC mode aware).
   - Public API: window.voiceAssistant.register({ "pattern" or /regex/: fn })
                 window.voiceAssistant.say(text[, mode={'polite'|'assertive'}, {force:false}])
*/
(function () {
  const HAS_TTS = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  const Recog = window.SpeechRecognition || window.webkitSpeechRecognition;
  const HAS_STT = !!Recog; // Chromium-based mostly; Firefox/iOS Safari usually missing.
  const IS_SECURE = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';

  // ---------- Styles (inject so you don't have to touch style.css) ----------
  const css = `
  .va-fab{position:fixed;right:16px;z-index:10050}
  .va-fab{bottom:16px} /* fallback for browsers without env() */
  .va-fab{bottom:calc(16px + env(safe-area-inset-bottom))} /* notch safe */
  .va-btn{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--border,#e5e7eb);
    background:var(--surface,#fff);color:var(--text,#111);padding:10px 14px;border-radius:999px;
    box-shadow:var(--shadow-md,0 8px 24px rgba(17,24,39,.08));cursor:pointer}
  .va-btn:focus-visible{outline:3px solid var(--ring,#1d4ed8);outline-offset:2px}
  .va-dot{width:10px;height:10px;border-radius:99px;background:#9ca3af}
  .va-dot.live{background:#10b981}
  .va-panel{position:fixed;right:16px;bottom:76px;width:min(420px,96vw);z-index:10050;
    background:#fff;border:1px solid var(--border,#e5e7eb);border-radius:12px;padding:12px;
    box-shadow:var(--shadow-lg,0 16px 40px rgba(17,24,39,.10));display:none}
  .va-open .va-panel{display:block}
  .va-row{display:flex;gap:8px;align-items:center;justify-content:space-between}
  .va-controls{display:flex;gap:8px;flex-wrap:wrap}
  .va-kbd{font:12px ui-monospace;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:6px;padding:2px 6px}
  .va-log{margin-top:8px;max-height:180px;overflow:auto;background:#f8fafc;border-radius:8px;padding:8px;border:1px dashed var(--border,#e5e7eb);font:13px ui-monospace;white-space:pre-wrap}
  .va-mic{min-width:44px;min-height:44px}
  .va-input{flex:1 1 auto;padding:10px;border:1px solid var(--border,#e5e7eb);border-radius:8px}
  .sr-only{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
  @media (pointer:coarse){ .va-btn,.va-controls .btn{min-height:48px;padding:14px 16px} }
  /* Windows High Contrast / forced colors */
  @media (forced-colors: active){
    .va-btn,.va-panel{border-color:CanvasText; background:Canvas; color:CanvasText}
    .va-dot.live{forced-color-adjust:none; background:LinkText}
    .va-log{border-color:CanvasText; background:Canvas}
  }
  `;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  // ---------- Live regions for AT ----------
  const livePolite = document.createElement('div');
  livePolite.className = 'sr-only'; livePolite.setAttribute('role','status'); livePolite.setAttribute('aria-live','polite');
  const liveAssert = document.createElement('div');
  liveAssert.className = 'sr-only'; liveAssert.setAttribute('role','alert'); liveAssert.setAttribute('aria-live','assertive');
  document.body.appendChild(livePolite); document.body.appendChild(liveAssert);

  // ---------- UI ----------
  const root = document.createElement('div'); root.className = 'va-root';
  root.innerHTML = `
    <div class="va-fab">
      <button class="va-btn" type="button" aria-haspopup="dialog" aria-controls="va-panel" aria-expanded="false" title="Open assistant (Alt+/)">
        <span class="va-dot" aria-hidden="true"></span><span>Assistant</span>
      </button>
    </div>
    <section id="va-panel" class="va-panel" role="dialog" aria-modal="false" aria-label="Voice assistant">
      <div class="va-row">
        <strong>Ask or say a command</strong>
        <div class="muted small" aria-hidden="true"><span class="va-kbd">Alt+/</span> open · <span class="va-kbd">Space</span> mic</div>
      </div>
      <div class="va-row" style="margin-top:8px">
        <input class="va-input" type="text" inputmode="speech" placeholder="${HAS_STT ? 'Or type here…' : 'Type here…'}" aria-label="Type a question or command"/>
        <div class="va-controls">
          <button class="btn va-mic" type="button" aria-pressed="false" aria-label="Start listening">${HAS_STT ? '🎤 Listen' : '⌨️ Send'}</button>
          <button class="btn" type="button" data-act="stop" aria-label="Stop speaking">⏹ Stop</button>
          <button class="btn" type="button" data-act="help" aria-label="What can you do?">❓ Help</button>
        </div>
      </div>
      <div class="va-log" role="region" aria-live="polite" aria-label="Assistant transcript"></div>
    </section>
  `;
  document.body.appendChild(root);
  const fabBtn = root.querySelector('.va-btn');
  const micBtn = root.querySelector('.va-mic');
  const stopBtn = root.querySelector('[data-act="stop"]');
  const helpBtn = root.querySelector('[data-act="help"]');
  const inputEl = root.querySelector('.va-input');
  const dot = root.querySelector('.va-dot');
  const log = root.querySelector('.va-log');

  function setOpen(open){
    root.classList.toggle('va-open', !!open);
    fabBtn.setAttribute('aria-expanded', open ? 'true':'false');
    if (open) inputEl.focus();
  }
  fabBtn.addEventListener('click', ()=> setOpen(!root.classList.contains('va-open')));
  document.addEventListener('keydown', (e)=>{
    if (e.altKey && e.key === '/') { e.preventDefault(); setOpen(!root.classList.contains('va-open')); }
    if (root.classList.contains('va-open') && e.key === ' ') { if (document.activeElement === inputEl) return; e.preventDefault(); micBtn.click(); }
    if (e.key === 'Escape' && root.classList.contains('va-open')) setOpen(false);
  });

  // ---------- User-gesture gate for TTS (autoplay policies) ----------
  let userInteracted = false;
  function markInteracted(){ userInteracted = true;
    window.removeEventListener('pointerdown', markInteracted, {capture:true});
    window.removeEventListener('keydown', markInteracted, {capture:true});
    window.removeEventListener('touchstart', markInteracted, {capture:true});
  }
  window.addEventListener('pointerdown', markInteracted, {capture:true, passive:true});
  window.addEventListener('keydown', markInteracted, {capture:true});
  window.addEventListener('touchstart', markInteracted, {capture:true, passive:true});

  // ---------- Voice selection (best-match for locale) ----------
  let voices = [];
  function refreshVoices(){ try { voices = window.speechSynthesis?.getVoices?.() || []; } catch { voices = []; } }
  if (HAS_TTS){
    refreshVoices();
    try { window.speechSynthesis.addEventListener('voiceschanged', refreshVoices); } catch{}
  }
  function pickVoice(locale){
    if (!HAS_TTS) return null;
    const lang = String(locale||navigator.language||'').toLowerCase();
    refreshVoices();
    let v = voices.find(v=>String(v.lang||'').toLowerCase() === lang) ||
            voices.find(v=>String(v.lang||'').toLowerCase().startsWith(lang.split('-')[0])) ||
            voices[0] || null;
    return v || null;
  }

  // ---------- Speak helpers ----------
  function say(text, mode='polite', {force=false}={}){
    if (!text) return;
    livePolite.textContent = ''; liveAssert.textContent = '';
    (mode === 'assertive' ? liveAssert : livePolite).textContent = text; // SR announcement
    if (HAS_TTS){
      // Respect autoplay: don't speak until user interacts unless explicitly forced.
      if (!userInteracted && !force) { log.textContent += `Assistant (queued): ${text}\n`; return; }
      try {
        window.speechSynthesis.cancel();
        const chunks = String(text).match(/.{1,180}(\s|$)/g) || [String(text)];
        for (const c of chunks){
          const u = new SpeechSynthesisUtterance(c.trim());
          u.rate = 1.03; u.pitch = 1.0; u.lang = navigator.language || 'en-US';
          const v = pickVoice(u.lang); if (v) u.voice = v;
          window.speechSynthesis.speak(u);
        }
      } catch {}
    }
    log.textContent += `Assistant: ${text}\n`;
  }

  // ---------- Intent registry ----------
  const registry = [];
  function register(pattern, handler, hint){
    registry.push({ pattern, handler, hint });
  }
  function clickIf(id){ const el = document.getElementById(id); if (el){ el.click(); return true; } return false; }
  function readScore(){ const pill = document.getElementById('scoreVal'); if (pill){ say(`Current score ${pill.textContent.trim() || '—'}.`); return true; } return false; }
  function readSelection(){
    const t = (window.getSelection?.().toString() || '').trim();
    if (t) { say(t); return true; }
    const ch = document.getElementById('changes');
    if (ch){ const first = (ch.textContent||'').trim().slice(0, 600); if (first) { say(first); return true; } }
    return false;
  }

  const INTENTS = [
    [/^(help|what can you do|commands)/i, () => {
      const hints = registry.map(r => typeof r.pattern === 'string' ? r.pattern : (r.hint || '')).filter(Boolean);
      say("You can say things like: 'read score', 'auto tailor', 'export docx', 'print PDF', 'fetch job', 'choose file', 'read selection', 'run shortlist', 'draft materials', 'refresh', 'upload resume', 'open power edit', 'sign in', or 'go home'." + (hints.length ? ` Also: ${hints.join(', ')}.` : ''));
    }],
    [/^(read )?(score|ats)/i, () => readScore() || say("I couldn't find a score on this page.")],
    [/^(read|speak|say) (this|selection|page|change log)/i, () => readSelection() || say("Select some text first, then try 'read selection'.")],
    [/^(auto[-\s]?tailor|tailor now)/i, () => clickIf('autoTailor') || say("Auto-tailor isn’t available here.")],
    [/^(export( docx)?|download( resume)?)/i, () => clickIf('exportDocx') || say("Export isn't available on this page.")],
    [/^(print|pdf)/i, () => clickIf('printPdf') || say("Print isn’t available here.")],
    [/^(fetch( job| jd)?|load (job|jd))/i, () => clickIf('fetchJD') || say("Fetch JD isn't available here.")],
    [/^(choose|upload) (file|docx)/i, () => clickIf('chooseFile') || clickIf('fileInput') || say("I couldn't find the file picker.")],
    [/^(run|build) (my )?(shortlist|list)/i, () => clickIf('runTailor') || say("Shortlist controls aren’t on this page.")],
    [/^(draft|create) (covers?|materials|resumes?)/i, () => clickIf('runDrafts') || say("Drafting isn't on this page.")],
    [/^(refresh|reload)( now)?/i, () => clickIf('refresh') || clickIf('overlayRefresh') || say("No refresh control found.")],
    [/^(upload) resume/i, () => clickIf('uploadResume') || say("Upload control not found.")],
    [/^(open )?power edit/i, () => { location.href = 'power-edit.html'; }],
    [/^(open )?profile/i, () => { location.href = 'profile.html'; }],
    [/^(sign in|login|log in)/i, () => { location.href = 'login.html'; }],
    [/^(go )?(home|start)/i, () => { location.href = './'; }],
    [/^(stop|quiet|silence)/i, () => { try{window.speechSynthesis.cancel();}catch{}; say("Stopped.", 'assertive', {force:true}); }]
  ];
  INTENTS.forEach(([p, h]) => register(p, h));

  // External API for page-specific commands
  window.voiceAssistant = {
    register(map){
      for (const key of Object.keys(map||{})){
        const val = map[key];
        if (key.startsWith('/') && key.endsWith('/')){
          const re = new RegExp(key.slice(1,-1), 'i'); register(re, val, key);
        } else register(String(key).toLowerCase(), val, key);
      }
    },
    say
  };

  function route(text){
    const t = String(text||'').trim();
    if (!t) return;
    log.textContent += `You: ${t}\n`;
    try { window.dispatchEvent(new CustomEvent('voice:command', { detail:{ text:t } })); } catch {}
    for (const {pattern,handler} of registry){
      try{
        if (pattern instanceof RegExp && pattern.test(t)) return void handler(t);
        if (typeof pattern === 'string' && t.toLowerCase().includes(pattern)) return void handler(t);
      }catch{}
    }
    say("Sorry — I didn’t catch a supported command. Say 'help' to hear examples.");
  }

  // ---------- STT session ----------
  let rec = null, listening = false;
  function setListening(on){
    listening = !!on;
    micBtn.setAttribute('aria-pressed', listening ? 'true':'false');
    micBtn.textContent = listening ? '🛑 Stop' : (HAS_STT ? '🎤 Listen' : '⌨️ Send');
    dot.classList.toggle('live', listening);
  }

  if (HAS_STT){
    rec = new Recog();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = false; rec.maxAlternatives = 1; rec.continuous = false;

    rec.onresult = (e) => {
      const phrase = e.results?.[0]?.[0]?.transcript || '';
      route(phrase);
    };
    rec.onend = () => { setListening(false); };
    rec.onerror = () => { setListening(false); say("Mic error or permission denied."); };
  }

  micBtn.addEventListener('click', async () => {
    if (!HAS_STT){
      const t = inputEl.value.trim(); inputEl.value = ''; route(t); return;
    }
    if (!IS_SECURE){
      say("Microphone requires HTTPS (or localhost). Please open this page over HTTPS.");
      return;
    }
    if (!listening){ try { rec.start(); setListening(true); } catch { setListening(false); say("Unable to start microphone."); } }
    else { try { rec.stop(); } catch {} setListening(false); }
  });

  stopBtn.addEventListener('click', () => { try{window.speechSynthesis.cancel();}catch{}; say("Stopped.", 'assertive', {force:true}); });
  helpBtn.addEventListener('click', () => route('help'));
  inputEl.addEventListener('keydown', (e)=>{ if (e.key === 'Enter'){ const t=inputEl.value.trim(); inputEl.value=''; route(t); } });

  // First-run hint (announce to SR; defer TTS until user interacts)
  setTimeout(()=> say(HAS_STT
    ? "Assistant ready. Press Alt plus Slash to open, then Space to start listening."
    : "Assistant ready in text mode. Type a command and press Enter."
  ), 300);
})();
