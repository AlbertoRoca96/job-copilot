// js/after-docx.js
// Renders the DOCX-styled “After” preview (docx-preview) and auto-refreshes when:
// 1) Power Edit’s Auto-tailor signals kickoff/done (event-driven), and
// 2) As a fallback, we short-poll drafts_index.json for newly added change files.

(function(){
  const $ = (id) => document.getElementById(id);
  const sel = $("afterChangePE");
  const btn = $("afterRenderPE");
  const target = $("afterDocxPE");
  const msg = $("afterDocxMsgPE");
  if (!target) return;

  // ---- Supabase helpers ----
  function sb(){
    if (window._supabaseClient) return window._supabaseClient;
    const client = window.supabase?.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
    window._supabaseClient = client;
    return client;
  }
  async function getUser(){ const { data } = await sb().auth.getUser(); return data.user || null; }
  async function sign(bucket, key, expires=60){
    const { data, error } = await sb().storage.from(bucket).createSignedUrl(key, expires);
    return error ? null : data?.signedUrl || null;
  }

  // ---- State ----
  let ORIGINAL_DOCX_AB = null;
  let lastIndex = [];
  let pollTimer = null;

  // Allow Power Edit to feed us the loaded DOCX (so we don’t re-download)
  window.addEventListener("pe:docx-loaded", (e) => {
    if (e?.detail?.ab) ORIGINAL_DOCX_AB = e.detail.ab;
  });

  // ---- Patch rendered HTML with change entries ----
  const norm = s => String(s||"").replace(/[–—]/g,"-").replace(/\s+/g," ").trim().toLowerCase();

  function applyChanges(root, changes){
    const paras = Array.from(root.querySelectorAll("p"));
    const bucket = new Map();
    for (const p of paras){
      const t = norm(p.textContent);
      if (!t) continue;
      if (!bucket.has(t)) bucket.set(t, []);
      bucket.get(t).push(p);
    }
    for (const ch of (changes || [])){
      const orig = norm(ch.original_paragraph_text || ch.anchor || "");
      if (!orig) continue;
      let candidates = bucket.get(orig);
      if (!candidates || !candidates.length){
        candidates = paras.filter(p => norm(p.textContent).includes(orig));
      }
      if (!candidates?.length) continue;
      const p = candidates.shift();
      if (ch.modified_paragraph_text){
        p.textContent = ch.modified_paragraph_text;
      } else if (ch.inserted_sentence){
        p.textContent = (p.textContent.trim() + " " + ch.inserted_sentence).replace(/\s+/g," ");
      }
    }
  }

  async function fetchOriginalDocxAB(){
    if (ORIGINAL_DOCX_AB) return ORIGINAL_DOCX_AB;
    const u = await getUser(); if (!u) return null;
    const url = await sign("resumes", `${u.id}/current.docx`, 60);
    if (!url) return null;
    const r = await fetch(url, { cache:"no-store" });
    if (!r.ok) return null;
    ORIGINAL_DOCX_AB = await r.arrayBuffer();
    return ORIGINAL_DOCX_AB;
  }

  async function loadIndex(){
    const u = await getUser(); if (!u) return [];
    const ixUrl = await sign("outputs", `${u.id}/drafts_index.json`, 60);
    if (!ixUrl) return [];
    try {
      const r = await fetch(ixUrl, { cache:"no-cache" });
      if (!r.ok) return [];
      const idx = await r.json();
      const arr = Array.isArray(idx?.changes) ? idx.changes.filter(Boolean) : [];
      return arr;
    } catch { return []; }
  }

  async function populateMenu(selectLatest=true){
    const arr = await loadIndex();
    const names = arr.slice().reverse(); // newest first
    lastIndex = arr.slice();

    if (sel){
      sel.innerHTML = "";
      if (!names.length){
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "(no change logs yet)";
        sel.appendChild(opt);
      } else {
        names.forEach((fname, i) => {
          const opt = document.createElement("option");
          opt.value = fname;
          opt.textContent = (i===0 ? "Latest — " : "") + fname.replace(/\.json$/,"");
          sel.appendChild(opt);
        });
        if (selectLatest) sel.selectedIndex = 0;
      }
    }
    return names;
  }

  async function renderSelected(){
    if (!target) return;
    target.innerHTML = "";
    if (msg) msg.textContent = "";

    const ab = await fetchOriginalDocxAB();
    if (!ab){ if (msg) msg.textContent = "Upload a .docx to preview the styled ‘after’ resume."; return; }

    const fname = sel?.value || "";
    if (!fname){ if (msg) msg.textContent = "No change log selected."; return; }

    const u = await getUser(); if (!u) return;
    const changeUrl = await sign("outputs", `${u.id}/changes/${fname}`, 60);
    if (!changeUrl){ if (msg) msg.textContent = "Could not load change log."; return; }

    let changes = [];
    try {
      const r = await fetch(changeUrl, { cache:"no-store" });
      if (r.ok){
        const obj = await r.json();
        changes = Array.isArray(obj) ? obj : (Array.isArray(obj?.changes) ? obj.changes : []);
      }
    } catch {}

    try {
      await window.docx.renderAsync(
        ab,
        target,
        null,
        { className:"docx", inWrapper:true, breakPages:true, ignoreFonts:false, trimXmlDeclaration:true }
      );
      applyChanges(target, changes || []);
    } catch(e){
      if (msg) msg.textContent = "Render error: " + String(e?.message || e);
    }
  }

  async function refreshAndRender(){
    const names = await populateMenu(true);
    if (names.length) await renderSelected();
  }

  // Event-driven hookup from Power Edit
  window.addEventListener("jc:autoTailor:done", async (e) => {
    const targetFile = e?.detail?.change;
    const names = await populateMenu(false);
    if (sel) {
      if (targetFile){
        const idx = names.findIndex(n => n === targetFile);
        sel.selectedIndex = idx >= 0 ? idx : 0;
      } else {
        sel.selectedIndex = 0;
      }
    }
    await renderSelected();
  });

  // Kickoff starts a brief polling loop (in case backend doesn’t echo filename)
  window.addEventListener("jc:autoTailor:kickoff", async () => {
    clearInterval(pollTimer);
    let tries = 0;
    pollTimer = setInterval(async () => {
      tries++;
      const current = await loadIndex();
      const added = current.filter(x => !lastIndex.includes(x));
      if (added.length){
        clearInterval(pollTimer);
        lastIndex = current.slice();
        await refreshAndRender();
      }
      if (tries >= 24) clearInterval(pollTimer); // ~2 minutes at 5s
    }, 5000);
  });

  // Manual controls
  btn?.addEventListener("click", renderSelected);
  sel?.addEventListener("change", renderSelected);

  // First paint
  window.addEventListener("load", refreshAndRender);

  // Tiny API for debugging
  window.AfterDocx = {
    refreshNow: refreshAndRender,
    render: renderSelected,
    setOriginalDocxAB: (ab) => { ORIGINAL_DOCX_AB = ab; }
  };
})();
