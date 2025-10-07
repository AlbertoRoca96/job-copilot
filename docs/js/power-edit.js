/* docs/js/power-edit.js
 * Power Edit (live) — multi‑placement weaving, natural mid‑sentence joins,
 * smarter JD targets, per‑bullet budgets, and secure server suggestions via your Edge Function.
 *
 * This build aligns tone with profile.html: short method/context clauses, varied joiners,
 * and anti‑chain logic (no “with, with, with …”). Education/References are always skipped.
 */

import {
  smartJDTargets,
  bridgeForToken,
  jdCoverageAgainstResume,
  templatesForSkill,
  assessWeakness,
  CUE_SETS,
  STOP
} from "./scoring.js?v=2025-10-13-6";

/* -------------------- DOM -------------------- */

const $  = (s, r = document) => r.querySelector(s);
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
  modeBadge:    $("#mode_badge"),
  placements:   $("#place_count"),
  joiner:       $("#joiner_style"),
  maxPerBullet: $("#max_per_bullet")
};

/* -------------------- State -------------------- */

const STATE = {
  profile: { skills: [], titles: [] },
  jdTargets: [],
  serverPhrases: [],           // {clause, jd_cues[], bullet_cues[]}
  inserts: [],                 // [{node, beforeHTML, afterHTML, phrase, why}]
  bridgeStyle: "auto",
  dashThreshold: 7,
  serverOk: false,
  perBulletBudget: new WeakMap(), // node -> count
  maxPerBullet: 1
};

/* -------------------- Supabase (optional but preferred) -------------------- */

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
  const url = window.SUPABASE_URL, key = window.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const lib = await ensureSupabase();
  return lib.createClient(url, key);
}
async function getUser(sb) { try { const { data } = await sb.auth.getUser(); return data.user || null; } catch { return null; } }
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

/* -------------------- Text helpers -------------------- */

const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
const text = (n) => norm(n?.textContent || ""); // plain text (no markup)

function sentenceCase(s) {
  for (let i = 0; i < s.length; i++) { const ch = s[i]; if (/[A-Za-z]/.test(ch)) return s.slice(0,i) + ch.toUpperCase() + s.slice(i+1); }
  return s;
}

function paraNodesInEditor() {
  return $$("#editor h1, #editor h2, #editor h3, #editor h4, #editor p, #editor li, #editor div");
}

/* -------------------- Section detection (Education guard) -------------------- */

const EDU_TITLES = [
  "education","education and training","education & training",
  "academic credentials","academics","education and honors"
];
const EXP_TITLES = [
  "work experience","experience","professional experience","employment","relevant experience"
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
    const end = (h + 1 < hits.length) ? hits[h+1].i : blocks.length;
    ranges.set(hits[h].key, [start, end]);
  }
  return { blocks, ranges };
}

function educationRange() {
  const titles = [...EDU_TITLES, ...EXP_TITLES, "skills","technical skills","core skills","projects","certifications","awards","summary","professional summary","publications","volunteer experience","research experience","activities","leadership","references"];
  const { blocks, ranges } = findSectionRanges(titles);
  for (const k of EDU_TITLES.map(t => t.toLowerCase())) { if (ranges.has(k)) return { blocks, range: ranges.get(k) }; }
  return { blocks, range: null };
}

function workStartIndex() {
  const { ranges } = findSectionRanges([...EXP_TITLES, ...EDU_TITLES]);
  for (const name of EXP_TITLES.map(t => t.toLowerCase())) if (ranges.has(name)) return ranges.get(name)[0];
  const { blocks, range } = educationRange(); if (range) return range[1];
  return Math.min(paraNodesInEditor().length, 8);
}
function inEducation(i) { const { range } = educationRange(); return !!(range && i >= range[0] && i < range[1]); }
function isReferenceLine(n) { const t = text(n).toLowerCase(); return (t.includes("references") && (t.includes("request") || t.includes("available"))) || t === "references"; }

/* -------------------- Candidate bullets -------------------- */

const METHOD_LEADS = /\b(with|via|using|through|by|for|on)\b/i;

function candidateBullets() {
  const blocks = paraNodesInEditor();
  const start = workStartIndex();
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    if (i < start) continue;
    if (inEducation(i)) continue;
    const n = blocks[i];
    const isLI = n.tagName?.toLowerCase() === "li";
    const longP = (n.tagName?.toLowerCase() === "p") && text(n).length >= 25;
    if (!isLI && !longP) continue;
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
  if (t.length > 60) score += 1; // favor richer bullets
  // small bonus if bullet already has a method lead (more natural to append)
  if (METHOD_LEADS.test(t)) score += 1;
  return score;
}

