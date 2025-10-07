/* docs/js/power-edit.js
 * Power Edit (live). Now reuses parsed profile (Supabase) and, if available,
 * calls a tiny Edge Function "power-edit-suggest" that wraps your LLM helpers.
 * Falls back to fully client-side suggestions when server is unavailable.
 *
 * Behavior:
 * - Suggestions click = weave phrase into the best existing bullet AFTER Education.
 * - Supports mid-sentence or new-sentence appends (format-preserving).
 * - Adds metric-ready “Implemented/Built/Used … [X%]” templates per skill.
 * - Detects long/weak bullets and offers safe rewrites (no fabrication).
 * - Never edits Education / “References available …”.
 */

import {
  smartJDTargets,
  bridgeForToken,
  explainGaps,
  jdCoverageAgainstResume,
  templatesForSkill,
  assessWeakness,
  CUE_SETS
} from "./scoring.js?v=2025-10-12-1";

/* -------------------- DOM -------------------- */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const els = {
  editor:       $("#editor"),
  jdTitle:      $("#job_title"),
  jdCompany:    $("#job_company"),
  jdLocation:   $("#job_location"),
  jdText:       $("#job_desc"),
  scoreline:    $("#scoreline"),
  gaps:         $("#gaps"),
  suggestions:  $("#suggestions"),
  coverage:     $("#coverage"),
  btnAuto:      $("#btn_auto_server"),
  btnUndo:      $("#btn_undo_auto"),
  btnClear:     $("#btn_clear_auto"),
  autoHint:     $("#auto_hint"),
  file:         $("#docx_file"),
  btnExport:    $("#btn_export_docx"),
  btnPrint:     $("#btn_print_pdf"),
  modeBadge:    $("#mode_badge")
};

/* -------------------- State -------------------- */

const STATE = {
  jd: "",
  profile: { skills: [], titles: [] },
  jdTargets: [],
  serverPhrases: [],   // {clause, jd_cues[], bullet_cues[]} from Edge Function
  resumeHTML: "",
  inserts: [],         // [{node, beforeHTML, afterHTML, phrase, why}]
  bridgeStyle: (window.POWER_EDIT_BRIDGE_STYLE || "dash"),
  dashThreshold: parseInt(window.POWER_EDIT_DASH_THRESHOLD || "7", 10) || 7,
  serverOk: false
};

/* -------------------- Supabase wiring (optional) -------------------- */

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

async function supabaseClient() {
  const url = window.SUPABASE_URL;
  const key = window.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const lib = await ensureSupabase();
  return lib.createClient(url, key);
}

async function getUser(sb) {
  try {
    const { data } = await sb.auth.getUser();
    return data.user || null;
  } catch { return null; }
}

async function fetchProfile(sb, user) {
  try {
    const { data, error } = await sb.from("profiles").select("*").eq("id", user.id).single();
    if (error) return {};
    return {
      skills: (data?.skills || []).map(String),
      titles: (data?.target_titles || []).map(String),
      locations: (data?.locations || []).map(String)
    };
  } catch { return {}; }
}

/* -------------------- JD / resume helpers -------------------- */

const norm = s => (s || "").replace(/\s+/g, " ").trim();
const text = n => norm(n?.textContent || "");

function sentenceCase(s) {
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/[A-Za-z]/.test(ch)) return s.slice(0, i) + ch.toUpperCase() + s.slice(i + 1);
  }
  return s;
}

function paraNodesInEditor() {
  return $$("#editor h1, #editor h2, #editor h3, #editor h4, #editor p, #editor li, #editor div");
}

/* -------------------- Section detection -------------------- */

const EDU_TITLES = [
  "education", "education and training", "education & training",
  "academic credentials", "academics", "education and honors"
];
const EXP_TITLES = [
  "work experience", "experience", "professional experience",
  "employment", "relevant experience"
];

