// docs/profile.js — standalone (no site.js needed)

(async function () {
  await new Promise((r) => window.addEventListener("load", r));

  const supabase = window.supabase.createClient(
    "https://imozfqawxpsasjdmgdkh.supabase.co",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imltb3pmcWF3eHBzYXNqZG1nZGtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg1Njk3NTUsImV4cCI6MjA3NDE0NTc1NX0.fkGObZvEy-oUfLrPcwgTSJbc-n6O5aE31SGIBeXImtc"
  );

  // ----- DOM -----
  const signinOnly = document.getElementById("signinOnly");
  const profBox    = document.getElementById("profile");
  const onboard    = document.getElementById("onboard");
  const shortlist  = document.getElementById("shortlist");
  const jobsTable  = document.getElementById("jobs");
  const jobsBody   = jobsTable.querySelector("tbody");

  const who     = document.getElementById("who");
  const logout  = document.getElementById("logout");

  // upload controls
  const resumeInput = document.getElementById("resume");
  const uploadBtn   = document.getElementById("uploadResume");
  const upMsg       = document.getElementById("upMsg");

  // targets controls
  const titlesInput   = document.getElementById("desiredTitles");
  const locsInput     = document.getElementById("desiredLocs");
  const recencyInput  = document.getElementById("recencyDays");
  const remoteOnlyCb  = document.getElementById("remoteOnly");
  const requirePostCb = document.getElementById("requirePosted");

  // run controls
  const runBtn   = document.getElementById("runTailor");
  const runMsg   = document.getElementById("runMsg");
  const refresh  = document.getElementById("refresh");

  // materials/drafts controls
  const matBox    = document.getElementById("materials");
  const genBtn    = document.getElementById("genBtn");
  const genMsg    = document.getElementById("genMsg");
  const topN      = document.getElementById("topN");
  const draftTbl  = document.getElementById("draftTable");
  const draftBody = draftTbl.querySelector("tbody");
  const noDrafts  = document.getElementById("noDrafts");

  // ----- helpers -----
  function pills(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return "—";
    return arr.map((x) => `<span class="pill">${String(x)}</span>`).join(" ");
  }
  function escapeHTML(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function getUser()     { return supabase.auth.getUser().then(r => r.data.user || null); }
  function getSession()  { return supabase.auth.getSession().then(r => r.data.session || null); }

  // ----- word-level diff -----
  function diffWords(a, b) {
    const A = (a || "").trim().split(/\s+/), B = (b || "").trim().split(/\s+/);
    const n = A.length, m = B.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
    const chunks = []; let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { chunks.push({ t:"eq", x:A[i++] }); j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) chunks.push({ t:"del", x:A[i++] });
      else chunks.push({ t:"ins", x:B[j++] });
    }
    while (i < n) chunks.push({ t:"del", x:A[i++] });
    while (j < m) chunks.push({ t:"ins", x:B[j++] });
    return chunks;
  }
  function renderWordDiffHTML(original, modified) {
    const coalesced = [];
    for (const c of diffWords(original, modified)) {
      const last = coalesced[coalesced.length - 1];
      if (last && last.t === c.t) last.x += " " + c.x; else coalesced.push({ ...c });
    }
    return coalesced.map(({ t, x }) => {
      const h = escapeHTML(x);
      if (t === "eq")  return h;
      if (t === "ins") return `<ins style="background:#e6ffe6;text-decoration:none">${h}</ins>`;
      if (t === "del") return `<del style="background:#ffecec">${h}</del>`;
      return h;
    }).join(" ").replace(/\s+(<\/(ins|del)>)/g, "$1");
  }

  // ----- modal & changes viewer -----
  function ensureModalRoot() {
    let root = document.getElementById("modal-root");
    if (root) return root;
    root = document.createElement("div");
    root.id = "modal-root";
    Object.assign(root.style, {
      position:"fixed", inset:"0", display:"none", alignItems:"center", justifyContent:"center",
      background:"rgba(0,0,0,0.35)", zIndex:"9999"
    });
    root.addEventListener("click", (e) => { if (e.target === root) closeModal(); });
    document.body.appendChild(root);
    return root;
  }
  function closeModal() {
    const root = ensureModalRoot();
    root.style.display = "none"; root.innerHTML = "";
  }
  function openModal(title, innerEl) {
    const root = ensureModalRoot(); root.innerHTML = "";
    const box = document.createElement("div");
    Object.assign(box.style, {
      width:"min(900px, 92vw)", maxHeight:"86vh", overflow:"auto", background:"#fff", borderRadius:"12px",
      boxShadow:"0 10px 28px rgba(0,0,0,0.2)", padding:"14px"
    });
    const header = document.createElement("div");
    Object.assign(header.style, { display:"flex", alignItems:"center", justifyContent:"space-between", gap:"12px", marginBottom:"10px" });
    const h = document.createElement("h3"); h.textContent = title; h.style.margin = "0";
    const btn = document.createElement("button"); btn.textContent = "Close"; btn.className = "btn"; btn.onclick = closeModal;
    header.appendChild(h); header.appendChild(btn);
    box.appendChild(header); box.appendChild(innerEl); root.appendChild(box); root.style.display = "flex";
  }
  function makeBadge(text) {
    const b = document.createElement("span");
    b.textContent = text;
    Object.assign(b.style, { display:"inline-block", padding:"2px 8px", margin:"2px 6px 2px 0",
      border:"1px solid #e0e0e0", borderRadius:"999px", background:"#f6f6f6", fontSize:"12px" });
    return b;
  }
  function renderChangesViewer(json, signedUrl, filename) {
    const tabs = document.createElement("div");
    Object.assign(tabs.style, { display:"flex", gap:"6px", marginBottom:"8px" });
    const tabCmp = document.createElement("button"); tabCmp.textContent = "Comparison"; tabCmp.className = "btn";
    const tabRaw = document.createElement("button"); tabRaw.textContent = "Raw JSON"; tabRaw.className = "btn";

    const meta = document.createElement("div");
    meta.style.margin = "6px 0 12px 0";
    meta.innerHTML = `
      <div style="margin-bottom:6px"><div><strong>Company</strong></div><div>${escapeHTML(json?.company || "—")}</div></div>
      <div style="margin-bottom:6px"><div><strong>Title</strong></div><div>${escapeHTML(json?.title || "—")}</div></div>
      <div style="margin-bottom:6px"><div><strong>ATS keywords</strong></div><div id="kwRow"></div></div>
      <div style="margin-bottom:6px;color:#666"><div><strong>JD hash</strong></div><div>${escapeHTML(json?.jd_hash || "—")}</div></div>
      <div style="margin-bottom:8px"><a href="${signedUrl}" target="_blank" rel="noopener">Download</a></div>
    `;
    const kwRow = meta.querySelector("#kwRow");
    (json?.ats_keywords || []).forEach((k) => kwRow.appendChild(makeBadge(String(k))));

    const cmp = document.createElement("div");
    function boxify(title, html) {
      const outer = document.createElement("div");
      const t = document.createElement("div"); t.textContent = title; t.style.fontWeight = "600"; t.style.marginBottom = "4px";
      const body = document.createElement("div");
      Object.assign(body.style, { whiteSpace:"pre-wrap", border:"1px solid #f0f0f0", borderRadius:"8px", padding:"8px", background:"#fcfcfc" });
      body.innerHTML = html; outer.appendChild(t); outer.appendChild(body); return outer;
    }
    function makeCompareCard(item, idx) {
      const card = document.createElement("div");
      Object.assign(card.style, { border:"1px solid #eee", borderRadius:"10px", padding:"10px", margin:"10px 0" });
      const head = document.createElement("div");
      Object.assign(head.style, { display:"flex", justifyContent:"space-between", alignItems:"center", gap:"8px", marginBottom:"8px" });
      const label = document.createElement("div");
      label.innerHTML = `<strong>Change ${idx + 1}</strong>${item?.anchor_section ? ` — ${escapeHTML(item.anchor_section)}` : ""}`;
      head.appendChild(label); card.appendChild(head);

      const grid = document.createElement("div");
      Object.assign(grid.style, { display:"grid", gridTemplateColumns:"1fr 1fr", gap:"10px" });

      const originalText = item?.original_paragraph_text || "";
      const modifiedText = item?.modified_paragraph_text || originalText;
      const inserted = item?.inserted_sentence || "";

      let rightHTML;
      if (inserted && !originalText.includes(inserted) && modifiedText.includes(inserted)) {
        const re = new RegExp(`(${inserted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "i");
        rightHTML = escapeHTML(modifiedText).replace(re, "<mark>$1</mark>");
      } else {
        rightHTML = renderWordDiffHTML(originalText, modifiedText);
      }

      const left = document.createElement("div");
      const right = document.createElement("div");
      left.appendChild(boxify("Original paragraph", escapeHTML(originalText || "—")));
      right.appendChild(boxify("Modified paragraph", rightHTML || "—"));
      grid.appendChild(left); grid.appendChild(right); card.appendChild(grid);
      return card;
    }

    const items = Array.isArray(json?.changes) ? json.changes : [];
    if (items.length === 0) {
      const empty = document.createElement("div"); empty.style.color = "#666";
      empty.textContent = "No granular changes recorded for this job."; cmp.appendChild(empty);
    } else {
      items.forEach((it, i) => cmp.appendChild(makeCompareCard(it, i)));
    }

    const pre = document.createElement("pre");
    Object.assign(pre.style, { border:"1px solid #eee", borderRadius:"10px", padding:"10px", background:"#fcfcfc", whiteSpace:"pre-wrap" });
    pre.textContent = JSON.stringify(json || {}, null, 2);

    function showCmp() { cmp.style.display = ""; pre.style.display = "none"; }
    function showRaw() { cmp.style.display = "none"; pre.style.display = ""; }
    tabCmp.onclick = showCmp; tabRaw.onclick = showRaw; showCmp();

    const wrap2 = document.createElement("div");
    wrap2.appendChild(tabs); wrap2.appendChild(meta); wrap2.appendChild(cmp); wrap2.appendChild(pre);
    openModal(`Changes — ${filename}`, wrap2);
  }

  // ----- auth state & profile -----
  const user = await getUser();
  if (!user) { signinOnly.classList.remove("hidden"); return; }

  who.textContent = `Signed in as ${user.email || user.id}`;
  profBox.classList.remove("hidden");
  onboard.classList.remove("hidden");
  matBox.classList.remove("hidden");

  const { data: prof, error: profErr } = await supabase.from("profiles").select("*").eq("id", user.id).single();
  if (!profErr && prof) {
    document.getElementById("full_name").textContent = prof?.full_name || "—";
    document.getElementById("email").textContent     = prof?.email || "—";
    document.getElementById("phone").textContent     = prof?.phone || "—";
    document.getElementById("skills").innerHTML      = pills(prof?.skills || []);
    document.getElementById("titles").innerHTML      = pills(prof?.target_titles || []);
    document.getElementById("locs").innerHTML        = pills(prof?.locations || []);
    const pol = prof?.search_policy || {};
    const s = [
      `recency_days=${pol.recency_days ?? 0}`,
      `require_posted_date=${!!pol.require_posted_date}`,
      `remote_only=${!!pol.remote_only}`,
    ].join(", ");
    document.getElementById("policy").textContent  = s;
    document.getElementById("updated").textContent = (prof?.updated_at || prof?.created_at || "—").toString();

    // prefill controls
    titlesInput.value  = (prof?.target_titles || []).join(", ");
    locsInput.value    = (prof?.locations || []).join(", ");
    recencyInput.value = String(pol?.recency_days ?? 0);
    remoteOnlyCb.checked  = !!pol?.remote_only;
    requirePostCb.checked = !!pol?.require_posted_date;
  } else {
    document.getElementById("full_name").textContent = `Error: ${profErr?.message || "profile not found"}`;
  }

  // ----- upload resume -----
  uploadBtn.onclick = async () => {
    const session = await getSession(); if (!session) return alert("Sign in first.");
    const file = resumeInput.files[0]; if (!file) return alert("Choose a .docx file");
    const path = `${user.id}/current.docx`;
    const { error: upErr } = await supabase.storage.from("resumes").upload(path, file, { upsert: true });
    if (upErr) { upMsg.textContent = "Upload error: " + upErr.message; return; }
    const { error: metaErr } = await supabase.from("resumes").insert({ user_id: user.id, bucket: "resumes", path });
    if (metaErr) { upMsg.textContent = "Upload metadata error: " + metaErr.message; return; }
    upMsg.textContent = "Uploaded.";
  };

  // ----- run crawl & rank -----
  runBtn.onclick = async () => {
    const session = await getSession(); if (!session) return alert("Sign in first.");
    runMsg.textContent = "Queuing…";
    const titles = (titlesInput.value || "").split(",").map(s => s.trim()).filter(Boolean);
    const locs   = (locsInput.value || "").split(",").map(s => s.trim()).filter(Boolean);
    const recencyDays   = Math.max(0, parseInt(recencyInput.value || "0", 10) || 0);
    const remoteOnly    = !!remoteOnlyCb.checked;
    const requirePosted = !!requirePostCb.checked;

    try {
      const restBase = "https://imozfqawxpsasjdmgdkh.supabase.co";
      const resp = await fetch(`${restBase}/functions/v1/request-run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imltb3pmcWF3eHBzYXNqZG1nZGtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg1Njk3NTUsImV4cCI6MjA3NDE0NTc1NX0.fkGObZvEy-oUfLrPcwgTSJbc-n6O5aE31SGIBeXImtc",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          note: "user run from profile",
          preferences: {
            target_titles: titles,
            locations: locs,
            search_policy: {
              recency_days: recencyDays,
              require_posted_date: requirePosted,
              remote_only: remoteOnly
            }
          }
        }),
      });
      let out = {}; try { out = await resp.json(); } catch {}
      if (!resp.ok) { runMsg.textContent = `Error: ${out.detail || out.error || resp.status}`; return; }
      runMsg.textContent = `Queued: ${out.request_id || "ok"}`;
      // Optional: kick off a shortlist refresh soon after
      setTimeout(loadShortlist, 3000);
    } catch (e) {
      runMsg.textContent = "Error: " + String(e);
    }
  };

  // ----- shortlist loader -----
  async function loadShortlist() {
    const u = await getUser(); if (!u) return;
    const key = `${u.id}/scores.json`;
    const { data, error } = await supabase.storage.from("outputs").createSignedUrl(key, 60);
    if (error || !data?.signedUrl) {
      shortlist.classList.remove("hidden");
      jobsTable.classList.add("hidden");
      document.getElementById("noData").classList.remove("hidden");
      return;
    }
    let arr = [];
    try {
      const res = await fetch(data.signedUrl, { cache: "no-cache" });
      if (res.ok) arr = await res.json();
    } catch {}
    if (!Array.isArray(arr) || arr.length === 0) {
      shortlist.classList.remove("hidden");
      jobsTable.classList.add("hidden");
      document.getElementById("noData").classList.remove("hidden");
      return;
    }
    jobsBody.innerHTML = "";
    arr.sort((a,b)=>(b.score||0)-(a.score||0));
    for (const j of arr) {
      const tr = document.createElement("tr");
      const tdScore = document.createElement("td"); tdScore.textContent = (j.score ?? 0).toFixed(3); tr.appendChild(tdScore);
      const tdTitle = document.createElement("td");
      const a = document.createElement("a"); a.href = j.url || "#"; a.target = "_blank"; a.rel = "noopener"; a.textContent = j.title || "(no title)";
      tdTitle.appendChild(a); tr.appendChild(tdTitle);
      const tdCompany = document.createElement("td"); tdCompany.textContent = j.company || ""; tr.appendChild(tdCompany);
      const tdLoc = document.createElement("td"); tdLoc.textContent = (j.location || "").trim(); tr.appendChild(tdLoc);
      const tdPosted = document.createElement("td"); tdPosted.textContent = j.posted_at ? String(j.posted_at).slice(0,10) : "—"; tr.appendChild(tdPosted);
      jobsBody.appendChild(tr);
    }
    shortlist.classList.remove("hidden");
    jobsTable.classList.remove("hidden");
    document.getElementById("noData").classList.add("hidden");
  }

  refresh.onclick = loadShortlist;
  await loadShortlist();

  // ----- drafts generation -----
  async function generateDrafts() {
    genMsg.textContent = "Queuing…";
    const session = await getSession(); if (!session) { genMsg.textContent = "Sign in first."; return; }
    try {
      const restBase = "https://imozfqawxpsasjdmgdkh.supabase.co";
      const resp = await fetch(`${restBase}/functions/v1/request-draft`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imltb3pmcWF3eHBzYXNqZG1nZGtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg1Njk3NTUsImV4cCI6MjA3NDE0NTc1NX0.fkGObZvEy-oUfLrPcwgTSJbc-n6O5aE31SGIBeXImtc",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ top: Math.max(1, Math.min(20, parseInt(topN.value || "5", 10) || 5)) }),
      });
      const out = (await resp.json().catch(() => ({}))) || {};
      if (!resp.ok) { genMsg.textContent = `Error: ${out.detail || out.error || resp.status}`; return; }
      genMsg.textContent = `Queued request ${out.request_id}. Refresh in a bit.`;
      pollDrafts();
    } catch (e) {
      genMsg.textContent = "Error: " + String(e);
    }
  }

  async function loadDrafts() {
    draftBody.innerHTML = "";
    const u = await getUser(); if (!u) return;
    const key = `${u.id}/drafts_index.json`;
    const { data: signed } = await supabase.storage.from("outputs").createSignedUrl(key, 60);
    if (!signed?.signedUrl) {
      draftTbl.classList.add("hidden"); noDrafts.classList.remove("hidden"); return;
    }
    let idx = null;
    try {
      const r = await fetch(signed.signedUrl, { cache: "no-cache" });
      if (r.ok) idx = await r.json();
    } catch {}
    const rows = [];
    function push(type, file) { rows.push([type, file]); }
    (idx?.outbox || []).forEach((f) => push("cover",   `outbox/${f}`));
    (idx?.resumes || []).forEach((f) => push("resume", `resumes/${f}`));
    (idx?.changes || []).forEach((f) => push("changes",`changes/${f}`));

    if (rows.length === 0) { draftTbl.classList.add("hidden"); noDrafts.classList.remove("hidden"); return; }

    for (const [type, rel] of rows) {
      const key2 = `${u.id}/${rel}`;
      const { data: s2 } = await supabase.storage.from("outputs").createSignedUrl(key2, 60);
      const tr = document.createElement("tr");
      const tdT = document.createElement("td"); tdT.textContent = type; tr.appendChild(tdT);
      const tdF = document.createElement("td");

      if (type === "changes") {
        const viewBtn = document.createElement("button");
        viewBtn.textContent = `View ${rel.split("/").slice(-1)[0]}`;
        viewBtn.className = "btn";
        viewBtn.style.marginRight = "8px";
        viewBtn.onclick = async (e) => {
          e.preventDefault();
          try {
            const r = await fetch(s2?.signedUrl, { cache: "no-cache" });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const j = await r.json();
            renderChangesViewer(j, s2?.signedUrl, rel.split("/").slice(-1)[0]);
          } catch (err) {
            alert("Failed to load changes JSON: " + String(err));
          }
        };
        tdF.appendChild(viewBtn);

        const a = document.createElement("a");
        a.href = s2?.signedUrl || "#"; a.target = "_blank"; a.rel = "noopener"; a.textContent = "download";
        tdF.appendChild(a);
      } else {
        const a = document.createElement("a");
        a.href = s2?.signedUrl || "#"; a.target = "_blank"; a.rel = "noopener"; a.textContent = rel.split("/").slice(-1)[0];
        tdF.appendChild(a);
      }

      tr.appendChild(tdF);
      draftBody.appendChild(tr);
    }

    draftTbl.classList.remove("hidden");
    noDrafts.classList.add("hidden");
  }

  let pollTimer = null;
  function pollDrafts() { if (pollTimer) clearInterval(pollTimer); pollTimer = setInterval(loadDrafts, 5000); }

  genBtn.onclick = generateDrafts;
  await loadDrafts();

  // ----- logout -----
  logout.onclick = async () => { await supabase.auth.signOut(); location.reload(); };
})();
