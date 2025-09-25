// docs/profile.js — shortlist + drafting + render generated files from Storage + diff modal
(async function () {
  await new Promise((r) => window.addEventListener("load", r));

  // Supabase client (project constants)
  const supabase = window.supabase.createClient(
    "https://imozfqawxpsasjdmgdkh.supabase.co",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imltb3pmcWF3eHBzYXNqZG1nZGtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg1Njk3NTUsImV4cCI6MjA3NDE0NTc1NX0.fkGObZvEy-oUfLrPcwgTSJbc-n6O5aE31SGIBeXImtc"
  );

  // DOM helpers
  const el = (id) => document.getElementById(id);
  const signinOnly = el("signinOnly");
  const profBox    = el("profile");
  const onboard    = el("onboard");
  const shortlist  = el("shortlist");
  const jobsTable  = el("jobs");
  const jobsBody   = jobsTable.querySelector("tbody");
  const materials  = el("materials");
  const coversBox  = el("covers");
  const resumesBox = el("resumes");
  const changesBox = el("changes");

  const who     = el("who");
  const logout  = el("logout");

  // upload controls
  const resumeInput = el("resume");
  const uploadBtn   = el("uploadResume");
  const upMsg       = el("upMsg");

  // targets controls
  const titlesInput   = el("desiredTitles");
  const locsInput     = el("desiredLocs");
  const recencyInput  = el("recencyDays");
  const remoteOnlyCb  = el("remoteOnly");
  const requirePostCb = el("requirePosted");

  // run shortlist
  const runBtn   = el("runTailor");
  const runMsg   = el("runMsg");
  const refresh  = el("refresh");

  // drafting
  const runDrafts = el("runDrafts");
  const draftMsg  = el("draftMsg");
  const topNInput = el("topN");

  // diff modal
  const diffModal = el("diffModal");
  const diffBody = el("diffBody");
  const diffClose = el("diffClose");
  diffClose.onclick = () => diffModal.classList.remove("open");
  diffModal.addEventListener("click", (e) => { if (e.target === diffModal) diffModal.classList.remove("open"); });

  const getUser    = () => supabase.auth.getUser().then(r => r.data.user || null);
  const getSession = () => supabase.auth.getSession().then(r => r.data.session || null);

  const pills = (arr) => Array.isArray(arr) && arr.length
    ? arr.map((x) => `<span class="pill">${String(x)}</span>`).join(" ")
    : "—";

  // ---------- auth gate ----------
  const user = await getUser();
  if (!user) { signinOnly.classList.remove("hidden"); return; }

  who.textContent = `Signed in as ${user.email || user.id}`;
  profBox.classList.remove("hidden");
  onboard.classList.remove("hidden");

  // ---------- load & render profile ----------
  const { data: prof, error: profErr } =
    await supabase.from("profiles").select("*").eq("id", user.id).single();

  if (!profErr && prof) {
    el("full_name").textContent = prof?.full_name || "—";
    el("email").textContent     = prof?.email || "—";
    el("phone").textContent     = prof?.phone || "—";
    el("skills").innerHTML      = pills(prof?.skills || []);
    el("titles").innerHTML      = pills(prof?.target_titles || []);
    el("locs").innerHTML        = pills(prof?.locations || []);

    const pol = prof?.search_policy || {};
    el("policy").textContent = [
      `recency_days=${pol.recency_days ?? 0}`,
      `require_posted_date=${!!pol.require_posted_date}`,
      `remote_only=${!!pol.remote_only}`,
    ].join(", ");
    el("updated").textContent = (prof?.updated_at || prof?.created_at || "—").toString();

    // fill form fields
    el("desiredTitles").value  = (prof?.target_titles || []).join(", ");
    el("desiredLocs").value    = (prof?.locations || []).join(", ");
    el("recencyDays").value = String(pol?.recency_days ?? 0);
    el("remoteOnly").checked  = !!pol?.remote_only;
    el("requirePosted").checked = !!pol?.require_posted_date;
  } else {
    el("full_name").textContent = `Error: ${profErr?.message || "profile not found"}`;
  }

  // ---------- upload resume ----------
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

  // ---------- run crawl & rank ----------
  runBtn.onclick = async () => {
    const session = await getSession(); if (!session) return alert("Sign in first.");
    runMsg.textContent = "Saving & queuing…";

    // Save targets
    let patchErr = null;
    try {
      const titles = (titlesInput.value || "").split(",").map(s => s.trim()).filter(Boolean);
      const locs   = (locsInput.value || "").split(",").map(s => s.trim()).filter(Boolean);
      const { error } = await supabase
        .from("profiles")
        .update({ target_titles: titles, locations: locs })
        .eq("id", (await getUser()).id);
      if (error) patchErr = error;
    } catch (e) { patchErr = e; }
    if (patchErr) { runMsg.textContent = "Save failed: " + String(patchErr.message || patchErr); return; }

    // Queue shortlist (Edge: /functions/v1/request-run)
    const recencyDays   = Math.max(0, parseInt(recencyInput.value || "0", 10) || 0);
    const remoteOnly    = !!remoteOnlyCb.checked;
    const requirePosted = !!requirePostCb.checked;

    try {
      const restBase = "https://imozfqawxpsasjdmgdkh.supabase.co";
      const session = await getSession();
      const resp = await fetch(`${restBase}/functions/v1/request-run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imltb3pmcWF3eHBzYXNqZG1nZGtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg1Njk3NTUsImV4cCI6MjA3NDE0NTc1NX0.fkGObZvEy-oUfLrPcwgTSJbc-n6O5aE31SGIBeXImtc",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          note: "user run from profile",
          search_policy: {
            recency_days: recencyDays,
            require_posted_date: requirePosted,
            remote_only: remoteOnly
          }
        }),
      });

      let out = {}; try { out = await resp.json(); } catch {}
      if (!resp.ok) { runMsg.textContent = `Error: ${out.detail || out.error || resp.status}`; return; }

      runMsg.textContent = `Queued: ${out.request_id || "ok"}`;
      setTimeout(loadShortlist, 3000);
    } catch (e) {
      runMsg.textContent = "Error: " + String(e);
    }
  };

  // ---------- queue drafting (Edge: /functions/v1/request-draft) ----------
  runDrafts.onclick = async () => {
    const session = await getSession(); if (!session) return alert("Sign in first.");
    draftMsg.textContent = "Queuing drafting…";

    const top = Math.max(1, Math.min(20, parseInt(topNInput.value || "5", 10) || 5));
    try {
      const restBase = "https://imozfqawxpsasjdmgdkh.supabase.co";
      const resp = await fetch(`${restBase}/functions/v1/request-draft`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imltb3pmcWF3eHBzYXNqZG1nZGtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg1Njk3NTUsImV4cCI6MjA3NDE0NTc1NX0.fkGObZvEy-oUfLrPcwgTSJbc-n6O5aE31SGIBeXImtc",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ top })
      });

      let out = {}; try { out = await resp.json(); } catch {}
      if (!resp.ok) { draftMsg.textContent = `Error: ${out.detail || out.error || resp.status}`; return; }

      draftMsg.textContent = `Drafts queued: ${out.request_id || "ok"} (top=${out.top || top})`;
      setTimeout(loadMaterials, 3000);
    } catch (e) {
      draftMsg.textContent = "Error: " + String(e);
    }
  };

  // ---------- shortlist loader ----------
  async function loadShortlist() {
    const u = await getUser(); if (!u) return;
    const key = `${u.id}/scores.json`;
    const { data, error } = await supabase.storage.from("outputs").createSignedUrl(key, 60);
    if (error || !data?.signedUrl) {
      shortlist.classList.remove("hidden");
      jobsTable.classList.add("hidden");
      el("noData").classList.remove("hidden");
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
      el("noData").classList.remove("hidden");
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
    el("noData").classList.add("hidden");
  }

  // ---------- diff modal ----------
  function renderDiffItem(it) {
    const before = String(it.original_paragraph_text || "");
    const after = String(it.modified_paragraph_text || "");
    const added = String(it.inserted_sentence || "");
    const sec = String(it.anchor_section || "");
    const anchor = String(it.anchor || "");
    const reason = String(it.reason || "");

    return `
      <div style="margin-bottom:14px">
        <div style="margin-bottom:6px">
          <span class="tag">${sec}</span>
          ${anchor ? `<span class="tag" style="margin-left:6px">${anchor}</span>` : ""}
        </div>
        <div class="diff">
          <div>
            <div class="muted" style="margin-bottom:4px">Before</div>
            <div class="mono">${before.replace(/</g,"&lt;")}</div>
          </div>
          <div>
            <div class="muted" style="margin-bottom:4px">After</div>
            <div class="mono">${after.replace(/</g,"&lt;").replace(added, `<span class="ins">${added}</span>`)}</div>
          </div>
        </div>
        <div class="muted" style="margin-top:6px">${reason}</div>
      </div>
    `;
  }

  async function openDiffModal(jsonUrl) {
    try {
      const res = await fetch(jsonUrl, { cache: "no-cache" });
      if (!res.ok) throw new Error("Failed to fetch change log");
      const obj = await res.json();
      let html = "";
      const changes = Array.isArray(obj?.changes) ? obj.changes : [];
      if (!changes.length) {
        html = `<div class="muted">No granular changes recorded for this document.</div>`;
      } else {
        html = changes.map(renderDiffItem).join("");
      }
      diffBody.innerHTML = html;
      diffModal.classList.add("open");
    } catch (e) {
      diffBody.innerHTML = `<div class="muted">Error loading diff: ${String(e)}</div>`;
      diffModal.classList.add("open");
    }
  }

  // ---------- generated-materials loader ----------
  async function loadMaterials() {
    const u = await getUser(); if (!u) return;
    const key = `${u.id}/drafts_index.json`;

    // 1) fetch the index via a short-lived signed URL
    const ixUrlRes = await supabase.storage.from("outputs").createSignedUrl(key, 60);
    if (ixUrlRes.error || !ixUrlRes.data?.signedUrl) {
      materials.classList.remove("hidden");
      coversBox.innerHTML = "<div class='muted'>No generated files yet.</div>";
      resumesBox.innerHTML = "";
      changesBox.innerHTML = "";
      return;
    }

    let index = { outbox:[], resumes:[], changes:[] };
    try {
      const res = await fetch(ixUrlRes.data.signedUrl, { cache: "no-cache" });
      if (res.ok) index = await res.json();
    } catch {}

    // helper: render a file grid from a list of basenames under a prefix
    async function renderFiles(prefix, names, box, options={}) {
      box.innerHTML = "";
      if (!Array.isArray(names) || names.length === 0) {
        box.innerHTML = "<div class='muted'>None</div>";
        return;
      }
      for (const name of names) {
        const p = `${u.id}/${prefix}/${name}`;
        const { data, error } = await supabase.storage.from("outputs").createSignedUrl(p, 60);
        const url = !error && data?.signedUrl ? data.signedUrl : "#";
        const div = document.createElement("div");
        div.className = "file";
        if (options.kind === "changes") {
          // JSON: download + a "View" button that opens the diff modal
          div.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
              <a href="${url}" target="_blank" rel="noopener">${name}</a>
              <button class="btn" data-url="${url}">View</button>
            </div>`;
          const btn = div.querySelector("button");
          btn.onclick = () => openDiffModal(url);
        } else {
          div.innerHTML = `<a href="${url}" target="_blank" rel="noopener">${name}</a>`;
        }
        box.appendChild(div);
      }
    }

    await renderFiles("outbox",  index.outbox,  coversBox);
    await renderFiles("resumes", index.resumes, resumesBox);
    await renderFiles("changes", index.changes, changesBox, { kind: "changes" });

    materials.classList.remove("hidden");
  }

  refresh.onclick = async () => { await loadShortlist(); await loadMaterials(); };

  // initial load
  await loadShortlist();
  await loadMaterials();

  // logout
  logout.onclick = async () => { await supabase.auth.signOut(); location.reload(); };
})();