function findSectionRanges(titles) {
  const wants = titles.map(t => t.toLowerCase());
  const blocks = paraNodesInEditor();
  const hits = [];
  for (let i = 0; i < blocks.length; i++) {
    const t = text(blocks[i]).toLowerCase();
    if (wants.includes(t)) hits.push({ i, key: t });
  }
  const ranges = new Map();
  for (let h = 0; h < hits.length; h++) {
    const start = hits[h].i;
    const end = (h + 1 < hits.length) ? hits[h + 1].i : blocks.length;
    ranges.set(hits[h].key, [start, end]);
  }
  return { blocks, ranges };
}

function educationRange() {
  const titles = [...EDU_TITLES, ...EXP_TITLES, "skills","technical skills","core skills","projects","certifications","awards","summary","professional summary","publications","volunteer experience","research experience","activities","leadership"];
  const { blocks, ranges } = findSectionRanges(titles);
  for (const k of EDU_TITLES.map(t => t.toLowerCase())) {
    if (ranges.has(k)) return { blocks, range: ranges.get(k) };
  }
  return { blocks, range: null };
}

function workStartIndex() {
  const { ranges } = findSectionRanges([...EXP_TITLES, ...EDU_TITLES]);
  for (const name of EXP_TITLES.map(t => t.toLowerCase())) {
    if (ranges.has(name)) return ranges.get(name)[0];
  }
  const { blocks, range } = educationRange();
  if (range) return range[1];
  return Math.min(paraNodesInEditor().length, 8);
}

function isReferenceLine(n) {
  const t = text(n).toLowerCase();
  return t.includes("references") && (t.includes("request") || t.includes("available"));
}
function inEducation(i) {
  const { range } = educationRange();
  return !!(range && i >= range[0] && i < range[1]);
}

/* -------------------- Candidates & scoring -------------------- */

function candidateBullets() {
  const blocks = paraNodesInEditor();
  const start = workStartIndex();
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    if (i < start) continue;
    if (inEducation(i)) continue;
    const n = blocks[i];
    const isLI = n.tagName?.toLowerCase() === "li";
    const isLongP = (n.tagName?.toLowerCase() === "p") && text(n).length >= 25;
    if (!isLI && !isLongP) continue;
    if (!text(n)) continue;
    if (isReferenceLine(n)) continue;
    out.push({ i, node: n });
  }
  return out;
}

function scoreBulletForCategory(bulletText, category) {
  const t = bulletText.toLowerCase();
  let score = 0;
  const cues = CUE_SETS[category] || [];
  for (const c of cues) if (t.includes(c)) score += 2;
  if (/(develop|build|design|implement|optimiz|maintain|improv|migrat|deploy|integrat)/i.test(t)) score += 1;
  if (t.length > 60) score += 1; // prefer richer bullets
  return score;
}
function bestBullet(category) {
  const cands = candidateBullets();
  let best = null, bestScore = -1;
  for (const c of cands) {
    const s = scoreBulletForCategory(text(c.node), category);
    if (s > bestScore) { best = c.node; bestScore = s; }
  }
  return best;
}

/* -------------------- Insertion & rewrites -------------------- */

function buildInsertionHTML(hostNode, clause, style = "dash", dashThreshold = 7) {
  const before = hostNode.innerHTML;
  const plain = text(hostNode);
  if (!plain) return null;
  if (plain.toLowerCase().includes(clause.toLowerCase())) return null;

  const endsWithPeriod = /[.!?]\s*$/.test(plain);
  const words = clause.trim().split(/\s+/).length;
  const delim = (style === "comma") ? ", " : (style === "auto" ? (words >= dashThreshold ? " — " : ", ") : " — ");

  let ins = "";
  if (endsWithPeriod) {
    const body = sentenceCase(clause.replace(/^[,—–\s]+/, ""));
    ins = " " + body + (body.endsWith(".") ? "" : ".");
  } else {
    ins = (plain.endsWith(" ") ? "" : delim) + clause.replace(/^[,—–\s]+/, "");
  }

  return {
    beforeHTML: before,
    afterHTML: before + `<span class="ins">${ins}</span>`,
    insertedText: ins.trim()
  };
}

