/* docs/js/power-edit.js
   Power Edit (client). New auto‑tailor = in‑place rewrites below Education,
   mirroring src/tailor/resume.py heuristics.
*/
import {
  CONFIG,
  canon, normalizeWS, tokenize, tokenSet,
  topJDKeywords, coverageAgainstResume, suggestionBullets, stripHtml
} from './scoring.js?v=2025-10-07-4';

// ---------- config mirrors (keep in sync with server defaults) ----------
const MID_STYLE   = CONFIG.MID_SENTENCE_STYLE;   // 'dash' | 'comma' | 'auto'
const DASH_THRESH = CONFIG.DASH_THRESHOLD;       // words
const CAP_SENT    = true;
const END_PERIOD  = true;

// ---------- minor CSS + toggle injected at runtime ----------
injectStyles();
injectDiffToggle();

// ---------- DOM helpers ----------
const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];
const editor = $('#editor');
const jdEl   = $('#job_desc');
const profileEl = $('#profile_json');

function readProfile(){
  try { return JSON.parse(profileEl.value || '{}') || {}; } catch{ return {}; }
}

function getResumeHTML(){ return editor.innerHTML || ''; }
function setResumeHTML(html){ editor.innerHTML = html; }
function resumeText(){ return stripHtml(getResumeHTML()); }

function nonEmpty(s){ return !!normalizeWS(s); }

// ---------- Section detection (HTML, not .docx) ----------
const EDU_TITLES = [
  'education','education and training','education & training',
  'academic credentials','academics','education and honors'
];
const EXP_TITLES = [
  'work experience','experience','professional experience','employment','relevant experience'
];
const OTHER_SECTION_TITLES = [
  'skills','technical skills','core skills','projects','certifications','awards',
  'volunteer experience','writing experience','summary','professional summary',
  'publications','research experience','activities','leadership'
];

function isHeaderEl(el){
  if (!el) return false;
  const name = el.tagName.toLowerCase();
  if (/^h[1-6]$/.test(name)) return true;
  // plain <p> section titles: text only, short, no punctuation
  if (name === 'p') {
    const t = normalizeWS(el.textContent || '');
    return t.length>=3 && t.length<=48 && /^[A-Za-z &/]+$/.test(t);
  }
  return false;
}

function findSectionRanges(container){
  const nodes = $$('#editor *'); // linear order
  const lower = nodes.map(n => normalizeWS(n.textContent||'').toLowerCase());
  const hits = [];
  nodes.forEach((n,i)=>{
    if (!isHeaderEl(n)) return;
    const t = normalizeWS(n.textContent||'').toLowerCase();
    if (EDU_TITLES.includes(t) || EXP_TITLES.includes(t) || OTHER_SECTION_TITLES.includes(t)) {
      hits.push({i, t});
    }
  });
  const ranges = {}; // {title:[start,end)}
  for (let k=0;k<hits.length;k++){
    const start = hits[k].i;
    const title = hits[k].t;
    const end = (k+1 < hits.length) ? hits[k+1].i : nodes.length;
    ranges[title] = [start, end];
  }
  return { nodes, ranges };
}

function educationRange(){
  const {ranges} = findSectionRanges(editor);
  for (const t of EDU_TITLES) if (ranges[t]) return ranges[t];
  return null;
}
function experienceStart(){
  const {ranges} = findSectionRanges(editor);
  for (const t of EXP_TITLES) if (ranges[t]) return ranges[t][0];
  const er = educationRange();
  if (er) return er[1];           // start just AFTER Education
  // else skip header/current-contact region
  return Math.min($$('#editor *').length, 80);
}

function isReferenceOrContactLine(text){
  const s = (text||'').toLowerCase();
  if (/references/.test(s) && /available/.test(s)) return true;
  if (/\b(?:linkedin|github|portfolio)\b/.test(s)) return true;
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(s)) return true;
  if (/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/.test(s)) return true;
  return false;
}

