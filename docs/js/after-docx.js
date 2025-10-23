// /docs/js/after-docx.js
// Renders the DOCX-styled “After” preview (docx-preview) and auto-refreshes when:
// 1) Power Edit’s Auto-tailor finishes (event-driven), or
// 2) A new change file lands in outputs/<uid>/changes (short polling fallback).
//
// Reuses the same render API as the “Formatted Resume”:
//   docx.renderAsync(arrayBuffer, bodyEl, styleEl, options)
// Then patches the rendered DOM with change entries (paragraph-level mapping).

(function(){
  // ---- DOM wiring (Power Edit ids) ----
  const $ = (id) => document.getElementById(id);
  const els = {
    sel: $("afterChangePE"),
    renderBtn: $("afterRenderPE"),
    target: $("afterDocxPE"),
    msg: $("afterDocxMsgPE"),
  };

  if (!els.target) return; // Page not present

  // ---- Supabase helpers ----
  function ensureClient(){
    if (window._supabaseClient) return window._supabaseClient;
    const sb = window.supabase?.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
    window._supabaseClient = sb;
    return sb;
  }
  async function getUser(){ const { data } = await ensureClient().auth.getUser(); return data.user || null; }
  async function sign(bucket, key, expires=60){
    const { data, error } = await ensureClient().storage.from(bucket).createSignedUrl(key, expires);
    return error ? null : data?.signedUrl || null;
  }

  // ---- State ----
  let ORIGINAL_DOCX_AB = null;
  let lastIndexNames = []; // for polling deltas
  let pollTimer = null;

  // Allow Power Edit to feed us the loaded DOCX
  window.addEventListener("pe:docx-loaded", (e) => {
    if (e?.detail?.ab) {
      ORIGINAL_DOCX_AB = e.detail.ab;
    }
  });

  // ---- Diff patching ----
  const norm = s => String(s||"").replace(/[–—]/g,"-").replace(/\s+/g," ").trim().toLowerCase();

  function applyChangesToRenderedDocx(root, changes){
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
      if (!candidates.length) continue;

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
    const res = await fetch(url, { cache:"no-store" });
    if (!res.ok) return null;
    ORIGINAL_DOCX_AB = await res.arrayBuffer();
    return ORIGINAL_DOCX_AB;
  }

  // ---- Menu + render ----
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

  async function loadMenu(selectLatest=true){
    const arr = await loadIndex();
    const names = arr.slice().reverse(); // newest first
    lastIndexNames = arr.slice();

    if (els.sel){
      els.sel.innerHTML = "";
      if (!names.length){
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "(no change logs yet)";
        els.sel.appendChild(opt);
      } else {
        names.forEach((fname, i) => {
          const opt = document.createElement("option");
          opt.value = fname;
          opt.textContent = (i===0 ? "Latest — " : "") + fname.replace(/\.json$/,"");
          els.sel.appendChild(opt);
        });
        if (selectLatest) els.sel.selectedIndex = 0;
      }
    }

    return names;
  }

  async function renderAfterFromSelected(){
    if (!els.target) return;
    els.target.innerHTML = "";
    if (els.msg) els.msg.textContent = "";

    const ab = await fetchOriginalDocxAB();
    if (!ab){ if (els.msg) els.msg.textContent = "Upload a .docx to preview the styled ‘after’ resume."; return; }

    const fname = els.sel?.value || "";
    if (!fname){ if (els.msg) els.msg.textContent = "No change log selected."; return; }

    const u = await getUser(); if (!u) return;
    const changeUrl = await sign("outputs", `${u.id}/changes/${fname}`, 60);
    if (!changeUrl){ if (els.msg) els.msg.textContent = "Could not load change log."; return; }

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
        els.target,
        null,
        { className:"docx", inWrapper:true, breakPages:true, ignoreFonts:false, trimXmlDeclaration:true }
      );
      applyChangesToRenderedDocx(els.target, changes || []);
    } catch(e){
      if (els.msg) els.msg.textContent = "Render error: " + String(e?.message || e);
    }
  }

  // ---- Event wiring ----
  async function refreshMenuAndRender(){
    const names = await loadMenu(true);
    if (names.length) await renderAfterFromSelected();
  }

  // React to a successful Auto-tailor run (event-driven)
  window.addEventListener("jc:autoTailor:done", async (e) => {
    // If we were told the exact file, try to select it; otherwise just select latest
    const targetFile = e?.detail?.change;
    const names = await loadMenu(false);
    if (targetFile && els.sel){
      const idx = names.findIndex(n => n === targetFile);
      if (idx >= 0) els.sel.selectedIndex = idx;
      else els.sel.selectedIndex = 0;
    } else if (els.sel){
      els.sel.selectedIndex = 0;
    }
    await renderAfterFromSelected();
  });

  // Kickoff: short polling while server works (best-effort)
  window.addEventListener("jc:autoTailor:kickoff", async () => {
    clearInterval(pollTimer);
    let tries = 0;
    pollTimer = setInterval(async () => {
      tries++;
      const current = await loadIndex();
      const added = current.filter(x => !lastIndexNames.includes(x));
      if (added.length){
        clearInterval(pollTimer);
        lastIndexNames = current.slice();
        await refreshMenuAndRender();
      }
      if (tries >= 24){ // ~2 minutes @5s
        clearInterval(pollTimer);
      }
    }, 5000);
  });

  // Manual controls
  els.renderBtn?.addEventListener("click", renderAfterFromSelected);
  els.sel?.addEventListener("change", renderAfterFromSelected);

  // First paint
  window.addEventListener("load", refreshMenuAndRender);

  // Expose a tiny API if needed elsewhere
  window.AfterDocx = {
    refreshNow: refreshMenuAndRender,
    render: renderAfterFromSelected,
    setOriginalDocxAB: (ab) => { ORIGINAL_DOCX_AB = ab; }
  };
})();