function weavePhraseIntoResume(phrase, why, category) {
  const host = bestBullet(category);
  if (!host) return false;
  const ins = buildInsertionHTML(host, phrase, STATE.bridgeStyle, STATE.dashThreshold);
  if (!ins) return false;

  host.classList.add("auto-insert");
  host.dataset.before = ins.beforeHTML;
  host.innerHTML = ins.afterHTML;

  const btn = document.createElement("button");
  btn.textContent = "?";
  btn.className = "secondary small";
  btn.style.marginLeft = "6px";
  btn.title = why || "Keyword from the job description";
  btn.addEventListener("click", (e) => { e.preventDefault(); alert(why || "Inserted to align with JD keywords."); });
  host.appendChild(btn);

  STATE.inserts.push({ node: host, beforeHTML: ins.beforeHTML, afterHTML: host.innerHTML, phrase, why });
  els.btnUndo.disabled = els.btnClear.disabled = STATE.inserts.length === 0;
  return true;
}

function appendNewBulletAfterEducation(clause, why) {
  const blocks = paraNodesInEditor();
  const start = workStartIndex();

  let targetList = null;
  for (let i = start; i < blocks.length; i++) {
    const n = blocks[i];
    if (n.closest && (n.closest("ul,ol"))) { targetList = n.closest("ul,ol"); break; }
    if (n.tagName && (n.tagName.toLowerCase() === "ul" || n.tagName.toLowerCase() === "ol")) { targetList = n; break; }
  }
  if (!targetList) {
    const startNode = blocks[start] || els.editor.lastElementChild || els.editor;
    const ul = document.createElement("ul");
    startNode.parentNode.insertBefore(ul, startNode.nextSibling);
    targetList = ul;
  }
  const li = document.createElement("li");
  li.className = "auto-insert";
  const ins = (clause.startsWith(",") || clause.startsWith(" — ")) ? clause.replace(/^[,—–]\s*/, "") : clause;
  li.innerHTML = `<span class="ins">• ${ins}</span>`;
  targetList.appendChild(li);

  const btn = document.createElement("button");
  btn.textContent = "?";
  btn.className = "secondary small";
  btn.style.marginLeft = "6px";
  btn.title = why || "Keyword from the job description";
  btn.addEventListener("click", e => { e.preventDefault(); alert(why || "Inserted to align with JD keywords."); });
  li.appendChild(btn);

  STATE.inserts.push({ node: li, beforeHTML: "", afterHTML: li.innerHTML, phrase: ins, why });
  els.btnUndo.disabled = els.btnClear.disabled = false;
}

function undoLast() {
  const item = STATE.inserts.pop();
  if (!item) return;
  item.node.innerHTML = item.beforeHTML;
  item.node.classList.remove("auto-insert");
  delete item.node.dataset.before;
  els.btnUndo.disabled = els.btnClear.disabled = STATE.inserts.length === 0;
}
function clearAllInserts() { while (STATE.inserts.length) undoLast(); }

/* -------------------- Weak/overlong line rewrites -------------------- */

function safeRewrite(textLine, jdTokens = []) {
  const t = norm(textLine).replace(/^\u2022\s*/, "");
  if (!t) return t;
  // Strip weak openers
  let s = t.replace(/\b(responsible for|duties included)\b/i, "");
  // Integrate 1–2 JD tokens as a method clause (no fabricated metrics)
  const picks = jdTokens.slice(0, 2).filter(Boolean);
  const chunk = picks.length === 2 ? `${picks[0]} and ${picks[1]}` : (picks[0] || "");
  if (chunk) {
    const join = (STATE.bridgeStyle === "comma") ? ", " : (STATE.bridgeStyle === "auto" ? (chunk.split(/\s+/).length >= STATE.dashThreshold ? " — " : ", ") : " — ");
    s = s.replace(/[.!?]\s*$/, "");
    s = `${s}${join}leveraging ${chunk}.`;
  }
  // Tighten up spacing/case
  return s.replace(/\s+/g, " ").trim();
}

function proposeRewritesForDocument() {
  const cands = candidateBullets();
  const jd = norm(els.jdText.value);
  const targets = (STATE.jdTargets || []).map(t => t.display);
  const rewrites = [];
  for (const c of cands) {
    const w = assessWeakness(text(c.node));
    if (w.long || w.weak) {
      rewrites.push({
        node: c.node,
        before: c.node.innerHTML,
        afterText: safeRewrite(text(c.node), targets),
        reason: w.long
          ? "Condensed a long bullet while integrating a concise JD method clause."
          : "Replaced weak phrasing with a strong, method‑rich sentence."
      });
    }
  }
  return rewrites;
}

