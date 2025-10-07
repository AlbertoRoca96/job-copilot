/* docs/js/power-edit.js
 * Power Edit (client). Rewritten so “Auto-tailor” WEAVES compact JD phrases
 * into the most appropriate existing bullet *after Education*, never into
 * Education/References. Undo + Clear supported. Jobscan UI preserved.
 */

import {
  smartJDTargets,
  bridgeForToken,
  explainGaps,
  jdCoverageAgainstResume,
  CUE_SETS
} from "./scoring.js?v=2025-10-07-1";

// ---------- DOM ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const els = {
  editor:       $("#editor"),
  jdTitle:      $("#job_title"),
  jdCompany:    $("#job_company"),
  jdLocation:   $("#job_location"),
  jdText:       $("#job_desc"),
  profile:      $("#profile_json"),
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
};

// ---------- State ----------
const STATE = {
  jd: "",
  jdTargets: [],         // [{token, display, category}]
  resumeHTML: "",
  inserts: [],           // [{node, beforeHTML, afterHTML, phrase, why}]
  lastRun: 0,
  bridgeStyle: "dash",
  dashThreshold: 7
};

// ---------- Utils ----------
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
  // Treat headings, paragraphs, list items as “blocks”
  return $$("#editor h1, #editor h2, #editor h3, #editor h4, #editor p, #editor li, #editor div");
}

// Section detection mirrors server logic: prefer an Experience header,
// otherwise start immediately *after* Education.
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
  const { blocks: blocks1, ranges: r1 } = findSectionRanges([...EXP_TITLES, ...EDU_TITLES]);
  for (const name of EXP_TITLES.map(t => t.toLowerCase())) {
    if (r1.has(name)) return r1.get(name)[0];
  }
  const { blocks, range } = educationRange();
  if (range) return range[1]; // immediately after Education
  return Math.min(paraNodesInEditor().length, 8); // skip header block
}

function isReferenceLine(n) {
  const t = text(n).toLowerCase();
  return t.includes("references") && (t.includes("request") || t.includes("available"));
}

function inEducation(i) {
  const { range } = educationRange();
  return !!(range && i >= range[0] && i < range[1]);
}

// Candidates to weave into: list items after workStart, outside Education/References.
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
  // general action verbs nudge
  if (/(develop|build|design|implement|optimiz|maintain|improv|migrat|deploy|integrat)/i.test(t)) score += 1;
  // prefer non‑short bullets
  if (t.length > 60) score += 1;
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

// Compute prefix & final inserted HTML (diff highlighted)
function buildInsertionHTML(hostNode, clause, style = "dash", dashThreshold = 7) {
  const before = hostNode.innerHTML;
  const plain = text(hostNode);
  if (!plain) return null;

  // if clause already present, skip
  if (plain.toLowerCase().includes(clause.toLowerCase())) return null;

  const endsWithPeriod = /[.!?]\s*$/.test(plain);
  const words = clause.trim().split(/\s+/).length;
  const delim = (style === "comma") ? ", " : (style === "auto" ? (words >= dashThreshold ? " — " : ", ") : " — ");

  // If the bullet already ends with punctuation, start a new sentence.
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

// Apply a single weave to the best bullet in context
function weavePhraseIntoResume(phrase, why, category) {
  const host = bestBullet(category);
  if (!host) return false;

  const ins = buildInsertionHTML(host, phrase, STATE.bridgeStyle, STATE.dashThreshold);
  if (!ins) return false;

  host.classList.add("auto-insert");
  host.dataset.before = ins.beforeHTML;
  host.innerHTML = ins.afterHTML;

  // tiny “why?” pill
  const btn = document.createElement("button");
  btn.textContent = "?";
  btn.className = "secondary small";
  btn.style.marginLeft = "6px";
  btn.title = why || "Keyword from the job description";
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    alert(why || "Inserted to align with JD keywords.");
  });
  host.appendChild(btn);

  STATE.inserts.push({ node: host, beforeHTML: ins.beforeHTML, afterHTML: host.innerHTML, phrase, why });
  els.btnUndo.disabled = els.btnClear.disabled = STATE.inserts.length === 0;
  return true;
}

function undoLast() {
  const item = STATE.inserts.pop();
  if (!item) return;
  item.node.innerHTML = item.beforeHTML;
  item.node.classList.remove("auto-insert");
  delete item.node.dataset.before;
  els.btnUndo.disabled = els.btnClear.disabled = STATE.inserts.length === 0;
}

function clearAllInserts() {
  while (STATE.inserts.length) undoLast();
}

// ---------- Suggestions (Jobscan-style UI, weave on click) ----------
function buildSuggestions() {
  const jd = norm(els.jdText.value);
  const allowed = []; // could be extended with profile skills
  STATE.jdTargets = smartJDTargets(jd, allowed).slice(0, 16);

  els.suggestions.innerHTML = "";
  if (!STATE.jdTargets.length) {
    els.suggestions.textContent = "Suggestions appear after you paste a JD.";
    return;
  }

  for (const t of STATE.jdTargets) {
    const item = document.createElement("div");
    item.className = "suggestion";
    const clause = bridgeForToken(t.display, t.category, STATE.bridgeStyle, STATE.dashThreshold).replace(/^[,—–]\s*/, "");
    item.innerHTML = `• <strong>${t.display}</strong> <span class="small muted">(${t.category})</span><br/><span class="small">Weave: <code>${clause}</code></span>`;
    item.addEventListener("click", () => {
      const why = `Tailored for JD keyword: ${t.display}`;
      const ok = weavePhraseIntoResume(clause, why, t.category);
      if (!ok) {
        // If no suitable bullet, append *one* new bullet below Education as a last resort.
        appendNewBulletAfterEducation(clause, why);
      }
      refreshCoverage();
    });
    els.suggestions.appendChild(item);
  }
}