// per‑bullet budget helpers
function canUseNode(node) {
  const cap = STATE.maxPerBullet || 1;
  const used = STATE.perBulletBudget.get(node) || 0;
  return used < cap;
}
function markUse(node) {
  const used = STATE.perBulletBudget.get(node) || 0;
  STATE.perBulletBudget.set(node, used + 1);
}
function unmarkUse(node) {
  const used = STATE.perBulletBudget.get(node) || 0;
  if (used > 0) STATE.perBulletBudget.set(node, used - 1);
}

function pickBestBullets(category, count = 1) {
  const cands = candidateBullets();
  const scored = cands
    .map(c => ({ node: c.node, score: scoreBulletForCategory(text(c.node), category) }))
    .filter(x => x.score > 0 && canUseNode(x.node));
  scored.sort((a,b) => b.score - a.score);
  const nodes = [];
  for (const s of scored) {
    if (nodes.length >= Math.max(1, count)) break;
    if (canUseNode(s.node)) nodes.push(s.node);
  }
  return nodes;
}

/* -------------------- Insertion (mid‑sentence first, then new sentence) -------------------- */

function chooseDelim(words, style, dashThreshold) {
  return (style === "comma") ? ", " : (style === "dash") ? " — " : (words >= dashThreshold ? " — " : ", ");
}
function sanitizeClause(c) {
  // never start with "and"; ensure no leading punctuation; keep lowercased preposition style
  return String(c || "").replace(/^\s*(?:and\s+|[,—–]\s*)/i, "").trim();
}
function cutpoints(plain) {
  // candidate cutpoints after sensible joiners
  const pts = [];
  const re = /\b(using|with|via|through|for|which|that|including|by|on)\b|[,;:—–]/gi;
  let m;
  while ((m = re.exec(plain)) !== null) { pts.push(m.index + (m[0].length)); }
  return pts;
}

// If the trailing context already ends with a method lead, avoid chaining another “with …”
function tailHasMethodJoiner(before) {
  const look = before.slice(Math.max(0, before.length - 60));
  return /\b(with|via|using|through|by|on|for)\b[^.!?]{0,40}$/i.test(look);
}

function insertAt(hostNode, idx, insertText) {
  const beforeHTML = hostNode.innerHTML;
  const plain = text(hostNode);
  if (!plain) return null;

  const left  = plain.slice(0, idx);
  const right = plain.slice(idx);
  // Escape HTML for safety
  const esc = (s) => s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  hostNode.innerHTML = esc(left) + `<span class="ins">${insertText}</span>` + esc(right);
  return { beforeHTML, afterHTML: hostNode.innerHTML, insertedText: insertText };
}

function buildInsertion(hostNode, clause, style = "auto", dashThreshold = 7) {
  const plain = text(hostNode);
  if (!plain) return null;
  const lc = plain.toLowerCase(), lcClause = clause.toLowerCase();
  if (lc.includes(lcClause)) return null;

  const words = clause.trim().split(/\s+/).length;
  const delim = chooseDelim(words, style, dashThreshold);
  const body  = sanitizeClause(clause);

  // Prefer mid‑sentence: last sensible breakpoint
  const cps = cutpoints(plain);
  if (cps.length && !tailHasMethodJoiner(plain)) {
    const cut = cps[cps.length - 1];
    const ins = (plain[cut - 1] && /\s/.test(plain[cut - 1])) ? body : (delim + body);
    return insertAt(hostNode, cut, ins);
  }

  // Otherwise new sentence (or chaining would look bad)
  const endsWithPeriod = /[.!?]\s*$/.test(plain);
  if (endsWithPeriod) {
    const s = " " + sentenceCase(body) + (body.endsWith(".") ? "" : ".");
    const before = hostNode.innerHTML;
    hostNode.innerHTML = before + `<span class="ins">${s}</span>`;
    return { beforeHTML: before, afterHTML: hostNode.innerHTML, insertedText: s.trim() };
  } else {
    const s = (plain.endsWith(" ") ? "" : delim) + body;
    const before = hostNode.innerHTML;
    hostNode.innerHTML = before + `<span class="ins">${s}</span>`;
    return { beforeHTML: before, afterHTML: hostNode.innerHTML, insertedText: s.trim() };
  }
}