/* -------------------- Suggestions (local + server) -------------------- */

function renderSuggestionItem({labelHTML, clause, category, why}) {
  const item = document.createElement("div");
  item.className = "suggestion";
  item.innerHTML = labelHTML;
  item.addEventListener("click", () => {
    const ok = weavePhraseIntoResume(clause, why, category);
    if (!ok) appendNewBulletAfterEducation(clause, why);
    refreshCoverage();
  });
  els.suggestions.appendChild(item);
}

function buildLocalSuggestions() {
  els.suggestions.innerHTML = "";
  const allowed = STATE.profile.skills || [];
  STATE.jdTargets = smartJDTargets(norm(els.jdText.value), allowed).slice(0, 16);

  if (!STATE.jdTargets.length) {
    els.suggestions.textContent = "Suggestions appear after you paste a JD.";
    return;
  }

  for (const t of STATE.jdTargets) {
    const clause = bridgeForToken(t.display, t.category, STATE.bridgeStyle, STATE.dashThreshold).replace(/^[,—–]\s*/, "");
    const why = `Tailored for JD keyword: ${t.display}`;
    const label = `• <strong>${t.display}</strong> <span class="small muted">(${t.category})</span><br/><span class="small">Weave: <code>${clause}</code> <span class="pill">local</span></span>`;
    renderSuggestionItem({labelHTML: label, clause, category: t.category, why});
    // add your metric-ready templates
    for (const tpl of templatesForSkill(t.display)) {
      const labelTpl = `• ${tpl.replace(/\[.*?\]/g, '<span class="muted">[fill]</span>')} <span class="small pill">template</span>`;
      renderSuggestionItem({labelHTML: labelTpl, clause: tpl, category: t.category, why: `Metric-ready template for ${t.display}`});
    }
  }
}

async function buildServerSuggestions() {
  if (!STATE.serverOk) return;
  try {
    const sb = await supabaseClient();
    if (!sb) return;
    const session = await sb.auth.getSession();
    if (!session?.data?.session) return;

    const payload = {
      job_title: norm(els.jdTitle?.value || ""),
      job_company: norm(els.jdCompany?.value || ""),
      job_description: norm(els.jdText.value),
      resume_plain: text(els.editor),
      allowed_vocab: (STATE.profile.skills || []).concat(STATE.profile.titles || []),
      wanted: 8
    };
    const { data, error } = await sb.functions.invoke("power-edit-suggest", { body: payload });
    if (error || !data) return;

    const clauses = Array.isArray(data?.clauses) ? data.clauses : [];
    STATE.serverPhrases = clauses.filter(it => it?.clause).slice(0, 12);

    for (const it of STATE.serverPhrases) {
      const clause = String(it.clause).trim();
      const category = (it.bullet_cues && it.bullet_cues.length) ? CUE_SETS.backend ? "backend" : "other" : "other";
      const label = `• <strong>${clause}</strong><br/><span class="small">Weave: <code>${clause}</code> <span class="pill">server</span></span>`;
      renderSuggestionItem({labelHTML: label, clause, category, why: "Server‑suggested clause (Edge Function)"});
    }
  } catch {
    // silent fallback
  }
}

/* -------------------- Coverage / Score -------------------- */

function refreshCoverage() {
  const jd = norm(els.jdText.value);
  const resumePlain = text(els.editor);
  if (!jd || !resumePlain) return;

  const cov = jdCoverageAgainstResume(jd, resumePlain);
  const score = Math.round((cov.hits.length / (cov.hits.length + cov.misses.length || 1)) * 100);
  els.scoreline.textContent = `Score: ${isFinite(score) ? score : 0}`;

  els.gaps.innerHTML = "";
  if (cov.misses.length) {
    const frag = document.createElement("div");
    frag.innerHTML = cov.misses.slice(0, 40).map(w => `<span class="k miss">${w}</span>`).join(" ");
    els.gaps.appendChild(frag);
  } else {
    els.gaps.textContent = "Nice—no obvious gaps found yet.";
  }

  els.coverage.innerHTML = [
    `<div class="small">Hits: ${cov.hits.slice(0, 40).map(w => `<span class="k hit">${w}</span>`).join(" ") || "—"}</div>`,
    `<div class="small">Misses: ${cov.misses.slice(0, 40).map(w => `<span class="k miss">${w}</span>`).join(" ") || "—"}</div>`
  ].join("");
}

