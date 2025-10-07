/* docs/js/power-edit.js
 * Power Edit (live) — multi-placement weaving, natural mid-sentence joins,
 * smarter JD targets, and secure server suggestions via your Edge Function.
 */

import {
  smartJDTargets,
  bridgeForToken,
  jdCoverageAgainstResume,
  templatesForSkill,
  assessWeakness,
  CUE_SETS
} from "./scoring.js?v=2025-10-13-3";

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
  joiner:       $("#joiner_style")
};

/* -------------------- State -------------------- */

const STATE = {
  profile: { skills: [], titles: [] },
  jdTargets: [],
  serverPhrases: [],           // {clause, jd_cues[], bullet_cues[]}
  inserts: [],                 // [{node, beforeHTML, afterHTML, phrase, why}]
  bridgeStyle: "auto",
  dashThreshold: 7,
  serverOk: false
};

const MAX_INS_PER_NODE = 2;

/* -------------------- Supabase -------------------- */

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
const text = (n) => norm(n?.textContent || "");

function sentenceCase(s) {
  for (let i = 0; i < s.length; i++) { const ch = s[i]; if (/[A-Za-z]/.test(ch)) return s.slice(0,i) + ch.toUpperCase() + s.slice(i+1); }
  return s;
}

function paraNodesInEditor() {
  return $$("#editor h1, #editor h2, #editor h3, #editor h4, #editor p, #editor li, #editor div");
}

/* -------------------- Section detection & guards -------------------- */

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
  const titles = [...EDU_TITLES, ...EXP_TITLES, "skills","technical skills","core skills","projects","certifications","awards","summary","professional summary","publications","volunteer experience","research experience","activities","leadership"];
  const { blocks, ranges } = findSectionRanges(titles);
  for (const k of EDU_TITLES.map(t => t.toLowerCase())) { if (ranges.has(k)) return { blocks, range: ranges.get(k) }; }
  return { blocks, range: null };
}
function inEducation(i) { const { range } = educationRange(); return !!(range && i >= range[0] && i < range[1]); }

function isReferenceLine(n) {
  const t = text(n).toLowerCase();
  return t.includes("references") && (t.includes("request") || t.includes("available"));
}
function isRoleHeaderLine(n) {
  const t = text(n);
  // Heuristic: contains month or 4-digit year + a dash, and no period at end
  const month = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/i.test(t);
  const year  = /\b20\d{2}\b/.test(t);
  const dash  = /[-–—]\s*/.test(t);
  const endPunct = /[.!?]\s*$/.test(t);
  return (month || year) && dash && !endPunct;
}

/* -------------------- Candidate bullets -------------------- */

function candidateBullets() {
  const blocks = paraNodesInEditor();
  const { range } = educationRange();
  const start = (() => {
    const { ranges } = findSectionRanges([...EXP_TITLES, ...EDU_TITLES]);
    for (const name of EXP_TITLES.map(t => t.toLowerCase())) if (ranges.has(name)) return ranges.get(name)[0];
    return range ? range[1] : Math.min(blocks.length, 8);
  })();

  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    if (i < start) continue;
    if (inEducation(i)) continue;
    const n = blocks[i];
    const tag = n.tagName?.toLowerCase() || "";
    const isLI = tag === "li";
    const longP = (tag === "p" || tag === "div") && text(n).length >= 25;
    if (!isLI && !longP) continue;
    if (!text(n)) continue;
    if (isReferenceLine(n)) continue;
    if (isRoleHeaderLine(n)) continue;
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
  if (t.length > 60) score += 1;
  return score;
}
function insCount(node) { return (node.querySelectorAll?.("span.ins").length) || 0; }

function pickBestBullets(category, count = 1, exclude = new Set()) {
  const cands = candidateBullets()
    .filter(c => insCount(c.node) < MAX_INS_PER_NODE && !exclude.has(c.node));
  const scored = cands
    .map(c => ({ node: c.node, score: scoreBulletForCategory(text(c.node), category) }))
    .filter(x => x.score > 0);
  scored.sort((a,b) => b.score - a.score);
  return scored.slice(0, Math.max(1, count)).map(s => s.node);
}

/* -------------------- Insertion helpers -------------------- */

