// docs/profile.js — shortlist + drafting. Full, drop-in file.
(async function () {
  // Wait for DOM
  await new Promise((r) => window.addEventListener("load", r));

  // -------- Supabase client (same project)
  const supabase = window.supabase.createClient(
    "https://imozfqawxpsasjdmgdkh.supabase.co",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imltb3pmcWF3eHBzYXNqZG1nZGtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg1Njk3NTUsImV4cCI6MjA3NDE0NTc1NX0.fkGObZvEy-oUfLrPcwgTSJbc-n6O5aE31SGIBeXImtc"
  );

  // -------- DOM refs
  const el = (id) => document.getElementById(id);
  const signinOnly = el("signinOnly");
  const profBox    = el("profile");
  const onboard    = el("onboard");
  const shortlist  = el("shortlist");
  const jobsTable  = el("jobs");
  const jobsBody   = jobsTable.querySelector("tbody");

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

  // run controls
  const runBtn     = el("runTailor");
  const runMsg     = el("runMsg");
  const refresh    = el("refresh");

  // drafts controls
  const runDrafts  = el("runDrafts");
  const draftMsg   = el("draftMsg");
  const draftsBox  = el("drafts");
  const noDrafts   = el("noDrafts");
  const draftLists = el("draftLists");
  const coversList = el("coversList");
  const resumesList= el("resumesList");
  const changesList= el("changesList");
  const refreshDrafts = el("refreshDrafts");

  // helpers
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

  // ---------- load and render profile ----------
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

    // prefill controls
    el("desiredTitles").value  = (prof?.target_titles || []).join(", ");
    el("desiredLocs").value    = (prof?.locations || []).join(", ");
    el("recencyDays").value    = String(pol?.recency_days ?? 0);
    el("remoteOnly").checked   = !!pol?.remote_only;
    el("requirePosted").checked= !!pol?.require_posted_date;
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

    // Save targets to profile (RLS policy should allow owner updates; common policy uses auth.uid()).
    // (See GitHub REST "workflow_dispatch" docs for server trigger; our Edge Function calls that.) :contentReference[oaicite:2]{index=2}
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

    // Queue shortlist run (updates search_policy server-side)
    const recencyDays   = Math.max(0, parseInt(recencyInput.value || "0", 10) || 0);
    const remoteOnly    = !!remoteOnlyCb.checked;
    const requirePosted = !!requirePostCb.checked;

    try {
      const session = await getSession();
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

  // ---------- run drafting (covers + resumes) ----------
  runDrafts.onclick = async () => {
    const session = await getSession(); if (!session) return alert("Sign in first.");
    draftMsg.textContent = "Queuing drafts…";
    try {
      const restBase = "https://imozfqawxpsasjdmgdkh.supabase.co";
      const resp = await fetch(`${restBase}/functions/v1/request-drafts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imltb3pmcWF3eHBzYXNqZG1nZGtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg1Njk3NTUsImV4cCI6MjA3NDE0NTc1NX0.fkGObZvEy-oUfLrPcwgTSJbc-n6O5aE31SGIBeXImtc",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ note: "user drafts from profile" })
      });
      let out = {}; try { out = await resp.json(); } catch {}
      if (!resp.ok) { draftMsg.textContent = `Error: ${out.detail || out.error || resp.status}`; return; }

      draftMsg.textContent = `Queued: ${out.request_id || "ok"}`;
      setTimeout(loadDrafts, 4000);
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

  // ---------- drafts loader ----------
  async function loadDrafts() {
    const u = await getUser(); if (!u) return;
    draftsBox.classList.remove("hidden");

    const key = `${u.id}/drafts_index.json`;
    const { data, error } = await supabase.storage.from("outputs").createSignedUrl(key, 60);
    if (error || !data?.signedUrl) {
      draftLists.classList.add("hidden");
      noDrafts.classList.remove("hidden");
      return;
    }

    let idx = null;
    try {
      const res = await fetch(data.signedUrl, { cache: "no-cache" });
      if (res.ok) idx = await res.json();
    } catch {}

    if (!idx || typeof idx !== "object") {
      draftLists.classList.add("hidden");
      noDrafts.classList.remove("hidden");
      return;
    }

    const mk = (ul, arr, contentType) => {
      ul.innerHTML = "";
      if (!Array.isArray(arr) || !arr.length) return;
      for (const name of arr) {
        const li = document.createElement("li");
        const key = `${u.id}/${contentType}/${name}`;
        li.innerHTML = `<a href="#" data-key="${key}">${name}</a>`;
        ul.appendChild(li);
      }
      // wire signed links on demand
      ul.querySelectorAll("a[data-key]").forEach(a => {
        a.addEventListener("click", async (ev) => {
          ev.preventDefault();
          const key = a.getAttribute("data-key");
          const { data, error } = await supabase.storage.from("outputs").createSignedUrl(key, 60);
          if (error || !data?.signedUrl) return alert("Could not get link.");
          window.open(data.signedUrl, "_blank", "noopener");
        });
      });
    };

    mk(coversList, idx.outbox || [], "outbox");
    mk(resumesList, idx.resumes || [], "resumes");
    mk(changesList, idx.changes || [], "changes");

    noDrafts.classList.add("hidden");
    draftLists.classList.remove("hidden");
  }

  refresh.onclick = loadShortlist;
  refreshDrafts.onclick = loadDrafts;

  await loadShortlist();
  await loadDrafts();

  // ---------- logout ----------
  logout.onclick = async () => { await supabase.auth.signOut(); location.reload(); };
})();