function weaveOnce(hostNode, clause, why) {
  if (!canUseNode(hostNode)) return false;
  const ins = buildInsertion(hostNode, clause, STATE.bridgeStyle, STATE.dashThreshold);
  if (!ins) return false;

  hostNode.classList.add("auto-insert");
  hostNode.dataset.before = ins.beforeHTML;

  // little “?” explainer per insertion
  const btn = document.createElement("button");
  btn.textContent = "?"; btn.className = "secondary small"; btn.style.marginLeft = "6px";
  btn.title = why || "Keyword from the job description";
  btn.addEventListener("click", (e) => { e.preventDefault(); alert(why || "Inserted to align with JD keywords."); });
  hostNode.appendChild(btn);

  STATE.inserts.push({ node: hostNode, beforeHTML: ins.beforeHTML, afterHTML: hostNode.innerHTML, phrase: clause, why });
  markUse(hostNode);
  els.btnUndo.disabled = els.btnClear.disabled = STATE.inserts.length === 0;
  return true;
}

function weavePhraseIntoMultiple(phrase, why, category, maxPlacements = 2) {
  let placed = 0;
  for (const node of pickBestBullets(category, maxPlacements)) {
    const ok = weaveOnce(node, phrase, why);
    if (ok) placed++;
    if (placed >= maxPlacements) break;
  }
  return placed;
}

function appendNewBulletAfterEducation(clause, why) {
  const blocks = paraNodesInEditor();
  const start = workStartIndex();

  let targetList = null;
  for (let i = start; i < blocks.length; i++) {
    const n = blocks[i];
    if (n.closest && (n.closest("ul,ol"))) { targetList = n.closest("ul,ol"); break; }
    if (n.tagName && (/^u|o/i).test(n.tagName)) { targetList = n; break; }
  }
  if (!targetList) {
    const startNode = blocks[start] || els.editor.lastElementChild || els.editor;
    const ul = document.createElement("ul");
    startNode.parentNode.insertBefore(ul, startNode.nextSibling);
    targetList = ul;
  }
  const li = document.createElement("li");
  li.className = "auto-insert";
  const clean = sanitizeClause(clause);
  li.innerHTML = `<span class="ins">• ${clean}</span>`;

  const btn = document.createElement("button");
  btn.textContent = "?"; btn.className = "secondary small"; btn.style.marginLeft = "6px";
  btn.title = why || "Keyword from the job description";
  btn.addEventListener("click", e => { e.preventDefault(); alert(why || "Inserted to align with JD keywords."); });
  li.appendChild(btn);

  targetList.appendChild(li);
  STATE.inserts.push({ node: li, beforeHTML: "", afterHTML: li.innerHTML, phrase: clean, why });
  markUse(li);
  els.btnUndo.disabled = els.btnClear.disabled = STATE.inserts.length === 0;
}

function undoLast() {
  const item = STATE.inserts.pop();
  if (!item) return;
  item.node.innerHTML = item.beforeHTML;
  item.node.classList.remove("auto-insert");
  delete item.node.dataset.before;
  unmarkUse(item.node);
  els.btnUndo.disabled = els.btnClear.disabled = STATE.inserts.length === 0;
}
function clearAllInserts() { while (STATE.inserts.length) undoLast(); }

/* -------------------- Weak/overlong line rewrites (preview only) -------------------- */

function safeRewrite(textLine, jdTokens = []) {
  const t = norm(textLine).replace(/^\u2022\s*/, "");
  if (!t) return t;
  // Strip weak openers; never add "And"
  let s = t.replace(/\b(responsible for|duties included)\b/i, "");
  // Integrate 1–2 JD tokens as a method clause (no fabricated metrics)
  const picks = jdTokens.slice(0, 2).filter(Boolean);
  const chunk = picks.length === 2 ? `${picks[0]} and ${picks[1]}` : (picks[0] || "");
  if (chunk) {
    const join = chooseDelim(chunk.split(/\s+/).length, STATE.bridgeStyle, STATE.dashThreshold);
    s = s.replace(/[.!?]\s*$/, "");
    s = `${s}${join}leveraging ${chunk}.`;
  }
  return s.replace(/\s+/g, " ").trim();
}