function chooseDelim(words, style, dashThreshold) {
  return (style === "comma") ? ", " : (style === "dash") ? " — " : (words >= dashThreshold ? " — " : ", ");
}
function sanitizeClause(c) {
  // strip leading conjunctions/prepositions; drop leading punctuation; trim
  return String(c || "").replace(/^\s*(?:and|or|but|so|yet|plus|also|by|using|via|through|including|that|which)\b[,\s—–-]*/i, "")
                        .replace(/^[,\s—–-]+/, "")
                        .replace(/\s+/g, " ").trim();
}
function lastNonSpaceChar(str, idx) {
  for (let i = idx - 1; i >= 0; i--) { const ch = str[i]; if (!/\s/.test(ch)) return ch; }
  return "";
}
function looksVerbish(s) {
  const first = (s.split(/\s+/)[0] || "").toLowerCase();
  return /(ing|ed)$/.test(first) || /^(build|built|design|ship|shipped|launch|launched|integrate|integrated|migrate|migrated|automate|reduce|improve|drive|drove|develop|developed|implement|implemented|optimize|optimized|scale|scaled|lead|led)$/.test(first);
}
function normalizeBodyForBridge(body, category) {
  // If noun-ish, add a category preposition; if verb-ish, keep as-is.
  if (looksVerbish(body)) return body;
  const prep =
    category === "cloud"    ? "on"  :
    category === "devops"   ? "via" :
    category === "analytics"? "for" :
                               "with";
  return `${prep} ${body}`;
}
function cutpoints(plain) {
  // candidate cutpoints after sensible joiners/punct
  const pts = [];
  const re = /\b(using|with|via|through|for|which|that|including)\b|[,;:—–]/gi;
  let m; while ((m = re.exec(plain)) !== null) pts.push(m.index + m[0].length);
  return pts;
}

function insertAt(hostNode, idx, insertText) {
  const beforeHTML = hostNode.innerHTML;
  const plain = text(hostNode);
  if (!plain) return null;

  const left  = plain.slice(0, idx);
  const right = plain.slice(idx);
  const esc = (s) => s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  hostNode.innerHTML = esc(left) + `<span class="ins">${insertText}</span>` + esc(right);
  return { beforeHTML, afterHTML: hostNode.innerHTML, insertedText: insertText };
}

