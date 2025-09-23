<!-- docs/profile.js -->
<script>
(async function () {
  await new Promise((r) => window.addEventListener("load", r));

  const supabase = window.supabase.createClient(
    "https://imozfqawxpsasjdmgdkh.supabase.co",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imltb3pmcWF3eHBzYXNqZG1nZGtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg1Njk3NTUsImV4cCI6MjA3NDE0NTc1NX0.fkGObZvEy-oUfLrPcwgTSJbc-n6O5aE31SGIBeXImtc"
  );

  // --------- DOM refs ---------
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

  // --------- helpers ---------
  function pills(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return "—";
    return arr.map((x) => `<span class="pill">${String(x)}</span>`).join(" ");
  }
  function escapeHTML(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // ---- word-level diff (LCS) ----
  function diffWords(a, b) {
    const A = (a || "").trim().split(/\s+/);
    const B = (b || "").trim().split(/\s+/);
    const n = A.length, m = B.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const chunks = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) {
        chunks.push({ type: "eq", text: A[i] }); i++; j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        chunks.push({ type: "del", text: A[i] }); i++;
      } else {
        chunks.push({ type: "ins", text: B[j] }); j++;
      }
    }
    while (i < n) chunks.push({ type: "del", text: A[i++] });
    while (j < m) chunks.push({ type: "ins", text: B[j++] });
    return chunks;
  }
  function renderWordDiffHTML(original, modified) {
    const chunks = diffWords(original || "", modified || "");
    const coalesced = [];
    for (const c of chunks) {
      const last = coalesced[coalesced.length - 1];
      if (last && last.type === c.type) last.text += " " + c.text;
      else coalesced.push({ ...c });
    }
    return coalesced.map(({ type, text }) => {
      const t = escapeHTML(text);
      if (type === "eq")  return t;
      if (type === "ins") return `<ins style="background:#e6ffe6;text-decoration:none">${t}</ins>`;
      if (type === "del") return `<del style="background:#ffecec">${t}</del>`;
      return t;
    }).join(" ").replace(/\s+(<\/(ins|del)>)/g, "$1");
  }

  // ---- modal helpers ----
  function ensureModalRoot() {
    let root = document.getElementById("modal-root");
    if (root) return root;
    root = document.createElement("div");
    root.id = "modal-root";
    root.style.position = "fixed";
    root.style.inset = "0";
    root.style.display = "none";
    root.style.alignItems = "center";
    root.style.justifyContent = "center";
    root.style.background = "rgba(0,0,0,0.35)";
    root.style.zIndex = "9999";
    document.body.appendChild(root);
    root.addEventListener("click", (e) => { if (e.target === root) closeModal(); });
    return root;
  }
  function closeModal() {
    const root = ensureModalRoot();
    root.style.display = "none";
    root.innerHTML = "";
  }
  function openModal(title, innerEl) {
    const root = ensureModalRoot();
    root.innerHTML = "";
    const box = document.createElement("div");
    box.style.width = "min(900px, 92vw)";
    box.style.maxHeight = "86vh";
    box.style.overflow = "auto";
    box.style.background = "#fff";
    box.style.borderRadius = "12px";
    box.style.boxShadow = "0 10px 28px rgba(0,0,0,0.2)";
    box.style.padding = "14px";

    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";
    header.style.gap = "12px";
    header.style.marginBottom = "10px";

    const h = document.createElement("h3");
    h.textContent = title;
    h.style.margin = "0";

    const btn = document.createElement("button");
    btn.textContent = "Close";
    btn.className = "btn";
    btn.onclick = closeModal;

    header.appendChild(h);
    header.appendChild(btn);
    box.appendChild(header);
    box.appendChild(innerEl);
    root.appendChild(box);
    root.style.display = "flex";
  }
  function makeBadge(text) {
    const b = document.createElement("span");
    b.textContent = text;
    b.style.display = "inline-block";
    b.style.padding = "2px 8px";
    b.style.margin = "2px 6px 2px 0";
    b.style.border = "1px solid #e0e0e0";
    b.style.borderRadius = "999px";
    b.style.background = "#f6f6f6";
    b.style.fontSize = "12px";
    return b;
  }

  // ---- Changes viewer (with word-level diff) ----
  function renderChangesViewer(json, signedUrl, filename) {
    const wrap = document.createElement("div");

    const tabs = document.createElement("div");
    tabs.style.display = "flex";
    tabs.style.gap = "6px";
    tabs.style.marginBottom = "8px";
    const tabCmp = document.createElement("button"); tabCmp.textContent = "Comparison"; tabCmp.className = "btn";
    const tabRaw = document.createElement("button"); tabRaw.textContent = "Raw JSON"; tabRaw.className = "btn";
    tabs.appendChild(tabCmp); tabs.appendChild(tabRaw);

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
      const t = document.createElement("div");
      t.textContent = title;
      t.style.fontWeight = "600";
      t.style.marginBottom = "4px";
      const body = document.createElement("div");
      body.style.whiteSpace = "pre-wrap";
      body.style.border = "1px solid #f0f0f0";
      body.style.borderRadius = "8px";
      body.style.padding = "8px";
      body.style.background = "#fcfcfc";
      body.innerHTML = html;
      outer.appendChild(t);
      outer.appendChild(body);
      return outer;
    }

    function makeCompareCard(item, idx) {
      const card = document.createElement("div");
      card.style.border = "1px solid #eee";
      card.style.borderRadius = "10px";
      card.style.padding = "10px";
      card.style.margin = "10px 0";

      const head = document.createElement("div");
      head.style.display = "flex";
      head.style.justifyContent = "space-between";
      head.style.alignItems = "center";
      head.style.gap = "8px";
      head.style.marginBottom = "8px";
      const label = document.createElement("div");
      label.innerHTML = `<strong>Change ${idx + 1}</strong>${
        item?.anchor_section ? ` — ${escapeHTML(item.anchor_section)}` : ""
      }`;
      head.appendChild(label);
      card.appendChild(head);

      const grid = document.createElement("div");
      grid.style.display = "grid";
      grid.style.gridTemplateColumns = "1fr 1fr";
      grid.style.gap = "10px";

      const originalText = item?.original_paragraph_text || "";
      const modifiedText = item?.modified_paragraph_text || originalText;
      const inserted = item?.inserted_sentence || "";

      let rightHTML;
      if (inserted && !originalText.includes(inserted) && modifiedText.includes(inserted)) {
        rightHTML = escapeHTML(modifiedText).replace(
          new RegExp(`(${inserted.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")})`, "i"),
          "<mark>$1</mark>"
        );
      } else {
        rightHTML = renderWordDiffHTML(originalText, modifiedText);
      }

      const left = document.createElement("div");
      const right = document.createElement("div");
      left.appendChild(boxify("Original paragraph", escapeHTML(originalText || "—")));
      right.appendChild(boxify("Modified paragraph", rightHTML || "—"));

      grid.appendChild(left);
      grid.appendChild(right);
      card.appendChild(grid);

      return card;
    }

    const items = Array.isArray(json?.changes) ? json.changes : [];
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.style.color = "#666";
      empty.textContent = "No granular changes recorded for this job.";
      cmp.appendChild(empty);
    } else {
      items.forEach((it, i) => cmp.appendChild(makeCompareCard(it, i)));
    }

    const pre = document.createElement("pre");
    pre.style.border = "1px solid #eee";
    pre.style.borderRadius = "10px";
    pre.style.padding = "10px";
    pre.style.background = "#fcfcfc";
    pre.style.whiteSpace = "pre-wrap";
    pre.textContent = JSON.stringify(json || {}, null, 2);

    function showCmp() { cmp.style.display = ""; pre.style.display = "none"; }
    function showRaw() { cmp.style.display = "none"; pre.style.display = ""; }
    const tabs = document.createElement("div");
    tabs.style.display = "flex"; tabs.style.gap = "6px"; tabs.style.marginBottom = "8px";
    const tabCmp = document.createElement("button"); tabCmp.textContent = "Comparison"; tabCmp.className = "btn"; tabCmp.onclick = showCmp;
    const tabRaw = document.createElement("button"); tabRaw.textContent = "Raw JSON"; tabRaw.className = "btn"; tabRaw.onclick = showRaw;

    const wrap2 = document.createElement("div");
    wrap2.appendChild(tabs);
    wrap2.appendChild(meta);
    wrap2.appendChild(cmp);
    wrap2.appendChild(pre);

    showCmp();
    openModal(`Changes — ${filename}`, wrap2);
  }

  // --------- auth + profile ---------
  const { data: userRes } = await supabase.auth.getUser();
  const user = userRes?.user;
  if (!user) { document.getElementById("signinOnly").classList.remove("hidden"); return; }
  who.textContent = `Signed in as ${user.email || user.id}`;

  const { data: prof, error: profErr } = await supabase
    .from("profiles").select("*").eq("id", user.id).single();

  document.getElementById("profile").classList.remove("hidden");
  document.getElementById("materials").classList.remove("hidden");

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
    document.getElementById("policy").textContent = s;
    document.getElementById("updated").textContent = (prof?.updated_at || prof?.created_at || "—").toString();
  } else {
    document.getElementById("full_name").textContent = `Error: ${profErr?.message || "profile not found"}`;
  }

  // --------- Generate materials (unchanged) ---------
  async function generateDrafts() {
    genMsg.textContent = "Queuing…";
    const session = (await supabase.auth.getSession()).data.session;
    if (!session) { genMsg.textContent = "Sign in first."; return; }
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
    const { user } = (await supabase.auth.getUser()).data || {};
    if (!user) return;
    const key = `${user.id}/drafts_index.json`;
    const { data: signed } = await supabase.storage.from("outputs").createSignedUrl(key, 60);
    draftBody.innerHTML = "";

    if (!signed?.signedUrl) {
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
    function push(type, file) { rows.push([type, file]); }
    (idx?.outbox || []).forEach((f) => push("cover",   `outbox/${f}`));
    (idx?.resumes || []).forEach((f) => push("resume", `resumes/${f}`));
    (idx?.changes || []).forEach((f) => push("changes",`changes/${f}`));

    if (rows.length === 0) {
      draftTable.classList.add("hidden");
      noDrafts.classList.remove("hidden");
      return;
    }

    for (const [type, rel] of rows) {
      const key2 = `${user.id}/${rel}`;
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

    draftTable.classList.remove("hidden");
    noDrafts.classList.add("hidden");
  }

  // Poll drafts while the page is open
  let pollTimer = null;
  function pollDrafts() { if (pollTimer) clearInterval(pollTimer); pollTimer = setInterval(loadDrafts, 5000); }

  genBtn.onclick = generateDrafts;
  await loadDrafts();

  // ---- IMPORTANT: bring the dashboard controls to this page only ----
  if (window.initOnboardControls) {
    await window.initOnboardControls(supabase);
  }
})();
</script>
