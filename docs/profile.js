// docs/profile.js — auth + profile + shortlist + drafting + JD-aware preview cards only
// Uses supabase.functions.invoke(...) for request-run / request-draft (cleaner & fully auth'ed).

(async function () {
  // Wait for DOM
  await new Promise((r) => window.addEventListener("load", r));

  // ---------- Supabase bootstrap ----------
  const SUPABASE_URL = window.SUPABASE_URL || "https://imozfqawxpsasjdmgdkh.supabase.co";
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
  const cardsEl = $("cards");

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

  // changes modal
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
  const getSession = () => supabase.auth.getSession().then((r) => r.data.session || null);

  const pills = (arr) =>
    Array.isArray(arr) && arr.length
      ? arr.map((x) => `<span class="pill">${String(x)}</span>`).join(" ")
      : "—";

  const esc = (s) =>
    String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const truncate = (s, n) => (s && s.length > n ? s.slice(0, n) + "…" : s || "");

  const sign = async (bucket, key, expires = 60) => {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(key, expires);
    return error ? null : data?.signedUrl || null;
  };

  async function fetchJSON(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`${url} ${r.status}`);
    return r.json();
  }
  async function fetchText(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return "";
    return r.text();
  }

  // ---------- auth gate ----------
  const user = await getUser();
  if (!user) {
    signinOnly.classList.remove("hidden");
    return;
  }
  who.textContent = `Signed in as ${user.email || user.id}`;
  profBox.classList.remove("hidden");
  onboard.classList.remove("hidden");

  // NEW: Hide the sign-in notice and reveal the JobScan card (Match Report)
  if (signinOnly) signinOnly.classList.add("hidden");
  document.getElementById("matchCard")?.classList.remove("hidden");

  // ---------- load profile ----------
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
    const { error: upErr } = await supabase.storage.from("resumes").upload(path, file, { upsert: true });
    if (upErr) {
      upMsg.textContent = "Upload error: " + upErr.message;
      return;
    }

    const { error: metaErr } = await supabase.from("resumes").insert({ user_id: user.id, bucket: "resumes", path });
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
      const titles = (titlesInput.value || "").split(",").map((s) => s.trim()).filter(Boolean);
      const locs = (locsInput.value || "").split(",").map((s) => s.trim()).filter(Boolean);
      const { error } = await supabase.from("profiles").update({ target_titles: titles, locations: locs }).eq("id", user.id);
      if (error) throw error;
    } catch (e) {
      runMsg.textContent = "Save failed: " + String(e.message || e);
      return;
    }

    // Queue shortlist job (Edge Function)
    try {
      const recencyDays = Math.max(0, parseInt(recencyInput.value || "0", 10) || 0);
      const remoteOnly = !!remoteOnlyCb.checked;
      const requirePosted = !!requirePostCb.checked;

      const { data, error } = await supabase.functions.invoke("request-run", {
        body: {
          note: "user run from profile",
          search_policy: {
            recency_days: recencyDays,
            require_posted_date: requirePosted,
            remote_only: remoteOnly,
          },
        },
      }); // supabase-js attaches the Authorization header automatically.
      if (error) {
        runMsg.textContent = `Error: ${error.message || "invoke failed"}`;
        return;
      }
      runMsg.textContent = `Queued: ${data?.request_id || "ok"}`;
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
      const { data, error } = await supabase.functions.invoke("request-draft", {
        body: { top },
      });
      if (error) {
        draftMsg.textContent = `Error: ${error.message || "invoke failed"}`;
        return;
      }
      draftMsg.textContent = `Drafts queued: ${data?.request_id || "ok"} (top=${data?.top || top})`;
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
  function renderChangeCard(it) {
    const before = String(it.original_paragraph_text || "");
    const after = String(it.modified_paragraph_text || "");
    const added = String(it.inserted_sentence || "");
    const sec = String(it.anchor_section || "");
    const anchor = String(it.anchor || "");
    const reason = String(it.reason || "");

    const afterHTML = esc(after).replace(
      esc(added),
      `<span class="change-insert">${esc(added)}</span>`
    );

    return `
      <div class="change-card">
        <div class="change-title">
          <span class="pill">${esc(sec)}</span>
          ${anchor ? `<span class="pill" style="margin-left:6px">${esc(anchor)}</span>` : ""}
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

      const changes = Array.isArray(obj) ? obj : Array.isArray(obj?.changes) ? obj.changes : [];

      changeBody.innerHTML = changes.length
        ? changes.map(renderChangeCard).join("")
        : `<div class="muted">No granular changes recorded for this document.</div>`;
    } catch (e) {
      changeBody.innerHTML = `<div class="muted">Error loading diff: ${String(e)}</div>`;
    }
    changeModal.classList.add("open");
  }

  // ---------- materials loader (cards only) ----------
  async function loadMaterials() {
    const u = await getUser();
    if (!u) return;

    const ixKey = `${u.id}/drafts_index.json`;
    const ixUrl = await sign("outputs", ixKey, 60);

    if (!ixUrl) {
      materials.classList.remove("hidden");
      cardsEl.innerHTML = `<div class="muted">No drafts yet.</div>`;
      return;
    }

    let index = { changes: [] };
    try {
      const res = await fetch(ixUrl, { cache: "no-cache" });
      if (res.ok) index = await res.json();
    } catch {}

    const clean = (arr) => (Array.isArray(arr) ? arr.filter(Boolean) : []);
    const changes = clean(index.changes);

    cardsEl.innerHTML = "<div class='muted'>Loading previews…</div>";
    const cards = [];

    for (const fname of changes) {
      try {
        const slug = fname.replace(/\.json$/, "");

        const changeUrl = await sign("outputs", `${u.id}/changes/${fname}`, 60);
        if (!changeUrl) continue;

        const change = await fetchJSON(changeUrl);

        const company = change.company || "(company)";
        const title = change.title || "(title)";

        const coverRel = change.paths?.cover_md || `outbox/${slug}.md`;
        const resumeRel = change.paths?.resume_docx || null;
        const jdTextRel = change.paths?.jd_text || `changes/${slug}.jd.txt`;

        const coverUrl = await sign("outputs", `${u.id}/${coverRel}`, 60);
        const resumeUrl = resumeRel ? await sign("outputs", `${u.id}/${resumeRel}`, 60) : null;
        const jdUrl = await sign("outputs", `${u.id}/${jdTextRel}`, 60);

        const [coverMd, jdTxt] = await Promise.all([coverUrl ? fetchText(coverUrl) : "", jdUrl ? fetchText(jdUrl) : ""]);

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
          a.className = "btn";
          a.href = resumeUrl;
          a.target = "_blank";
          a.rel = "noopener";
          a.textContent = "Resume (.docx)";
          head.appendChild(a);
        }

        const viewChanges = document.createElement("button");
        viewChanges.className = "btn";
        viewChanges.textContent = "View Change Log";
        viewChanges.onclick = () => openChangeModal(changeUrl);
        head.appendChild(viewChanges);

        card.appendChild(head);

        const grid = document.createElement("div");
        grid.className = "grid2";

        const left = document.createElement("div");
        left.className = "pane";
        left.innerHTML = `<h3>JD excerpt</h3><div class="muted small">pulled from the posting</div><div class="jd">${esc(jdTxt || "")}</div>`;

        const right = document.createElement("div");
        right.className = "pane";
        right.innerHTML = `<h3>Company themes</h3>`;
        if (themes.length) {
          const ul = document.createElement("ul");
          ul.className = "bullets";
          themes.forEach((t) => {
            const li = document.createElement("li");
            li.textContent = t;
            ul.appendChild(li);
          });
          right.appendChild(ul);
        } else {
          const none = document.createElement("div");
          none.className = "muted";
          none.textContent = "No themes detected.";
          right.appendChild(none);
        }

        grid.appendChild(left);
        grid.appendChild(right);
        card.appendChild(grid);

        const details = document.createElement("details");
        details.className = "cover";
        const summary = document.createElement("summary");
        summary.textContent = "Cover letter preview";
        details.appendChild(summary);

        const pre = document.createElement("pre");
        pre.className = "mono";
        pre.textContent = coverMd || "(cover not found)";
        details.appendChild(pre);

        if (coverUrl) {
          const open = document.createElement("a");
          open.className = "btn";
          open.href = coverUrl;
          open.target = "_blank";
          open.rel = "noopener";
          open.textContent = "Open cover";
          details.appendChild(document.createTextNode(" "));
          details.appendChild(open);
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