function proposeRewritesForDocument() {
  const cands = candidateBullets();
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
  item.addEventListener("click", (e) => {
    const placements = Math.max(1, Math.min(5, parseInt(els.placements?.value || "1", 10) || 1));
    const placed = weavePhraseIntoMultiple(clause, why, category, e.shiftKey ? Math.max(2, placements) : placements);
    if (placed === 0) appendNewBulletAfterEducation(clause, why);
    refreshCoverage();
  });
  els.suggestions.appendChild(item);
}

// Build a ban list for the miner: company, location, and EEO/benefits tokens already in STOP.
function jdBanlist() {
  const out = [];
  const pushTokens = (s) => (s || "").toLowerCase().replace(/[^a-z0-9+./ -]+/g," ").split(/\s+/).forEach(w => { if (w && !STOP.has(w)) out.push(w); });
  pushTokens(els.jdCompany?.value || "");
  pushTokens(els.jdLocation?.value || "");
  // Small extras that frequently appear as garbage targets but we don't want as skills
  out.push("reasonable","accommodations","accommodation","qualified","individuals","employment","applicants","employer","benefits","salary","compensation");
  return out;
}

function buildLocalSuggestions() {
  els.suggestions.innerHTML = "";
  const allowed = (STATE.profile.skills || []).concat(STATE.profile.titles || []);
  STATE.jdTargets = smartJDTargets(norm(els.jdText.value), allowed, jdBanlist()).slice(0, 18);

  if (!STATE.jdTargets.length) {
    els.suggestions.textContent = "Suggestions appear after you paste a JD.";
    return;
  }

  for (const t of STATE.jdTargets) {
    const clause = bridgeForToken(t.display, t.category, STATE.bridgeStyle, STATE.dashThreshold).replace(/^[,—–]\s*/, "");
    const why = `Tailored for JD keyword: ${t.display}`;
    const label = `• <strong>${t.display}</strong> <span class="small muted">(${t.category})</span><br/><span class="small">Weave: <code>${clause}</code> <span class="pill">local</span></span>`;
    renderSuggestionItem({labelHTML: label, clause, category: t.category, why});
    // metric‑ready templates
    for (const tpl of templatesForSkill(t.display)) {
      const labelTpl = `• ${tpl.replace(/\[.*?\]/g, '<span class="muted">[fill]</span>')} <span class="small pill">template</span>`;
      renderSuggestionItem({labelHTML: labelTpl, clause: tpl, category: t.category, why: `Metric‑ready template for ${t.display}`});
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
      job_title:    norm(els.jdTitle?.value || ""),
      job_company:  norm(els.jdCompany?.value || ""),
      job_description: norm(els.jdText.value),
      resume_plain: text(els.editor),
      allowed_vocab: (STATE.profile.skills || []).concat(STATE.profile.titles || []),
      wanted: 10
    };
    const { data, error } = await sb.functions.invoke("power-edit-suggest", { body: payload });
    if (error || !data) return;

    const clauses = Array.isArray(data?.clauses) ? data.clauses : [];
    STATE.serverPhrases = clauses.filter(it => it?.clause).slice(0, 12);

    for (const it of STATE.serverPhrases) {
      const clause = String(it.clause).trim();
      const label = `• <strong>${clause}</strong><br/><span class="small">Weave: <code>${clause}</code> <span class="pill">server</span></span>`;
      renderSuggestionItem({labelHTML: label, clause, category: "other", why: "Server‑suggested clause (Edge Function)"});
    }
  } catch { /* silent fallback */ }
}

/* -------------------- Coverage / Score -------------------- */