function afterEducationNodeList(){
  // find the first UL/OL after Education to use when inserting *new* lines
  const {nodes} = findSectionRanges(editor);
  const start = experienceStart();
  for (let i=start; i<nodes.length; i++){
    const el = nodes[i];
    if (el.closest && el.closest('#editor') && (el.tagName==='UL' || el.tagName==='OL')) return el;
  }
  // fallback: last list in the document
  const lists = $$('ul,ol', editor);
  return lists.length ? lists[lists.length-1] : null;
}

// ---------- Candidate bullets ----------
function liLikeNodesAfterExperience(){
  const nodes = $$('#editor *');
  const start = experienceStart();
  const out = [];

  for (let i=start; i<nodes.length; i++){
    const el = nodes[i];
    if (!(el instanceof HTMLElement)) continue;
    // Skip anything visibly inside the Education range (guard)
    const txt = normalizeWS(el.textContent||'');
    if (!txt) continue;
    if (isReferenceOrContactLine(txt)) continue;

    const tag = el.tagName;
    const bulletishPara = (tag==='P' && /^[•\-–—·]/.test((el.textContent||'').trim()));
    const isLi = (tag==='LI');
    if ((isLi || bulletishPara) && txt.length >= 25){
      out.push(el);
    }
  }
  return out;
}

// ---------- Bridge construction (mirror Python logic) ----------
const LEADS_KEEP = ['to ','for '];
const STRIP_LEADS = ['using ','with ','via ','through ','by ','while ','as ','as part of ','in order to ','in accordance with ','per '];
const GERUNDS = ['managing','coordinating','handling','scheduling','maintaining','performing','providing','ensuring','tracking','verifying','triaging','documenting','updating','supporting','resolving'];

function sentenceCase(s){
  for (let i=0;i<s.length;i++){
    if (/[A-Za-z]/.test(s[i])) return s.slice(0,i) + s[i].toUpperCase() + s.slice(i+1);
  }
  return s;
}
function chooseMidDelim(bridge){
  if (MID_STYLE === 'comma') return ', ';
  if (MID_STYLE === 'dash')  return ' — ';
  const n = (bridge||'').trim().split(/\s+/).length;
  return (n >= DASH_THRESH) ? ' — ' : ', ';
}

function bridgePhrase(raw){
  let p = canon(String(raw||'').trim());
  p = p.replace(/[.\s]+$/,'');
  let low = p.toLowerCase();

  for (const lead of STRIP_LEADS){
    if (low.startsWith(lead)){ p = p.slice(lead.length); low = p.toLowerCase(); break; }
  }
  for (const keep of LEADS_KEEP){
    if (low.startsWith(keep)) return p;
  }
  if (GERUNDS.some(g => low.startsWith(g+' '))) return `by ${p}`;
  return `with ${p}`;
}

function safeJoinKeywords(kws){
  const ks = [...new Set((kws||[]).map(k=>canon(k).trim()).filter(Boolean))];
  if (!ks.length) return '';
  if (ks.length===1) return ks[0];
  if (ks.length===2) return `${ks[0]} and ${ks[1]}`;
  return `${ks.slice(0,-1).join(', ')}, and ${ks[ks.length-1]}`;
}

function contextualPrefix(before, bridge){
  const trimmed = before.replace(/\s+$/,'');
  const prev = trimmed.slice(-1);
  const endsWithJoiner = /[,;:—–-]$/.test(trimmed) || /\b(?:and|or)$/.test(trimmed.toLowerCase());
  if (/[.?!]$/.test(trimmed)) {
    let core = bridge;
    if (CAP_SENT) core = sentenceCase(core);
    return ' ' + core + (END_PERIOD && !/[.]$/.test(core) ? '.' : '');
  }
  if (endsWithJoiner) return ' ' + bridge;
  return chooseMidDelim(bridge) + bridge;
}

