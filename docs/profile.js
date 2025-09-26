// docs/profile.js — auth + profile + shortlist + drafting + per-file signing + robust change-log modal
(async function () {
  // Wait for DOM
  await new Promise((r) => window.addEventListener("load", r));

  // ---------- Supabase bootstrap (works with or without a preloaded UMD client) ----------
  const SUPABASE_URL =
    window.SUPABASE_URL || "https://imozfqawxpsasjdmgdkh.supabase.co";
  const SUPABASE_ANON_KEY =
    window.SUPABASE_ANON_KEY ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imltb3pmcWF3eHBzYXNqZG1nZGtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg1Njk3NTUsImV4cCI6MjA3NDE0NTc1NX0.fkGObZvEy-oUfLrPcwgTSJbc-n6O5aE31SGIBeXImtc";

  async function ensureSupabase() {
    if (window.supabase?.createClient) return window.supabase;
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.js";
      s.defer = true;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return window.supabase;
  }

  const sbLib = await ensureSupabase();
  const supabase = sbLib.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const signinOnly = $("signinOnly");
  const profBox = $("profile");
  const onboard = $("onboard");
  const shortlist = $("shortlist");
  const jobsTable = $("jobs");
  const jobsBody = jobsTable.querySelector("tbody");
  const materials = $("materials");

  // file lists (ULs in the new HTML)
  const outboxList = $("outbox-list");
  const resumesList = $("resumes-list");
  const changesList = $("changes-list");

  // header / auth
  const who = $("who");
  const logout = $("logout");

  // upload controls
  const resumeInput = $("resume");
  const uploadBtn = $("uploadResume");
  const upMsg = $("upMsg");

  // targets
  const titlesInput = $("desiredTitles");
  const locsInput = $("desiredLocs");
  const recencyInput = $("recencyDays");
  const remoteOnlyCb = $("remoteOnly");
  const requirePostCb = $("requirePosted");

  // runs
  const runBtn = $("runTailor");
  const runMsg = $("runMsg");
  const refresh = $("refresh");

  // drafts
  const runDrafts = $("runDrafts");
  const draftMsg = $("draftMsg");
  const topNInput = $("topN");

  // changes modal (new structure)
  const changeModal = $("change-modal");
  const changeBody = changeModal?.querySelector(".modal-body");
  const changeClose = changeModal?.querySelector(".close");
  if (changeClose) changeClose.onclick = () => changeModal.classList.remove("open");
  if (changeModal)
    changeModal.addEventListener("click", (e) => {
      if (e.target === changeModal) changeModal.classList.remove("open");
    });

  // ---------- helpers ----------
  const getUser = () => supabase.auth.getUser().then((r) => r.data.user || null);
  const getSession = () =>
    supabase.auth.getSession().then((r) => r.data.session || null);

  const pills = (arr) =>
    Array.isArray(arr) && arr.length
      ? arr.map((x) => `<span class="pill">${String(x)}</span>`).join(" ")
      : "—";

  const sign = async (bucket, key, expires = 60) => {
    const { data, error } = await supabase.storage
      .from(bucket)
      .createSignedUrl(key, expires);
    return error ? null : data?.signedUrl || null;
  };

  // ---------- auth gate ----------
  const user = await getUser();
  if (!user) {
    signinOnly.classList.remove("hidden");
    return;
  }
  who.textContent = `Signed in as ${user.email || user.id}`;
  profBox.classList.remove("hidden");
  onboard.classList.remove("hidden");

  // ---------- load profile ----------
  const { data: prof, error: profErr } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

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

    // fill form
    titlesInput.value = (prof?.target_titles || []).join(", ");
    locsInput.value = (prof?.locations || []).join(", ");
    recencyInput.value = String(pol?.recency_days ?? 0);
    remoteOnlyCb.checked = !!pol?.remote_only;
    requirePostCb.checked = !!pol?.require_posted_date;
  } else {
    $("full_name").textContent = `Error: ${profErr?.message || "profile not found"}`;
  }

  // ---------- upload resume ----------
  uploadBtn.onclick = async () => {
    const session = await getSession();
    if (!session) return alert("Sign in first.");
    const file = resumeInput.files?.[0];
    if (!file) return alert("Choose a .docx file");

    const path = `${user.id}/current.docx`;
    const { error: upErr } = await supabase.storage
      .from("resumes")
      .upload(path, file, { upsert: true });
    if (upErr) {
      upMsg.textContent = "Upload error: " + upErr.message;
      return;
    }

    const { error: metaErr } = await supabase
      .from("resumes")
      .insert({ user_id: user.id, bucket: "resumes", path });
    if (metaErr) {
      upMsg.textContent = "Upload metadata error: " + metaErr.message;
      return;
    }

    upMsg.textContent = "Uploaded.";
  };

  // ---------- run crawl & rank ----------
  runBtn.onclick = async () => {
    const session = await getSession();
    if (!session) return alert("Sign in first.");
    runMsg.textContent = "Saving & queuing…";

    // Save targets
    try {
      const titles = (titlesInput.value || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const locs = (locsInput.value || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const { error } = await supabase
        .from("profiles")
        .update({ target_titles: titles, locations: locs })
        .eq("id", user.id);
      if (error) throw error;
    } catch (e) {
      runMsg.textContent = "Save failed: " + String(e.message || e);
      return;
    }

    // Queue shortlist job
    try {
      const restBase = SUPABASE_URL;
      const recencyDays = Math.max(0, parseInt(recencyInput.value || "0", 10) || 0);
      const remoteOnly = !!remoteOnlyCb.checked;
      const requirePosted = !!requirePostCb.checked;

      const resp = await fetch(`${restBase}/functions/v1/request-run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          note: "user run from profile",
          search_policy: {
            recency_days: recencyDays,
            require_posted_date: requirePosted,
            remote_only: remoteOnly,
          },
        }),
      });

      let out = {};
      try {
        out = await resp.json();
      } catch {}
      if (!resp.ok) {
        runMsg.textContent = `Error: ${out.detail || out.error || resp.status}`;
        return;
      }
      runMsg.textContent = `Queued: ${out.request_id || "ok"}`;
      setTimeout(loadShortlist, 3000);
    } catch (e) {
      runMsg.textContent = "Error: " + String(e);
    }
  };

  // ---------- queue drafting ----------
  runDrafts.onclick = async () => {
    const session = await getSession();
    if (!session) return alert("Sign in first.");
    draftMsg.textContent = "Queuing drafting…";

    const top = Math.max(1, Math.min(20, parseInt(topNInput.value || "5", 10) || 5));
    try {
      const restBase = SUPABASE_URL;
      const resp = await fetch(`${restBase}/functions/v1/request-draft`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ top }),
      });

      let out = {};
      try {
        out = await resp.json();
      } catch {}
      if (!resp.ok) {
        draftMsg.textContent = `Error: ${out.detail || out.error || resp.status}`;
        return;
      }

      draftMsg.textContent = `Drafts queued: ${out.request_id || "ok"} (top=${
        out.top || top
      })`;
      setTimeout(loadMaterials, 3000);
    } catch (e) {
      draftMsg.textContent = "Error: " + String(e);
    }
  };

  // ---------- shortlist loader ----------
  async function loadShortlist() {
    const u = await getUser();
    if (!u) return;

    const key = `${u.id}/scores.json`;
    const url = await sign("outputs", key, 60);

    if (!url) {
      shortlist.classList.remove("hidden");
      jobsTable.classList.add("hidden");
      $("noData").classList.remove("hidden");
      return;
    }

    let arr = [];
    try {
      const res = await fetch(url, { cache: "no-cache" });
      if (res.ok) arr = await res.json();
    } catch {}

    if (!Array.isArray(arr) || arr.length === 0) {
      shortlist.classList.remove("hidden");
      jobsTable.classList.add("hidden");
      $("noData").classList.remove("hidden");
      return;
    }

    jobsBody.innerHTML = "";
    arr.sort((a, b) => (b.score || 0) - (a.score || 0));
    for (const j of arr) {
      const tr = document.createElement("tr");

      const tdScore = document.createElement("td");
      tdScore.textContent = (j.score ?? 0).toFixed(3);
      tr.appendChild(tdScore);

      const tdTitle = document.createElement("td");
      const a = document.createElement("a");
      a.href = j.url || j.link || j.jd_url || "#";
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = j.title || "(no title)";
      tdTitle.appendChild(a);
      tr.appendChild(tdTitle);

      const tdCompany = document.createElement("td");
      tdCompany.textContent = j.company || "";
      tr.appendChild(tdCompany);

      const tdLoc = document.createElement("td");
      tdLoc.textContent = (j.location || "").trim();
      tr.appendChild(tdLoc);

      const tdPosted = document.createElement("td");
      tdPosted.textContent = j.posted_at ? String(j.posted_at).slice(0, 10) : "—";
      tr.appendChild(tdPosted);

      jobsBody.appendChild(tr);
    }

    shortlist.classList.remove("hidden");
    jobsTable.classList.remove("hidden");
    $("noData").classList.add("hidden");
  }

  // ---------- change-log modal ----------
  const esc = (s) => String(s || "").replace(/</g, "&lt;");
  function renderChangeCard(it) {
    const before = String(it.original_paragraph_text || "");
    const after = String(it.modified_paragraph_text || "");
    const added = String(it.inserted_sentence || "");
    const sec = String(it.anchor_section || "");
    const anchor = String(it.anchor || "");
    const reason = String(it.reason || "");

    // Lightweight highlight of the inserted snippet if present
    const afterHTML = esc(after).replace(
      esc(added),
      `<span class="change-insert">${esc(added)}</span>`
    );

    return `
      <div class="change-card">
        <div class="change-title">
          <span class="tag">${esc(sec)}</span>
          ${anchor ? `<span class="tag" style="margin-left:6px">${esc(anchor)}</span>` : ""}
        </div>
        <div>
          <div class="muted" style="margin-bottom:4px">Before</div>
          <pre>${esc(before)}</pre>
        </div>
        <div style="margin-top:8px">
          <div class="muted" style="margin-bottom:4px">After</div>
          <pre>${afterHTML}</pre>
        </div>
        ${reason ? `<div class="change-reason">${esc(reason)}</div>` : ""}
      </div>
    `;
  }

  async function openChangeModal(jsonUrl) {
    if (!changeModal || !changeBody) return;
    try {
      const res = await fetch(jsonUrl, { cache: "no-cache" });
      if (!res.ok) throw new Error(`Fetch ${res.status}`);
      const obj = await res.json();

      // Accept either a top-level array OR { changes: [...] }
      const changes = Array.isArray(obj)
        ? obj
        : Array.isArray(obj?.changes)
        ? obj.changes
        : [];

      changeBody.innerHTML = changes.length
        ? changes.map(renderChangeCard).join("")
        : `<div class="muted">No granular changes recorded for this document.</div>`;
    } catch (e) {
      changeBody.innerHTML = `<div class="muted">Error loading diff: ${String(
        e
      )}</div>`;
    }
    changeModal.classList.add("open");
  }

  // ---------- generated-materials loader (per-file signing, never folders) ----------
  async function loadMaterials() {
    const u = await getUser();
    if (!u) return;

    const ixKey = `${u.id}/drafts_index.json`;
    const ixUrl = await sign("outputs", ixKey, 60);

    if (!ixUrl) {
      materials.classList.remove("hidden");
      outboxList.innerHTML = `<li class="muted">No generated files yet.</li>`;
      resumesList.innerHTML = "";
      changesList.innerHTML = "";
      return;
    }

    let index = { outbox: [], resumes: [], changes: [] };
    try {
      const res = await fetch(ixUrl, { cache: "no-cache" });
      if (res.ok) index = await res.json();
    } catch {}

    // Normalize/clean names (index may contain an empty string for outbox)
    const clean = (arr) => (Array.isArray(arr) ? arr.filter(Boolean) : []);

    const outbox = clean(index.outbox);
    const resumes = clean(index.resumes);
    const changes = clean(index.changes);

    // Render helpers
    async function renderList(ul, names, prefix, opts = {}) {
      ul.innerHTML = "";
      if (!names.length) {
        ul.innerHTML = `<li class="muted">None</li>`;
        return;
      }
      for (const name of names) {
        const storageKey = `${u.id}/${prefix}/${name}`;
        const url = await sign("outputs", storageKey, 60);
        const li = document.createElement("li");
        if (opts.kind === "changes") {
          li.innerHTML = `
            <a href="${url}" target="_blank" rel="noopener">${name}</a>
            <button class="btn" type="button">View</button>`;
          const btn = li.querySelector("button");
          btn.onclick = () => openChangeModal(url);
        } else {
          li.innerHTML = `<a href="${url}" target="_blank" rel="noopener">${name}</a>`;
        }
        ul.appendChild(li);
      }
    }

    await renderList(outboxList, outbox, "outbox");
    await renderList(resumesList, resumes, "resumes");
    await renderList(changesList, changes, "changes", { kind: "changes" });

    materials.classList.remove("hidden");
  }

  // ---------- refresh, initial load, logout ----------
  refresh.onclick = async () => {
    await loadShortlist();
    await loadMaterials();
  };

  await loadShortlist();
  await loadMaterials();

  logout.onclick = async () => {
    await supabase.auth.signOut();
    location.reload();
  };
})();
