// docs/profile.js
(async function () {
  await new Promise((r) => window.addEventListener("load", r));

  const supabase = window.supabase.createClient(
    "https://imozfqawxpsasjdmgdkh.supabase.co",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imltb3pmcWF3eHBzYXNqZG1nZGtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg1Njk3NTUsImV4cCI6MjA3NDE0NTc1NX0.fkGObZvEy-oUfLrPcwgTSJbc-n6O5aE31SGIBeXImtc"
  );

  // UI refs
  const who = document.getElementById("who");
  const signinOnly = document.getElementById("signinOnly");
  const profBox = document.getElementById("profile");

  const matBox = document.getElementById("materials");
  const genBtn = document.getElementById("genBtn");
  const genMsg = document.getElementById("genMsg");
  const topN = document.getElementById("topN");

  const draftTable = document.getElementById("draftTable");
  const draftBody = draftTable.querySelector("tbody");
  const noDrafts = document.getElementById("noDrafts");

  // -------- small helpers --------
  function pills(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return "—";
    return arr.map((x) => `<span class="pill">${String(x)}</span>`).join(" ");
  }

  function fmtDate(x) {
    try {
      return new Date(x).toISOString();
    } catch {
      return String(x || "—");
    }
  }

  // Modal (lazy create once)
  let modal, modalContent, modalTabs;
  function ensureModal() {
    if (modal) return;
    modal = document.createElement("dialog");
    modal.style.maxWidth = "900px";
    modal.style.width = "90%";
    modal.style.borderRadius = "12px";
    modal.style.padding = "0";
    modal.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #eee;">
        <strong id="chgTitle">Changes</strong>
        <button id="chgClose" class="btn" style="min-width:64px">Close</button>
      </div>
      <div style="padding:12px 16px">
        <div id="chgTabs" style="display:flex;gap:8px;margin:0 0 10px 0">
          <button data-tab="summary" class="btn" aria-pressed="true">Summary</button>
          <button data-tab="raw" class="btn" aria-pressed="false">Raw JSON</button>
        </div>
        <div id="chgContent"></div>
      </div>
    `;
    document.body.appendChild(modal);
    modalContent = modal.querySelector("#chgContent");
    modalTabs = modal.querySelector("#chgTabs");
    modal.querySelector("#chgClose").onclick = () => modal.close();
    modal.addEventListener("close", () => {
      // clear to free memory if someone opens many
      modalContent.textContent = "";
    });
    // tab handling
    modalTabs.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-tab]");
      if (!b) return;
      const chosen = b.getAttribute("data-tab");
      [...modalTabs.querySelectorAll("button")].forEach((btn) =>
        btn.setAttribute("aria-pressed", String(btn === b))
      );
      [...modalContent.children].forEach((sec) => {
        sec.style.display = sec.dataset.tab === chosen ? "block" : "none";
      });
    });
  }

  async function showChangesViewer(signedUrl, fileLabel) {
    ensureModal();
    const title = modal.querySelector("#chgTitle");
    title.textContent = `Changes — ${fileLabel || ""}`;

    // fetch JSON
    let data = null;
    try {
      const r = await fetch(signedUrl, { cache: "no-cache" });
      if (r.ok) data = await r.json();
    } catch {}

    // Build two tabs
    modalContent.textContent = "";
    const summary = document.createElement("div");
    summary.dataset.tab = "summary";

    const raw = document.createElement("pre");
    raw.dataset.tab = "raw";
    raw.style.whiteSpace = "pre-wrap";
    raw.style.wordBreak = "break-word";
    raw.style.fontSize = "12px";
    raw.textContent = data ? JSON.stringify(data, null, 2) : "(no data)";

    // ----- Summary renderer -----
    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <div style="margin-bottom:10px">
        <div class="muted" style="margin:2px 0">Company</div>
        <div><strong>${(data && (data.company || "—")) || "—"}</strong></div>
      </div>
      <div style="margin-bottom:10px">
        <div class="muted" style="margin:2px 0">Title</div>
        <div>${(data && (data.title || "—")) || "—"}</div>
      </div>
      <div style="margin-bottom:10px">
        <div class="muted" style="margin:2px 0">ATS keywords</div>
        <div>${Array.isArray(data?.ats_keywords) && data.ats_keywords.length
          ? data.ats_keywords.map((k) => `<span class="pill">${k}</span>`).join(" ")
          : "—"
        }</div>
      </div>
      <div style="margin-bottom:10px">
        <div class="muted" style="margin:2px 0">JD hash</div>
        <div><code>${(data && (data.jd_hash || "—")) || "—"}</code></div>
      </div>
      <div style="margin-top:14px">
        <div class="muted" style="margin:2px 0">Applied changes</div>
        <div id="chgList"></div>
      </div>
    `;
    summary.appendChild(wrap);

    const list = summary.querySelector("#chgList");
    // We don't know the exact schema of `changes`; try a few options gracefully.
    const changes = Array.isArray(data?.changes) ? data.changes : [];
    if (!changes.length) {
      list.innerHTML = `<div class="muted">No granular changes recorded for this job.</div>`;
    } else {
      const ul = document.createElement("ul");
      ul.style.paddingLeft = "18px";
      for (const c of changes) {
        // Common possibilities: strings, or {action, before, after, path}
        let line = "";
        if (typeof c === "string") {
          line = c;
        } else if (c && typeof c === "object") {
          const a = c.action || c.op || "change";
          const path = c.path ? ` @ ${c.path}` : "";
          const before = c.before ?? c.from;
          const after = c.after ?? c.to;
          if (before !== undefined || after !== undefined) {
            line = `${a}${path}: "${String(before ?? "")}" → "${String(after ?? "")}"`;
          } else {
            line = `${a}${path}`;
          }
        } else {
          line = String(c);
        }
        const li = document.createElement("li");
        li.textContent = line;
        ul.appendChild(li);
      }
      list.appendChild(ul);
    }

    // attach tabs
    modalContent.appendChild(summary);
    modalContent.appendChild(raw);

    // default active = summary
    [...modalTabs.querySelectorAll("button")].forEach((btn) =>
      btn.setAttribute("aria-pressed", btn.dataset.tab === "summary")
    );
    [...modalContent.children].forEach(
      (sec) => (sec.style.display = sec.dataset.tab === "summary" ? "block" : "none")
    );

    modal.showModal();
  }

  // -------- Auth + profile --------
  const { data: authData } = await supabase.auth.getUser();
  const user = authData.user;
  if (!user) {
    signinOnly.classList.remove("hidden");
    return;
  }
  who.textContent = `Signed in as ${user.email || user.id}`;

  const { data: prof, error: profErr } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  profBox.classList.remove("hidden");
  matBox.classList.remove("hidden");

  if (!profErr && prof) {
    document.getElementById("full_name").textContent = prof?.full_name || "—";
    document.getElementById("email").textContent = prof?.email || "—";
    document.getElementById("phone").textContent = prof?.phone || "—";
    document.getElementById("skills").innerHTML = pills(prof?.skills || []);
    document.getElementById("titles").innerHTML = pills(prof?.target_titles || []);
    document.getElementById("locs").innerHTML = pills(prof?.locations || []);
    const pol = prof?.search_policy || {};
    const s = [
      `recency_days=${pol.recency_days ?? 0}`,
      `require_posted_date=${!!pol.require_posted_date}`,
      `remote_only=${!!pol.remote_only}`,
    ].join(", ");
    document.getElementById("policy").textContent = s;
    document.getElementById("updated").textContent = fmtDate(
      prof?.updated_at || prof?.created_at || "—"
    );
  } else {
    document.getElementById("full_name").textContent = `Error: ${
      profErr?.message || "profile not found"
    }`;
  }

  // -------- Actions --------
  async function generateDrafts() {
    genMsg.textContent = "Queuing…";
    const session = (await supabase.auth.getSession()).data.session;
    if (!session) {
      genMsg.textContent = "Sign in first.";
      return;
    }
    try {
      const restBase = "https://imozfqawxpsasjdmgdkh.supabase.co";
      const resp = await fetch(`${restBase}/functions/v1/request-draft`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey:
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imltb3pmcWF3eHBzYXNqZG1nZGtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg1Njk3NTUsImV4cCI6MjA3NDE0NTc1NX0.fkGObZvEy-oUfLrPcwgTSJbc-n6O5aE31SGIBeXImtc",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          top: Math.max(1, Math.min(20, parseInt(topN.value || "5", 10) || 5)),
        }),
      });
      const out = (await resp.json().catch(() => ({}))) || {};
      if (!resp.ok) {
        genMsg.textContent = `Error: ${out.detail || out.error || resp.status}`;
        return;
      }
      genMsg.textContent = `Queued request ${out.request_id}. Refresh in a bit.`;
      startPolling();
    } catch (e) {
      genMsg.textContent = "Error: " + String(e);
    }
  }

  async function loadDrafts() {
    draftBody.innerHTML = "";
    const key = `${user.id}/drafts_index.json`;
    const { data: signed, error } = await supabase.storage
      .from("outputs")
      .createSignedUrl(key, 60);
    if (error || !signed?.signedUrl) {
      draftTable.classList.add("hidden");
      noDrafts.classList.remove("hidden");
      return;
    }

    let idx = null;
    try {
      const r = await fetch(signed.signedUrl, { cache: "no-cache" });
      if (r.ok) idx = await r.json();
    } catch {}

    const rows = [];
    function push(type, file) {
      if (!file) return;
      rows.push([type, file]);
    }
    (idx?.outbox || []).forEach((f) => push("cover", `outbox/${f}`));
    (idx?.resumes || []).forEach((f) => push("resume", `resumes/${f}`));
    (idx?.changes || []).forEach((f) => push("changes", `changes/${f}`));

    if (rows.length === 0) {
      draftTable.classList.add("hidden");
      noDrafts.classList.remove("hidden");
      return;
    }

    for (const [type, rel] of rows) {
      const key2 = `${user.id}/${rel}`;
      const { data: s2 } = await supabase.storage
        .from("outputs")
        .createSignedUrl(key2, 60);

      const tr = document.createElement("tr");

      const tdT = document.createElement("td");
      tdT.textContent = type;
      tr.appendChild(tdT);

      const tdF = document.createElement("td");
      const name = rel.split("/").slice(-1)[0];

      if (type === "changes") {
        // Open in modal viewer
        const view = document.createElement("button");
        view.className = "btn";
        view.textContent = `View ${name}`;
        view.onclick = (e) => {
          e.preventDefault();
          showChangesViewer(s2?.signedUrl || "#", name);
        };
        tdF.appendChild(view);

        // Also add a small download anchor
        const dl = document.createElement("a");
        dl.href = s2?.signedUrl || "#";
        dl.target = "_blank";
        dl.rel = "noopener";
        dl.textContent = " download";
        dl.style.marginLeft = "6px";
        tdF.appendChild(dl);
      } else {
        // Regular download link for covers/resumes
        const a = document.createElement("a");
        a.href = s2?.signedUrl || "#";
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = name;
        tdF.appendChild(a);
      }

      tr.appendChild(tdF);
      draftBody.appendChild(tr);
    }

    draftTable.classList.remove("hidden");
    noDrafts.classList.add("hidden");
  }

  // Polling after queue (once every 5s, stop after 3 minutes)
  let pollTimer = null;
  let pollTicks = 0;
  function startPolling() {
    stopPolling();
    pollTicks = 0;
    pollTimer = setInterval(async () => {
      pollTicks += 1;
      await loadDrafts();
      if (pollTicks >= 36) stopPolling(); // 36 * 5s = 3min
    }, 5000);
  }
  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  genBtn.onclick = generateDrafts;
  await loadDrafts();
})();