function refreshCoverage() {
  const jd = norm(els.jdText.value);
  const resumePlain = text(els.editor);
  if (!jd || !resumePlain) return;

  const cov = jdCoverageAgainstResume(jd, resumePlain, jdBanlist());
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

/* -------------------- Import / Export -------------------- */

async function importDocx(file) {
  const buf = await file.arrayBuffer();
  // Mammoth browser API: convertToHtml({ arrayBuffer }) returns { value: "<html ...>" }
  const result = await window.mammoth.convertToHtml({ arrayBuffer: buf });
  els.editor.innerHTML = result.value || "";
  refreshCoverage();
  await hydrateProfileAndSuggestions(); // rank with profile skills
}
function exportDocx() {
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>${els.editor.innerHTML}</body></html>`;
  // htmlDocx.asBlob(html) -> Blob for download (library usage widely documented).
  const blob = window.htmlDocx.asBlob(html);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "tailored_resume.docx";
  a.click();
}

/* -------------------- UI wiring -------------------- */

function updateAutoHint() {
  const hasJD = norm(els.jdText.value).length > 0;
  const hasResume = norm(text(els.editor)).length > 0;
  els.btnAuto.disabled = !(hasJD && hasResume);
  els.autoHint.textContent = els.btnAuto.disabled ? "Paste a JD and load/paste your resume to enable Auto‑tailor." : "";
}

els.jdText.addEventListener("input", async () => { await buildAllSuggestions(); refreshCoverage(); updateAutoHint(); });
els.editor.addEventListener("input", () => { refreshCoverage(); updateAutoHint(); });

els.btnUndo.addEventListener("click", () => { undoLast(); });
els.btnClear.addEventListener("click", () => { clearAllInserts(); });

els.btnAuto.addEventListener("click", async () => {
  // Prefer server phrases; then local bridges
  const candidateClauses = []
    .concat((STATE.serverPhrases || []).map(p => p.clause))
    .concat((STATE.jdTargets || []).map(t => bridgeForToken(t.display, t.category, STATE.bridgeStyle, STATE.dashThreshold).replace(/^[,—–]\s*/, "")))
    .filter(Boolean);

  const placements = Math.max(1, Math.min(5, parseInt(els.placements?.value || "2", 10) || 2));
  let applied = 0;
  for (const clause of candidateClauses.slice(0, 10)) {
    applied += weavePhraseIntoMultiple(clause, "Auto‑tailor insert", "other", placements);
  }
  if (applied === 0 && candidateBullets().length === 0 && candidateClauses.length) {
    appendNewBulletAfterEducation(candidateClauses[0], "Auto‑tailor insert");
  }
  refreshCoverage();

  // Show rewrite ideas in console (non‑destructive)
  const rewrites = proposeRewritesForDocument().slice(0, 3);
  if (rewrites.length) console.info("Rewrite suggestions:", rewrites.map(r => `– ${r.afterText}`).join("\n"));
});

els.file?.addEventListener("change", (e) => { const f = e.target.files[0]; if (f) importDocx(f); });
els.btnExport?.addEventListener("click", exportDocx);
els.btnPrint?.addEventListener("click", () => window.print());

/* -------------------- Bootstrap -------------------- */

async function hydrateProfileAndSuggestions() {
  try {
    const sb = await supabaseClient();
    if (!sb) { STATE.serverOk = false; await buildAllSuggestions(); return; }
    const user = await getUser(sb);
    if (!user) { STATE.serverOk = false; await buildAllSuggestions(); return; }
    STATE.profile = await fetchProfile(sb, user);
    STATE.serverOk = true;
    if (els.modeBadge) els.modeBadge.textContent = "Signed in (server boost)";
  } catch { STATE.serverOk = false; }
  await buildAllSuggestions();
}

async function buildAllSuggestions() {
  // read UI controls
  STATE.bridgeStyle = (els.joiner?.value || "auto");
  const dt = parseInt(els.joiner?.dataset?.dashThreshold || "7", 10);
  if (dt) STATE.dashThreshold = dt;
  STATE.maxPerBullet = Math.max(1, Math.min(3, parseInt(els.maxPerBullet?.value || "1", 10) || 1));
  STATE.perBulletBudget = new WeakMap(); // reset budget on each rebuild

  els.suggestions.innerHTML = "";
  buildLocalSuggestions();
  await buildServerSuggestions();
}

(function init() {
  // user‑configurable joiner/placements
  STATE.bridgeStyle = (els.joiner?.value || "auto");
  const dt = parseInt(els.joiner?.dataset?.dashThreshold || "7", 10); if (dt) STATE.dashThreshold = dt;

  els.joiner?.addEventListener("change", () => { STATE.bridgeStyle = els.joiner.value; buildAllSuggestions(); });
  els.placements?.addEventListener("change", () => {/* nothing to cache */});
  els.maxPerBullet?.addEventListener("change", () => { STATE.maxPerBullet = Math.max(1, Math.min(3, parseInt(els.maxPerBullet.value || "1", 10) || 1)); });

  updateAutoHint();
  hydrateProfileAndSuggestions();
  refreshCoverage();
})();