// Fallback: create a single new bullet in the proper area (only when no host bullet exists)
function appendNewBulletAfterEducation(clause, why) {
  const blocks = paraNodesInEditor();
  const start = workStartIndex();

  // find nearest UL/OL after start
  let targetList = null;
  for (let i = start; i < blocks.length; i++) {
    const n = blocks[i];
    if (n.closest && (n.closest("ul,ol"))) { targetList = n.closest("ul,ol"); break; }
    if (n.tagName && (n.tagName.toLowerCase() === "ul" || n.tagName.toLowerCase() === "ol")) { targetList = n; break; }
  }
  if (!targetList) {
    // create a fresh UL just after the starting block
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

// ---------- Coverage / Score ----------
function refreshCoverage() {
  const jd = norm(els.jdText.value);
  const resumePlain = text(els.editor);
  if (!jd || !resumePlain) return;

  const cov = jdCoverageAgainstResume(jd, resumePlain);
  const score = Math.round((cov.hits.length / (cov.hits.length + cov.misses.length || 1)) * 100);
  els.scoreline.textContent = `Score: ${isFinite(score) ? score : 0}`;

  // gaps
  els.gaps.innerHTML = "";
  if (cov.misses.length) {
    const frag = document.createElement("div");
    frag.innerHTML = cov.misses.slice(0, 40).map(w => `<span class="k miss">${w}</span>`).join(" ");
    els.gaps.appendChild(frag);
  } else {
    els.gaps.textContent = "Nice—no obvious gaps found yet.";
  }

  // coverage
  els.coverage.innerHTML = [
    `<div class="small">Hits: ${cov.hits.slice(0, 40).map(w => `<span class="k hit">${w}</span>`).join(" ") || "—"}</div>`,
    `<div class="small">Misses: ${cov.misses.slice(0, 40).map(w => `<span class="k miss">${w}</span>`).join(" ") || "—"}</div>`
  ].join("");
}

// ---------- DOCX Import/Export (unchanged APIs) ----------
/* Mammoth converts .docx to HTML in browser:
   mammoth.convertToHtml({ arrayBuffer }).then(...)
*/
async function importDocx(file) {
  const buf = await file.arrayBuffer();
  const result = await window.mammoth.convertToHtml({ arrayBuffer: buf });
  els.editor.innerHTML = result.value || "";
  STATE.resumeHTML = els.editor.innerHTML;
  refreshCoverage();
  buildSuggestions();
}
/* html-docx-js turns HTML to a Blob(.docx): htmlDocx.asBlob(html) */
function exportDocx() {
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>${els.editor.innerHTML}</body></html>`;
  const blob = window.htmlDocx.asBlob(html);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "tailored_resume.docx";
  a.click();
}

// ---------- Wire up ----------
function updateAutoHint() {
  const hasJD = norm(els.jdText.value).length > 0;
  const hasResume = norm(text(els.editor)).length > 0;
  els.btnAuto.disabled = !(hasJD && hasResume);
  els.autoHint.textContent = els.btnAuto.disabled
    ? "Paste a JD and load/paste your resume to enable Auto‑tailor."
    : "";
}

els.jdText.addEventListener("input", () => { buildSuggestions(); refreshCoverage(); updateAutoHint(); });
els.editor.addEventListener("input", () => { refreshCoverage(); updateAutoHint(); });

els.btnUndo.addEventListener("click", undoLast);
els.btnClear.addEventListener("click", clearAllInserts);

// Auto‑tailor: weave top N suggestions to the best bullets (no new bullets unless no host exists)
els.btnAuto.addEventListener("click", () => {
  const topN = Math.min(6, STATE.jdTargets.length || 0);
  let applied = 0;
  for (let i = 0; i < topN; i++) {
    const t = STATE.jdTargets[i];
    const clause = bridgeForToken(t.display, t.category, STATE.bridgeStyle, STATE.dashThreshold).replace(/^[,—–]\s*/, "");
    const why = `Tailored for JD keyword: ${t.display}`;
    const ok = weavePhraseIntoResume(clause, why, t.category);
    if (ok) applied++;
  }
  if (!applied && topN > 0) {
    const t = STATE.jdTargets[0];
    appendNewBulletAfterEducation(bridgeForToken(t.display, t.category, STATE.bridgeStyle, STATE.dashThreshold).replace(/^[,—–]\s*/, ""), `Tailored for JD keyword: ${t.display}`);
  }
  refreshCoverage();
});

els.file?.addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f) importDocx(f);
});
els.btnExport?.addEventListener("click", exportDocx);
els.btnPrint?.addEventListener("click", () => window.print());

// Initial
updateAutoHint();
buildSuggestions();
refreshCoverage();