// ---------- First-person sanitizer ----------
function depersonalizeLine(s){
  let out = s || '';
  // strip leading I/We + common contractions
  out = out.replace(/^\s*(?:•\s*)?(?:I|We)(?:\s+|[’'](?:m|ve|d|re))\s+/i,'');
  out = out.replace(/\bDuring my time at\b/i, 'During time at');
  out = out.replace(/\bmy\b/ig,'the');
  out = out.replace(/\bour\b/ig,'the');
  // recase first alpha
  out = out.replace(/^(\s*)([a-z])/,(m,a,b)=> a + b.toUpperCase());
  return normalizeWS(out);
}

// ---------- Rewrite engine ----------
function pickKeywordsForLine(line, rankedTerms){
  const present = tokenSet(line.toLowerCase());
  const picks = [];
  for (const kw of rankedTerms){
    const toks = tokenSet(String(kw).toLowerCase()).size ? tokenSet(String(kw).toLowerCase()) : new Set([kw.toLowerCase()]);
    // choose kw if any token is already hinted OR we have no picks yet
    if ([...toks].some(t=>present.has(t)) || !picks.length){
      if (!picks.includes(kw)) picks.push(kw);
      if (picks.length >= 2) break;
    }
  }
  if (!picks.length && rankedTerms.length) picks.push(rankedTerms[0]);
  return picks.slice(0,2);
}

function buildClause(picks){
  const chunk = safeJoinKeywords(picks);
  if (!chunk) return '';
  const lead = bridgePhrase(`leveraging ${chunk}`);
  return lead;
}

function rewriteOneLine(text, rankedTerms){
  const base = depersonalizeLine(text);
  if (!base) return {after: text, inserted:''};

  const picks = pickKeywordsForLine(base, rankedTerms);
  const bridge = buildClause(picks);
  if (!bridge) return {after: base, inserted:''};

  const ins = contextualPrefix(base, bridge);
  const after = base + ins;
  const integrated = ins.trim().replace(/^[—,]\s*/,''); // for tooltip
  return {after, inserted: integrated, used: picks};
}

function markInserted(el, before, after, inserted, why){
  el.dataset.before = before;
  el.dataset.why = JSON.stringify(why || {});
  el.classList.add('auto-insert');

  // simple inline diff: wrap the inserted tail
  // We'll try to highlight the inserted clause only.
  const safeInserted = escapeHtml(inserted);
  const escapedAfter = escapeHtml(after);
  const at = escapedAfter.lastIndexOf(safeInserted);
  let html;
  if (at >= 0){
    html = escapedAfter.slice(0, at)
        + `<span class="auto-insert">${safeInserted}</span>`
        + escapedAfter.slice(at + safeInserted.length)
        + ` <button class="whybtn" title="Why">?</button>`;
  } else {
    html = escapedAfter + ` <button class="whybtn" title="Why">?</button>`;
  }
  el.innerHTML = html;
}

function escapeHtml(s=''){
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------- Auto‑tailor (local, in‑place rewrites) ----------
async function autoTailorLocal(){
  const jd = jdEl.value || '';
  const prof = readProfile();
  const terms = topJDKeywords({
    jdText: jd,
    resumeHtml: getResumeHTML(),
    profileSkills: prof.skills || [],
    cap: 24
  });

  // coverage chips (Jobscan‑style)
  renderCoverage(terms);

  const bullets = liLikeNodesAfterExperience();
  if (!bullets.length){
    toast('No eligible bullets found after Education / Experience.');
    return;
  }

  const maxBullets = 10;
  const minBullets = 6;

  let edits = 0;
  for (const li of bullets.slice(0, maxBullets)){
    const before = normalizeWS(li.innerText || li.textContent || '');
    if (!before || before.length < 25) continue;
    // skip if this line already contains bracketed templates or looks like a reference
    if (/\[[^\]]{0,40}\]/.test(before)) continue;

    const {after, inserted, used} = rewriteOneLine(before, terms);
    if (!after || after.toLowerCase() === before.toLowerCase()) continue;

    markInserted(li, before, after, inserted, {
      reason: 'Full rewrite to compound/complex sentence using JD keywords (client-side).',
      used_keywords: (used||[]).map(canon)
    });
    edits++;
    if (edits >= maxBullets) break;
  }

  // light weaving fallback: if too few edits, append a single clause to the first candidate
  if (edits < minBullets && bullets.length){
    const li = bullets[0];
    const before = normalizeWS(li.innerText || li.textContent || '');
    const picks = (terms||[]).slice(0,1);
    const bridge = buildClause(picks);
    if (bridge){
      const ins = contextualPrefix(before, bridge);
      const after = before + ins;
      markInserted(li, before, after, ins.trim(), {
        reason: 'Hard fallback to ensure visible tailoring (client-side).',
        used_keywords: picks.map(canon)
      });
      edits++;
    }
  }

  $('#btn_undo_auto').disabled = (edits === 0);
  $('#btn_clear_auto').disabled = (edits === 0);
  if (edits) toast(`Auto‑tailored ${edits} bullet${edits===1?'':'s'}.`);
}

// ---------- Undo / Clear ----------
function undoAuto(){
  const edits = $$('.auto-insert', editor);
  if (!edits.length) return;
  edits.forEach(el=>{
    const before = el.dataset.before || '';
    if (!before) return;
    el.innerHTML = escapeHtml(before);
    el.classList.remove('auto-insert');
    delete el.dataset.before;
    delete el.dataset.why;
  });
  $('#btn_undo_auto').disabled = true;
  $('#btn_clear_auto').disabled = true;
}
function clearAuto(){
  const edits = $$('.auto-insert', editor);
  edits.forEach(el=>{
    // just drop highlights, keep text
    const txt = el.innerText || el.textContent || '';
    el.innerHTML = escapeHtml(txt);
    el.classList.remove('auto-insert');
    delete el.dataset.why;
    delete el.dataset.before;
  });
  $('#btn_undo_auto').disabled = true;
  $('#btn_clear_auto').disabled = true;
}

// ---------- Why popover ----------
editor.addEventListener('click', (e)=>{
  const b = e.target.closest('.whybtn');
  if (!b) return;
  const host = b.closest('.auto-insert');
  if (!host) return;
  let why = {};
  try { why = JSON.parse(host.dataset.why||'{}'); } catch {}
  const used = (why.used_keywords||[]).join(', ');
  alert(`Why: ${why.reason || 'Tailored with JD keywords.'}${used ? `\n• Keywords integrated: ${used}`:''}`);
});

// ---------- Right rail: suggestions go to the first list AFTER Education ----------
function insertSuggestionAtCursor(text){
  const targetList = afterEducationNodeList();
  if (!targetList){
    // Create a new UL at the end, but still after Education if possible
    const ul = document.createElement('ul');
    const p = document.createElement('p');
    p.textContent = '';
    const anchor = $$('#editor *')[experienceStart()] || editor.lastChild || editor;
    anchor.parentNode.insertBefore(ul, anchor.nextSibling);
  }
  const list = afterEducationNodeList() || editor.appendChild(document.createElement('ul'));
  const li = document.createElement('li');
  li.textContent = text.replace(/^•\s*/,'');
  list.appendChild(li);
  // mark as auto for easy clear/undo
  li.dataset.before = '';
  li.dataset.why = JSON.stringify({reason:'Manual suggestion inserted after Education.', used_keywords:[]});
  li.classList.add('auto-insert');
  $('#btn_undo_auto').disabled = false;
  $('#btn_clear_auto').disabled = false;
}

// ---------- Coverage / Gaps (Jobscan‑style) ----------
function renderCoverage(terms){
  const {hits, misses} = coverageAgainstResume({ resumeHtml:getResumeHTML(), terms });
  const cov = $('#coverage');
  const gaps = $('#gaps');
  const hitChips = hits.map(t=>`<span class="k hit">${escapeHtml(t)}</span>`).join(' ');
  const missChips= misses.map(t=>`<span class="k miss">${escapeHtml(t)}</span>`).join(' ');
  cov.innerHTML = (hits.length || misses.length)
    ? `${hitChips} ${missChips}`
    : 'Shown after JD is pasted.';
  gaps.innerHTML = misses.length
    ? `Missing or light: ${missChips}`
    : (terms.length ? 'Good coverage of requested skills.' : 'Paste a job description to see gaps.');
}

// ---------- DOCX import/export (as before) ----------
$('#docx_file')?.addEventListener('change', async (ev)=>{
  const f = ev.target.files[0];
  if (!f) return;
  const arr = await f.arrayBuffer();
  const { value: html } = await window.mammoth.convertToHtml({ arrayBuffer: arr });
  setResumeHTML(html);
});
$('#btn_export_docx')?.addEventListener('click', ()=>{
  const html = `<!doctype html><html><body>${getResumeHTML()}</body></html>`;
  const blob = window.htmlDocx.asBlob(html);
  const a = document.createElement('a');
  a.download = 'resume-tailored.docx';
  a.href = URL.createObjectURL(blob);
  a.click();
});
$('#btn_print_pdf')?.addEventListener('click', ()=> window.print());

// ---------- Buttons ----------
$('#btn_auto_server')?.addEventListener('click', autoTailorLocal);
$('#btn_undo_auto')?.addEventListener('click', undoAuto);
$('#btn_clear_auto')?.addEventListener('click', clearAuto);

// ---------- Suggestions rail ----------
function refreshSuggestions(){
  const prof = readProfile();
  const terms = topJDKeywords({
    jdText: jdEl.value || '',
    resumeHtml: getResumeHTML(),
    profileSkills: prof.skills || [],
    cap: 12
  });
  renderCoverage(terms);
  const sug = $('#suggestions');
  const items = suggestionBullets(terms).slice(0, 24);
  if (!items.length){ sug.innerHTML = 'Suggestions appear after you paste a JD.'; return; }
  sug.innerHTML = items.map(line => (
    `<div class="suggestion">${escapeHtml(line)}</div>`
  )).join('');
}
$('#suggestions')?.addEventListener('click', (e)=>{
  const el = e.target.closest('.suggestion');
  if (!el) return;
  insertSuggestionAtCursor(el.textContent || '');
});
jdEl?.addEventListener('input', refreshSuggestions);
editor?.addEventListener('input', ()=> renderCoverage(topJDKeywords({
  jdText: jdEl.value||'',
  resumeHtml: getResumeHTML(),
  profileSkills: (readProfile().skills||[]),
  cap: 24
})));

// Initial paint
refreshSuggestions();

// ---------- tiny UI helpers ----------
function injectStyles(){
  const css = `
  .k{display:inline-block;padding:.25rem .5rem;border:1px solid #ccd;border-radius:999px;background:#eef;margin:.1rem;}
  .hit{background:#eaffea;border-color:#b7f7b7}.miss{background:#ffeaea;border-color:#f6c2c2}
  .auto-insert{background:#f4fff4;outline:1px dashed #8fd48f;border-radius:6px}
  .whybtn{border:1px solid #ccd;border-radius:999px;padding:0 .5rem;margin-left:.5rem;background:#fff;cursor:pointer}
  `;
  const s = document.createElement('style');
  s.textContent = css;
  document.head.appendChild(s);
}
function injectDiffToggle(){
  const bar = document.querySelector('.toolbar');
  if (!bar) return;
  const label = document.createElement('label');
  label.style.marginLeft = 'auto';
  label.className = 'small';
  label.innerHTML = `<input id="toggle_diffs" type="checkbox" checked/> Show inline diffs`;
  bar.appendChild(label);
  $('#toggle_diffs').addEventListener('change', (e)=>{
    const on = e.target.checked;
    $$('.auto-insert span.auto-insert', editor).forEach(sp=>{
      sp.style.background = on ? '#f4fff4' : 'transparent';
      sp.style.outline = on ? '1px dashed #8fd48f' : 'none';
    });
  });
}

function toast(msg){ try{ console.log(msg); }catch{} }