function buildInsertion(hostNode, rawClause, category = "other", style = "auto", dashThreshold = 7) {
  const plain = text(hostNode);
  if (!plain) return null;

  let body = sanitizeClause(rawClause);
  if (!body) return null;
  const lc = plain.toLowerCase();
  if (lc.includes(body.toLowerCase())) return null;

  // If noun phrase, apply category prep so we don't rely on "and"
  body = normalizeBodyForBridge(body, category);

  const words = body.split(/\s+/).length;
  const delim = chooseDelim(words, style, dashThreshold);

  // Prefer last sensible breakpoint
  const cps = cutpoints(plain);
  if (cps.length) {
    const cut = cps[cps.length - 1];
    const prev = lastNonSpaceChar(plain, cut);
    const needsDelim = !(prev === "," || prev === "—" || prev === "–");
    const ins = (needsDelim ? delim : " ") + body;
    return insertAt(hostNode, cut, ins);
  }

  // Otherwise new sentence; never “And …”
  const endsWithPeriod = /[.!?]\s*$/.test(plain);
  if (endsWithPeriod) {
    const s = " " + sentenceCase(body) + (/[.!?]$/.test(body) ? "" : ".");
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

function weaveOnce(hostNode, clause, why, category) {
  const ins = buildInsertion(hostNode, clause, category, STATE.bridgeStyle, STATE.dashThreshold);
  if (!ins) return false;
  hostNode.classList.add("auto-insert");
  hostNode.dataset.before = ins.beforeHTML;

  const btn = document.createElement("button");
  btn.textContent = "?"; btn.className = "secondary small"; btn.style.marginLeft = "6px";
  btn.title = why || "Keyword from the job description";
  btn.addEventListener("click", (e) => { e.preventDefault(); alert(why || "Inserted to align with JD keywords."); });
  hostNode.appendChild(btn);

  STATE.inserts.push({ node: hostNode, beforeHTML: ins.beforeHTML, afterHTML: hostNode.innerHTML, phrase: clause, why });
  return true;
}

function weavePhraseIntoMultiple(phrase, why, category, maxPlacements = 2) {
  const placedIn = new Set();
  let placed = 0;
  for (const node of pickBestBullets(category, maxPlacements)) {
    if (placedIn.has(node)) continue;
    const ok = weaveOnce(node, phrase, why, category);
    if (ok) { placedIn.add(node); placed++; }
    if (placed >= maxPlacements) break;
  }
  return placed;
}

function appendNewBulletAfterEducation(clause, why) {
  const blocks = paraNodesInEditor();
  const { range } = educationRange();
  const start = (() => {
    const { ranges } = findSectionRanges([...EXP_TITLES, ...EDU_TITLES]);
    for (const name of EXP_TITLES.map(t => t.toLowerCase())) if (ranges.has(name)) return ranges.get(name)[0];
    return range ? range[1] : Math.min(blocks.length, 8);
  })();

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
  li.innerHTML = `<span class="ins">• ${normalizeBodyForBridge(clean, "other")}</span>`;

  const btn = document.createElement("button");
  btn.textContent = "?"; btn.className = "secondary small"; btn.style.marginLeft = "6px";
  btn.title = why || "Keyword from the job description";
  btn.addEventListener("click", e => { e.preventDefault(); alert(why || "Inserted to align with JD keywords."); });
  li.appendChild(btn);

  targetList.appendChild(li);
  STATE.inserts.push({ node: li, beforeHTML: "", afterHTML: li.innerHTML, phrase: clean, why });
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

/* -------------------- Rewrites (console preview) -------------------- */

function safeRewrite(textLine, jdTokens = []) {
  const t = norm(textLine).replace(/^\u2022\s*/, "");
  if (!t) return t;
  let s = t.replace(/\b(responsible for|duties included)\b/i, "");
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
    const placements = Math.max(1, Math.min(5, parseInt(els.placements?.value || "2", 10) || 2));
    const placed = weavePhraseIntoMultiple(clause, why, category, e.shiftKey ? Math.max(2, placements) : placements);
    if (placed === 0) appendNewBulletAfterEducation(clause, why);
    refreshCoverage();
  });
  els.suggestions.appendChild(item);
}

function buildLocalSuggestions() {
  els.suggestions.innerHTML = "";
  const allowed = (STATE.profile.skills || []).concat(STATE.profile.titles || []);
  STATE.jdTargets = smartJDTargets(norm(els.jdText.value), allowed).slice(0, 18);

  if (!STATE.jdTargets.length) {
    els.suggestions.textContent = "Suggestions appear after you paste a JD.";
    return;
  }

  for (const t of STATE.jdTargets) {
    const clause = bridgeForToken(t.display, t.category, STATE.bridgeStyle, STATE.dashThreshold).replace(/^[,—–]\s*/, "");
    const why = `Tailored for JD keyword: ${t.display}`;
    const label = `• <strong>${t.display}</strong> <span class="small muted">(${t.category})</span><br/><span class="small">Weave: <code>${clause}</code> <span class="pill">local</span></span>`;
    renderSuggestionItem({labelHTML: label, clause, category: t.category, why});
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

/* -------------------- Import / Export -------------------- */

async function importDocx(file) {
  const buf = await file.arrayBuffer();
  const result = await window.mammoth.convertToHtml({ arrayBuffer: buf });
  els.editor.innerHTML = result.value || "";
  refreshCoverage();
  await hydrateProfileAndSuggestions();
}
function exportDocx() {
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>${els.editor.innerHTML}</body></html>`;
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
  const candidateClauses = []
    .concat((STATE.serverPhrases || []).map(p => p.clause))
    .concat((STATE.jdTargets || []).map(t => bridgeForToken(t.display, t.category, STATE.bridgeStyle, STATE.dashThreshold).replace(/^[,—–]\s*/, "")))
    .filter(Boolean);

  const placements = Math.max(1, Math.min(5, parseInt(els.placements?.value || "2", 10) || 2));
  let applied = 0;
  for (const clause of candidateClauses.slice(0, 8)) {
    applied += weavePhraseIntoMultiple(clause, "Auto‑tailor insert", "other", placements);
  }
  if (applied === 0 && candidateBullets().length === 0 && candidateClauses.length) {
    appendNewBulletAfterEducation(candidateClauses[0], "Auto‑tailor insert");
  }
  refreshCoverage();

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
  els.suggestions.innerHTML = "";
  buildLocalSuggestions();
  await buildServerSuggestions();
}

(function init() {
  STATE.bridgeStyle = (els.joiner?.value || "auto");
  els.joiner?.addEventListener("change", () => { STATE.bridgeStyle = els.joiner.value; });
  const dt = parseInt(els.joiner?.dataset?.dashThreshold || "7", 10); if (dt) STATE.dashThreshold = dt;

  updateAutoHint();
  hydrateProfileAndSuggestions();
  refreshCoverage();
})();