/* -------------------- Import/Export -------------------- */

async function importDocx(file) {
  const buf = await file.arrayBuffer();
  const result = await window.mammoth.convertToHtml({ arrayBuffer: buf });
  els.editor.innerHTML = result.value || "";
  STATE.resumeHTML = els.editor.innerHTML;
  refreshCoverage();
  await hydrateProfileAndSuggestions(); // re-rank with profile skills
}
function exportDocx() {
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>${els.editor.innerHTML}</body></html>`;
  const blob = window.htmlDocx.asBlob(html);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "tailored_resume.docx";
  a.click();
}

/* -------------------- UI Wiring -------------------- */

function updateAutoHint() {
  const hasJD = norm(els.jdText.value).length > 0;
  const hasResume = norm(text(els.editor)).length > 0;
  els.btnAuto.disabled = !(hasJD && hasResume);
  els.autoHint.textContent = els.btnAuto.disabled
    ? "Paste a JD and load/paste your resume to enable Auto‑tailor."
    : "";
}

els.jdText.addEventListener("input", async () => { await buildAllSuggestions(); refreshCoverage(); updateAutoHint(); });
els.editor.addEventListener("input", () => { refreshCoverage(); updateAutoHint(); });

els.btnUndo.addEventListener("click", undoLast);
els.btnClear.addEventListener("click", clearAllInserts);

els.btnAuto.addEventListener("click", async () => {
  // Try server phrases first, then local targets
  const candidateClauses = []
    .concat((STATE.serverPhrases || []).map(p => p.clause))
    .concat((STATE.jdTargets || []).map(t => bridgeForToken(t.display, t.category, STATE.bridgeStyle, STATE.dashThreshold).replace(/^[,—–]\s*/, "")))
    .filter(Boolean);

  let applied = 0;
  for (const clause of candidateClauses.slice(0, 6)) {
    if (weavePhraseIntoResume(clause, "Auto‑tailor insert", "other")) applied++;
  }
  if (!applied && candidateBullets().length === 0 && candidateClauses.length) {
    appendNewBulletAfterEducation(candidateClauses[0], "Auto‑tailor insert");
  }
  refreshCoverage();

  // Offer rewrites for weak/long lines (non-destructive preview via alert)
  const rewrites = proposeRewritesForDocument().slice(0, 3);
  if (rewrites.length) {
    const msg = rewrites.map(r => `– ${r.afterText}`).join("\n");
    console.info("Rewrite suggestions:", msg);
  }
});

els.file?.addEventListener("change", (e) => { const f = e.target.files[0]; if (f) importDocx(f); });
els.btnExport?.addEventListener("click", exportDocx);
els.btnPrint?.addEventListener("click", () => window.print());

/* -------------------- Profile + suggestions bootstrap -------------------- */

async function hydrateProfileAndSuggestions() {
  try {
    const sb = await supabaseClient();
    if (!sb) { STATE.serverOk = false; await buildAllSuggestions(); return; }
    const user = await getUser(sb);
    if (!user) { STATE.serverOk = false; await buildAllSuggestions(); return; }
    STATE.profile = await fetchProfile(sb, user);
    STATE.serverOk = true;
    if (els.modeBadge) els.modeBadge.textContent = "Signed in (server boost)";
  } catch {
    STATE.serverOk = false;
  }
  await buildAllSuggestions();
}

async function buildAllSuggestions() {
  els.suggestions.innerHTML = "";
  buildLocalSuggestions();
  await buildServerSuggestions(); // may append more items
}

/* -------------------- Initial -------------------- */

(async function init() {
  updateAutoHint();
  await hydrateProfileAndSuggestions();
  refreshCoverage();
})();
