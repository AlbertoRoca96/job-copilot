// docs/profile.js — WCAG 2.2-ready overlay & UI + DOCX-styled AFTER preview
// Cross-browser fixes included: robust inert fallback to prevent focus leaks.
(async function () {
  await new Promise((r) => window.addEventListener("load", r));

  // ------------ Supabase ------------
  const SUPABASE_URL = window.SUPABASE_URL || "https://imozfqawxpsasjdmgdkh.supabase.co";
  const SUPABASE_ANON_KEY =
    window.SUPABASE_ANON_KEY ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imltb3pmcWF3eHBzYXNqZG1nZGtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg1Njk3NTUsImV4cCI6MjA3NDE0NTc1NX0.fkGObZvEy-oUfLrPcwgTSJbc-n6O5aE31SGIBeXImtc";

  async function ensureSupabase() {
    if (window.supabase?.createClient) return window.supabase;
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.js";
      s.defer = true; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
    return window.supabase;
  }
  const sbLib = await ensureSupabase();
  const supabase = sbLib.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // ------------ DOM ------------
  const $ = (id) => document.getElementById(id);
  const signinOnly = $("signinOnly");
  const profBox = $("profile");
  const onboard = $("onboard");
  const who = $("who");
  const logout = $("logout");

  // Tracker
  const trackerBox = $("tracker");
  const trackerList = $("trackerList");
  const refreshTrackerBtn = $("refreshTracker");
  const trackerCount = $("trackerCount");

  // Shortlist + materials
  const shortlist = $("shortlist");
  const jobsTable = $("jobs");
  const jobsBody = jobsTable?.querySelector("tbody");
  const shortlistCount = $("shortlistCount");

  const materials = $("materials");
  const cardsEl = $("cards");

  // Upload / targets
  const resumeInput = $("resume");
  const uploadBtn = $("uploadResume");
  const upMsg = $("upMsg");

  const titlesInput = $("desiredTitles");
  const locsInput = $("desiredLocs");
  const recencyInput = $("recencyDays");
  const remoteOnlyCb = $("remoteOnly");
  const requirePostCb = $("requirePosted");

  // Run & overlay
  const runBtn = $("runTailor");
  const runMsg = $("runMsg");
  const refresh = $("refresh");

  const runOverlay = $("runOverlay");
  const overlayHide = $("overlayHide");
  const overlayRefresh = $("overlayRefresh");
  const etaEl = $("eta");
  const progressFab = $("progressFab");

  // Drafts
  const runDrafts = $("runDrafts");
  const draftMsg = $("draftMsg");
  const topNInput = $("topN");

  // Change modal
  const changeModal = $("change-modal");
  const changeBody = changeModal?.querySelector(".modal-body");
  const changeClose = changeModal?.querySelector(".close");
  if (changeClose) changeClose.onclick = () => changeModal.classList.remove("open");
  if (changeModal) changeModal.addEventListener("click", (e) => { if (e.target === changeModal) changeModal.classList.remove("open"); });

  // NEW: After (DOCX) preview DOM
  const afterCard = $("afterDocxCard");
  const afterDocx = $("afterDocx");
  const afterMsg = $("afterDocxMsg");
  const afterChangeSel = $("afterChange");
  const afterRenderBtn = $("afterRender");

  // ------------ helpers ------------
  const getUser = () => supabase.auth.getUser().then((r) => r.data.user || null);
  const getSession = () => supabase.auth.getSession().then((r) => r.data.session || null);

  const pills = (arr) =>
    Array.isArray(arr) && arr.length ? arr.map((x) => `<span class="pill">${String(x)}</span>`).join(" ") : "—";

  const esc = (s) => String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const sign = async (bucket, key, expires = 60) => {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(key, expires);
    return error ? null : data?.signedUrl || null;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function fetchText(url) { const r = await fetch(url, { cache: "no-store" }); return r.ok ? r.text() : ""; }

  // ------------ auth gate ------------
  const user = await getUser();
  if (!user) { signinOnly?.classList.remove("hidden"); return; }
  who.textContent = `Signed in as ${user.email || user.id}`;
  signinOnly?.classList.add("hidden");
  profBox?.classList.remove("hidden");
  onboard?.classList.remove("hidden");
  $("powerEditCard")?.classList.remove("hidden");

  // ------------ load profile ------------
  {
    const { data: prof, error: profErr } = await supabase.from("profiles").select("*").eq("id", user.id).single();
    if (!profErr && prof) {
      $("full_name").textContent = prof?.full_name || "—";
      $("email").textContent = prof?.email || "—";
      $("phone").textContent = prof?.phone || "—";
      $("skills").innerHTML = pills(prof?.skills || []);
      $("titles").innerHTML = pills(prof?.target_titles || []);
      $("locs").innerHTML = pills(prof?.locations || []);
      const pol = prof?.search_policy || {};
      $("policy").textContent = [
        `recency_days=${pol.recency_days ?? 0}`,
        `require_posted_date=${!!pol.require_posted_date}`,
        `remote_only=${!!pol.remote_only}`,
      ].join(", ");
      $("updated").textContent = (prof?.updated_at || prof?.created_at || "—").toString();

      titlesInput.value = (prof?.target_titles || []).join(", ");
      locsInput.value = (prof?.locations || []).join(", ");
      recencyInput.value = String(pol?.recency_days ?? 0);
      remoteOnlyCb.checked = !!pol?.remote_only;
      requirePostCb.checked = !!pol?.require_posted_date;
    } else {
      $("full_name").textContent = `Error: ${profErr?.message || "profile not found"}`;
    }
  }

  // ------------ resume upload ------------
  uploadBtn.onclick = async () => {
    const session = await getSession();
    if (!session) return alert("Sign in first.");
    const file = resumeInput.files?.[0];
    if (!file) return alert("Choose a .docx file");

    const path = `${user.id}/current.docx`;
    const { error: upErr } = await supabase.storage.from("resumes").upload(path, file, { upsert: true });
    if (upErr) { upMsg.textContent = "Upload error: " + upErr.message; return; }

    const { error: metaErr } = await supabase.from("resumes").insert({ user_id: user.id, bucket: "resumes", path });
    if (metaErr) { upMsg.textContent = "Upload metadata error: " + metaErr.message; return; }
    upMsg.textContent = "Uploaded.";
  };

  // ================= OVERLAY & WATCHERS (with cross-browser focus trap) =================

  const LS_REQ = "jc.active_request";
  const LS_HIDE = "jc.overlay_hidden";

  let etaTimer = null;
  let pollTimer = null;

  // Focus trap helpers
  let prevFocus = null;
  function focusable(el) {
    return el ? Array.from(el.querySelectorAll(
      'a[href],area[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled]),[tabindex]:not([tabindex="-1"])'
    )).filter(n => n.offsetParent !== null) : [];
  }
  function trap(el) {
    const nodes = focusable(el);
    if (!nodes.length) return;
    const first = nodes[0], last = nodes[nodes.length-1];
    function onKey(e){
      if (e.key === 'Escape'){ hideOverlayOnly(); }
      if (e.key !== 'Tab') return;
      if (e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
    }
    el._trapHandler = onKey;
    el.addEventListener('keydown', onKey);
    first.focus();
  }
  function untrap(el){
    if (!el?._trapHandler) return;
    el.removeEventListener('keydown', el._trapHandler);
    delete el._trapHandler;
  }

  // Cross-browser inert (Safari/Firefox fallback)
  function setMainInert(on){
    const m = document.querySelector('main'); if (!m) return;

    // Native inert supported?
    if ('inert' in m){
      try { m.inert = !!on; } catch {}
      if (on) m.setAttribute('inert',''); else m.removeAttribute('inert');
      return;
    }

    // Fallback: aria-hide and remove focusability (restore later)
    if (on){
      m.setAttribute('aria-hidden','true');
      const focusables = m.querySelectorAll('a[href],area[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled]),[tabindex]:not([tabindex="-1"])');
      focusables.forEach(el => {
        if (el.getAttribute('tabindex') !== '-1'){
          el.setAttribute('data-inert-tmp','1');
          el.setAttribute('tabindex','-1');
        }
      });
    } else {
      m.removeAttribute('aria-hidden');
      m.querySelectorAll('[data-inert-tmp]').forEach(el => {
        el.removeAttribute('data-inert-tmp');
        if (el.getAttribute('tabindex') === '-1') el.removeAttribute('tabindex');
      });
    }
  }

  function openRunOverlay() {
    prevFocus = document.activeElement;
    runOverlay?.classList.add("open");
    progressFab?.classList.add("hidden");
    runBtn?.setAttribute('aria-expanded','true');
    setMainInert(true);
    trap(runOverlay);

    const started = Date.now();
    clearInterval(etaTimer);
    etaTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - started) / 1000);
      const m = String(Math.floor(elapsed / 60));
      const s = String(elapsed % 60).padStart(2, "0");
      if (etaEl) etaEl.textContent = `Elapsed ${m}:${s}. Typical runtime is 3–8 minutes. We’ll auto-refresh when results are ready.`;
    }, 1000);
  }

  function closeOverlayUIOnly() {
    runOverlay?.classList.remove("open");
    runBtn?.setAttribute('aria-expanded','false');
    untrap(runOverlay);
    setMainInert(false);
    if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
  }

  // Hide *without* stopping timers/polling
  function hideOverlayOnly() {
    closeOverlayUIOnly();
    progressFab?.classList.remove("hidden");
    localStorage.setItem(LS_HIDE, "1");
  }

  // Stop everything when job is done
  function finishOverlay() {
    closeOverlayUIOnly();
    progressFab?.classList.add("hidden");
    clearInterval(etaTimer); etaTimer = null;
    clearInterval(pollTimer); pollTimer = null;
    localStorage.removeItem(LS_REQ);
    localStorage.removeItem(LS_HIDE);
  }

  overlayHide?.addEventListener("click", () => hideOverlayOnly());
  overlayRefresh?.addEventListener("click", async () => { await loadShortlist(); });
  progressFab?.addEventListener("click", () => { localStorage.removeItem(LS_HIDE); openRunOverlay(); });

  runOverlay?.addEventListener('keydown', (e)=>{ if (e.key === 'Escape') hideOverlayOnly(); });

  // Storage polling for outputs/<uid>/scores.json
  async function pollForScoresJson() {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const u = await getUser();
        if (!u) return;
        const key = `${u.id}/scores.json`;
        const url = await sign("outputs", key, 30);
        if (!url) return;
        const res = await fetch(url, { cache: "no-cache" });
        if (!res.ok) return;
        const arr = await res.json().catch(() => []);
        if (Array.isArray(arr) && arr.length) {
          finishOverlay();
          await loadShortlist();
          if (shortlist && !shortlist.open) shortlist.open = true;
          shortlist?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      } catch { /* noop */ }
    }, 12000);
  }

  // Watch the job_requests row and fall back to storage polling
  async function watchJobRequest(requestId) {
    if (!localStorage.getItem(LS_HIDE)) openRunOverlay(); else progressFab?.classList.remove("hidden");

    let triedFallback = false;
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const { data: jr, error } = await supabase
          .from("job_requests")
          .select("status")
          .eq("id", requestId)
          .maybeSingle();

        if (error) throw error;

        const status = jr?.status || null;
        if (!status) { if (!triedFallback) { triedFallback = true; pollForScoresJson(); } return; }

        if (status === "done") {
          finishOverlay();
          await loadShortlist();
          if (shortlist && !shortlist.open) shortlist.open = true;
          shortlist?.scrollIntoView({ behavior: "smooth", block: "start" });
        } else if (status === "error") {
          finishOverlay();
          runMsg.textContent = "Job failed — check logs.";
        }
      } catch {
        if (!triedFallback) { triedFallback = true; pollForScoresJson(); }
      }
    }, 10000);
  }

  async function resumePendingWatcher() {
    const rid = localStorage.getItem(LS_REQ);
    if (!rid) return;
    if (!localStorage.getItem(LS_HIDE)) openRunOverlay(); else progressFab?.classList.remove("hidden");
    watchJobRequest(rid);
  }

  // ------------ Run crawl & rank ------------
  runBtn.onclick = async () => {
    const session = await getSession();
    if (!session) return alert("Sign in first.");
    runMsg.textContent = "Saving & queuing…";

    try {
      const titles = (titlesInput.value || "").split(",").map((s) => s.trim()).filter(Boolean);
      const locs   = (locsInput.value   || "").split(",").map((s) => s.trim()).filter(Boolean);
      const { error } = await supabase.from("profiles").update({ target_titles: titles, locations: locs }).eq("id", user.id);
      if (error) throw error;
    } catch (e) {
      runMsg.textContent = "Save failed: " + String(e.message || e); return;
    }

    try {
      const recency_days   = Math.max(0, parseInt(recencyInput.value || "0", 10) || 0);
      const remote_only    = !!remoteOnlyCb.checked;
      const require_posted = !!requirePostCb.checked;

      const { data, error } = await supabase.functions.invoke("request-run", {
        body: { note: "user run from profile",
                search_policy: { recency_days, require_posted_date: require_posted, remote_only } }
      });
      if (error) { runMsg.textContent = `Error: ${error.message || "invoke failed"}`; return; }

      const requestId = data?.request_id || null;
      runMsg.textContent = `Queued: ${requestId || "ok"} — building your shortlist (3–8 minutes)…`;

      if (requestId) {
        localStorage.setItem(LS_REQ, requestId);
        localStorage.removeItem(LS_HIDE);
        openRunOverlay();
        await sleep(50);
        watchJobRequest(requestId);
      } else {
        openRunOverlay();
        pollForScoresJson();
      }
    } catch (e) {
      runMsg.textContent = "Error: " + String(e);
    }
  };

  // ------------ Drafting queue ------------
  runDrafts.onclick = async () => {
    const session = await getSession();
    if (!session) return alert("Sign in first.");
    draftMsg.textContent = "Queuing drafting…";

    const top = Math.max(1, Math.min(20, parseInt(topNInput.value || "5", 10) || 5));
    try {
      const { data, error } = await supabase.functions.invoke("request-draft", { body: { top } });
      if (error) { draftMsg.textContent = `Error: ${error.message || "invoke failed"}`; return; }
      draftMsg.textContent = `Drafts queued: ${data?.request_id || "ok"} (top=${data?.top || top})`;
      setTimeout(() => { loadMaterials(); loadAfterMenu(); }, 3000);
    } catch (e) {
      draftMsg.textContent = "Error: " + String(e);
    }
  };

  // ------------ Shortlist loader ------------
  async function loadShortlist() {
    const u = await getUser();
    if (!u) return;

    const key = `${u.id}/scores.json`;
    const url = await sign("outputs", key, 60);

    if (!url) {
      shortlist?.classList.remove("hidden");
      jobsTable?.classList.add("hidden");
      $("noData")?.classList.remove("hidden");
      if (shortlistCount) shortlistCount.textContent = "0";
      return;
    }

    let arr = [];
    try {
      const res = await fetch(url, { cache: "no-cache" });
      if (res.ok) arr = await res.json();
    } catch { /* ignore */ }

    if (!Array.isArray(arr) || arr.length === 0) {
      shortlist?.classList.remove("hidden");
      jobsTable?.classList.add("hidden");
      $("noData")?.classList.remove("hidden");
      if (shortlistCount) shortlistCount.textContent = "0";
      return;
    }

    if (jobsBody) jobsBody.innerHTML = "";
    arr.sort((a, b) => (b.score || 0) - (a.score || 0));
    for (const j of arr) {
      const tr = document.createElement("tr");

      const tdScore = document.createElement("td");
      tdScore.textContent = (j.score ?? 0).toFixed(3);
      tr.appendChild(tdScore);

      const tdTitle = document.createElement("td");
      const a = document.createElement("a");
      a.href = j.url || j.link || j.jd_url || "#";
      a.target = "_blank"; a.rel = "noopener"; a.textContent = j.title || "(no title)";
      tdTitle.appendChild(a); tr.appendChild(tdTitle);

      const tdCompany = document.createElement("td");
      tdCompany.textContent = j.company || ""; tr.appendChild(tdCompany);

      const tdLoc = document.createElement("td");
      tdLoc.textContent = (j.location || "").trim(); tr.appendChild(tdLoc);

      const tdPosted = document.createElement("td");
      tdPosted.textContent = j.posted_at ? String(j.posted_at).slice(0, 10) : "—";
      tr.appendChild(tdPosted);

      jobsBody?.appendChild(tr);
    }

    if (shortlistCount) shortlistCount.textContent = String(arr.length);
    shortlist?.classList.remove("hidden");
    jobsTable?.classList.remove("hidden");
    $("noData")?.classList.add("hidden");
  }

  // ------------ Change log modal ------------
  function renderChangeCard(it) {
    const before = String(it.original_paragraph_text || "");
    const after  = String(it.modified_paragraph_text || "");
    const added  = String(it.inserted_sentence || "");
    const sec    = String(it.anchor_section || "");
    const anchor = String(it.anchor || "");
    const reason = String(it.reason || "");
    const afterHTML = esc(after).replace(esc(added), `<span class="change-insert">${esc(added)}</span>`);
    return `
      <div class="card" style="margin-bottom:10px">
        <div class="change-title">
          <span class="pill">${esc(sec)}</span>
          ${anchor ? `<span class="pill" style="margin-left:6px">${esc(anchor)}</span>` : ""}
        </div>
        <div>
          <div class="muted" style="margin-bottom:4px">Before</div>
          <pre class="mono">${esc(before)}</pre>
        </div>
        <div style="margin-top:8px">
          <div class="muted" style="margin-bottom:4px">After</div>
          <pre class="mono">${afterHTML}</pre>
        </div>
        ${reason ? `<div class="muted small" style="margin-top:6px">${esc(reason)}</div>` : ""}
      </div>
    `;
  }

  async function openChangeModal(jsonUrl) {
    if (!changeModal || !changeBody) return;
    try {
      const res = await fetch(jsonUrl, { cache: "no-cache" });
      if (!res.ok) throw new Error(`Fetch ${res.status}`);
      const obj = await res.json();
      const changes = Array.isArray(obj) ? obj : Array.isArray(obj?.changes) ? obj.changes : [];
      changeBody.innerHTML = changes.length
        ? changes.map(renderChangeCard).join("")
        : `<div class="muted">No granular changes recorded for this document.</div>`;
    } catch (e) {
      changeBody.innerHTML = `<div class="muted">Error loading diff: ${String(e)}</div>`;
    }
    changeModal.classList.add("open");
  }

  // ------------ Materials loader (cards only) ------------
  async function loadMaterials() {
    const u = await getUser();
    if (!u) return;

    const ixKey = `${u.id}/drafts_index.json`;
    const ixUrl = await sign("outputs", ixKey, 60);

    if (!ixUrl) {
      materials?.classList.remove("hidden");
      cardsEl.innerHTML = `<div class="muted">No drafts yet.</div>`;
      return;
    }

    let index = { changes: [] };
    try {
      const res = await fetch(ixUrl, { cache: "no-cache" });
      if (res.ok) index = await res.json();
    } catch { /* ignore */ }

    const clean = (arr) => (Array.isArray(arr) ? arr.filter(Boolean) : []);
    const changes = clean(index.changes);

    cardsEl.innerHTML = "<div class='muted'>Loading previews…</div>";
    const cards = [];

    for (const fname of changes) {
      try {
        const slug = fname.replace(/\.json$/, "");
        const changeUrl = await sign("outputs", `${u.id}/changes/${fname}`, 60);
        if (!changeUrl) continue;

        const change = await (await fetch(changeUrl, { cache: "no-store" })).json().catch(() => ({}));

        const company = change.company || "(company)";
        const title = change.title || "(title)";

        const coverRel  = change.paths?.cover_md || `outbox/${slug}.md`;
        const resumeRel = change.paths?.resume_docx || null;
        const jdTextRel = change.paths?.jd_text || `changes/${slug}.jd.txt`;

        const coverUrl  = await sign("outputs", `${u.id}/${coverRel}`, 60);
        const resumeUrl = resumeRel ? await sign("outputs", `${u.id}/${resumeRel}`, 60) : null;
        const jdUrl     = await sign("outputs", `${u.id}/${jdTextRel}`, 60);

        const [coverMd, jdTxt] = await Promise.all([ coverUrl ? fetchText(coverUrl) : "", jdUrl ? fetchText(jdUrl) : "" ]);
        const themes = (change.cover_meta?.company_themes || []).slice(0, 6);

        const card = document.createElement("div");
        card.className = "card";

        const head = document.createElement("div");
        head.className = "card-head";
        const titleEl = document.createElement("div");
        titleEl.className = "title";
        titleEl.innerHTML = `${esc(company)} — ${esc(title)}`;
        head.appendChild(titleEl);

        if (resumeUrl) {
          const a = document.createElement("a");
          a.className = "btn"; a.href = resumeUrl; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Resume (.docx)";
          head.appendChild(a);
        }

        const viewChanges = document.createElement("button");
        viewChanges.className = "btn"; viewChanges.textContent = "View Change Log";
        viewChanges.onclick = () => openChangeModal(changeUrl);
        head.appendChild(viewChanges);
        card.appendChild(head);

        const grid = document.createElement("div");
        grid.className = "grid2";

        const left = document.createElement("div");
        left.className = "pane";
        left.innerHTML =
          `<h3>JD excerpt</h3><div class="muted small">pulled from the posting</div>` +
          `<div class="jd" tabindex="0" role="region" aria-label="Job description excerpt (scrollable)">${esc(jdTxt || "")}</div>`;

        const right = document.createElement("div");
        right.className = "pane";
        right.innerHTML = `<h3>Company themes</h3>`;
        if (themes.length) {
          const ul = document.createElement("ul");
          ul.className = "bullets";
          themes.forEach((t) => { const li = document.createElement("li"); li.textContent = t; ul.appendChild(li); });
          right.appendChild(ul);
        } else {
          const none = document.createElement("div");
          none.className = "muted"; none.textContent = "No themes detected."; right.appendChild(none);
        }

        grid.appendChild(left); grid.appendChild(right); card.appendChild(grid);

        const details = document.createElement("details");
        details.className = "cover";
        const summary = document.createElement("summary");
        summary.textContent = "Cover letter preview";
        details.appendChild(summary);

        const pre = document.createElement("pre");
        pre.className = "mono"; pre.textContent = coverMd || "(cover not found)";
        details.appendChild(pre);

        if (coverUrl) {
          const open = document.createElement("a");
          open.className = "btn"; open.href = coverUrl; open.target = "_blank"; open.rel = "noopener"; open.textContent = "Open cover";
          details.appendChild(document.createTextNode(" ")); details.appendChild(open);
        }

        card.appendChild(details);
        cards.push(card);
      } catch (e) {
        console.error("Preview build error:", e);
      }
    }

    cardsEl.innerHTML = "";
    if (cards.length) cards.forEach((c) => cardsEl.appendChild(c));
    else cardsEl.innerHTML = `<div class="muted">No drafts yet.</div>`;
    materials?.classList.remove("hidden");
  }

  // ============ NEW: After (DOCX styles) preview ============
  let ORIGINAL_DOCX_AB = null;

  const norm = s => String(s||"")
    .replace(/[–—]/g,"-")
    .replace(/\s+/g," ")
    .trim()
    .toLowerCase();

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
    const key = `${u.id}/current.docx`;
    const url = await sign("resumes", key, 60);
    if (!url) return null;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    ORIGINAL_DOCX_AB = await res.arrayBuffer();
    return ORIGINAL_DOCX_AB;
  }

  async function loadAfterMenu(){
    const u = await getUser(); if (!u) return;
    const ixUrl = await sign("outputs", `${u.id}/drafts_index.json`, 60);
    const resumeUrl = await sign("resumes", `${u.id}/current.docx`, 30);

    let changes = [];
    if (ixUrl){
      try {
        const res = await fetch(ixUrl, { cache: "no-cache" });
        if (res.ok){
          const idx = await res.json();
          changes = Array.isArray(idx?.changes) ? idx.changes.filter(Boolean) : [];
        }
      } catch {/* ignore */}
    }

    if (resumeUrl && changes.length){
      afterCard?.classList.remove("hidden");
      afterChangeSel.innerHTML = "";
      changes.slice().reverse().forEach((fname, i) => {
        const opt = document.createElement("option");
        const slug = fname.replace(/\.json$/, "");
        opt.value = fname;
        opt.textContent = (i===0 ? "Latest — " : "") + slug;
        afterChangeSel.appendChild(opt);
      });
    } else {
      afterCard?.classList.add("hidden");
    }
  }

  async function renderAfterDocx(){
    if (!afterDocx) return;
    afterDocx.innerHTML = "";
    afterMsg.textContent = "";

    if (!window.docx || typeof window.docx.renderAsync !== "function"){
      afterMsg.textContent = "Viewer not loaded yet — try again after the page finishes loading.";
      return;
    }

    const ab = await fetchOriginalDocxAB();
    if (!ab) { afterMsg.textContent = "Upload a .docx to preview the styled ‘after’ resume."; return; }

    const fname = afterChangeSel?.value || "";
    if (!fname) { afterMsg.textContent = "No change log selected."; return; }

    const u = await getUser(); if (!u) return;
    const changeUrl = await sign("outputs", `${u.id}/changes/${fname}`, 60);
    if (!changeUrl){ afterMsg.textContent = "Could not load change log."; return; }

    let changes = [];
    try {
      const r = await fetch(changeUrl, { cache: "no-store" });
      if (r.ok){
        const obj = await r.json();
        changes = Array.isArray(obj) ? obj : (Array.isArray(obj?.changes) ? obj.changes : []);
      }
    } catch {/* ignore */}

    try {
      await window.docx.renderAsync(
        ab,
        afterDocx,
        null,
        { className: "docx", inWrapper: true, breakPages: true, ignoreFonts: false, trimXmlDeclaration: true }
      );
      applyChangesToRenderedDocx(afterDocx, changes || []);
    } catch (e) {
      afterMsg.textContent = "Render error: " + String(e?.message || e);
    }
  }

  afterRenderBtn?.addEventListener("click", renderAfterDocx);
  afterChangeSel?.addEventListener("change", renderAfterDocx);

  // ------------ Tracker ------------
  const STATUS_ORDER = ["saved", "applied", "interview", "offer", "rejected"];
  function statusButtons(current) {
    const div = document.createElement("div");
    for (const s of STATUS_ORDER) {
      const b = document.createElement("button");
      b.className = "btn"; b.disabled = s === current; b.textContent = s; b.type = "button";
      b.onclick = async () => {
        try {
          const { data: u } = await supabase.auth.getUser();
          const uid = u?.user?.id;
          if (!uid) { alert("Not signed in."); return; }
          const { error } = await supabase.from("applications").insert([{ user_id: uid, job_id: b.dataset.jobId, status: s }]);
          if (error) throw error;
          await loadTracker();
        } catch (e) { alert("Update failed: " + (e?.message || e)); }
      };
      div.appendChild(b);
    }
    return div;
  }

  async function loadTracker() {
    const u = await getUser();
    if (!u || !trackerBox || !trackerList) return;

    const { data, error } = await supabase
      .from("v_tracker_cards")
      .select("*")
      .order("job_created_at", { ascending: false })
      .limit(100);

    trackerList.innerHTML = "";
    if (error) {
      trackerBox.classList.remove("hidden");
      trackerList.innerHTML = `<div class="muted">Tracker load error: ${esc(error.message)}</div>`;
      if (trackerCount) trackerCount.textContent = "0";
      return;
    }
    if (!data || !data.length) {
      trackerBox.classList.remove("hidden");
      trackerList.innerHTML = `<div class="muted">No tracked applications yet.</div>`;
      if (trackerCount) trackerCount.textContent = "0";
      return;
    }

    for (const row of data) {
      const card = document.createElement("div");
      card.className = "card";

      const head = document.createElement("div");
      head.className = "card-head";

      const titleEl = document.createElement("div");
      titleEl.className = "title";
      titleEl.innerHTML = `${esc(row.company || "")} — ${esc(row.title || "")}`;
      head.appendChild(titleEl);

      const badge = document.createElement("span");
      badge.className = "pill";
      badge.textContent = row.latest_status || "saved";
      head.appendChild(badge);

      card.appendChild(head);

      const meta = document.createElement("div");
      meta.className = "muted";
      const loc = row.location ? ` • ${esc(row.location)}` : "";
      const when = row.latest_status_at ? ` • ${String(row.latest_status_at).slice(0,10)}` : "";
      meta.innerHTML = `<a href="${esc(row.url || "#")}" target="_blank" rel="noopener">Open posting</a>${loc}${when}`;
      card.appendChild(meta);

      const controls = statusButtons(row.latest_status || "saved");
      controls.querySelectorAll("button").forEach(b => b.dataset.jobId = row.id);
      controls.style.marginTop = "8px";
      card.appendChild(controls);

      trackerList.appendChild(card);
    }

    if (trackerCount) trackerCount.textContent = String(data.length);
    trackerBox.classList.remove("hidden");
  }

  refreshTrackerBtn.onclick = loadTracker;

  // ------------ refresh/init/logout ------------
  refresh.onclick = async () => {
    await loadShortlist();
    await loadMaterials();
    await loadTracker();
    await loadAfterMenu();
  };

  await loadShortlist();
  await loadMaterials();
  await loadTracker();
  await loadAfterMenu();
  await resumePendingWatcher();

  logout.onclick = async () => {
    await supabase.auth.signOut();
    location.reload();
  };
})();

// --- Voice Assistant: page-specific hook (optional example) ---
window.addEventListener('load', () => {
  if (!window.voiceAssistant) return;
  window.voiceAssistant.register({
    "/read (before|after) panel/": () => {
      const el = document.getElementById('afterDocxPE') || document.getElementById('docxPreview');
      window.voiceAssistant.say((el?.textContent || '').trim().slice(0,600) || "Nothing to read.");
    }
  });
});
