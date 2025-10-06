// Power Edit: live scoring + SMART suggestions + server Auto-tailor.
// JD→Resume coverage + phrase-aware extraction.
// Inline diffs (toggle) + one‑click "Why added?" popover for each inserted node.

import {
  scoreJob,
  explainGaps,
  tokenize,
  tokensFromTerms,
  jdCoverageAgainstResume,
  smartJDTargets
} from './scoring.js?v=2025-10-06-2';

const $ = (id) => document.getElementById(id);

// Supabase bootstrap
let supabase = null;
async function ensureSupabase() {
  if (supabase) return supabase;
  if (!window.supabase?.createClient) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = "https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.js";
      s.defer = true; s.onload = resolve; s.onerror = reject; document.head.appendChild(s);
    });
  }
  supabase = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  return supabase;
}

// Wait for Mammoth (DOCX -> HTML)
async function ensureMammoth(timeoutMs = 6000) {
  const t0 = Date.now();
  while (!window.mammoth) {
    if (Date.now() - t0 > timeoutMs) throw new Error('DOCX converter not loaded yet');
    await new Promise(r => setTimeout(r, 50));
  }
  return window.mammoth;
}

/* ---------- Inject minimal styles for diffs & popover ---------- */
(function injectStyles(){
  const css = `
    .ins { background:#f4fff4; outline:1px dashed #8fd48f; border-radius:4px; padding:0 2px; }
    .hide-diffs .ins { background:transparent; outline:none; }
    .why-btn { display:inline-block; margin-left:.4rem; border:1px solid #ccd; border-radius:999px; width:22px; height:22px; line-height:20px; text-align:center; cursor:pointer; background:#f7f7ff; color:#333; font-weight:700; }
    .auto-insert { position:relative; }
    #why-pop { position:absolute; z-index:10000; max-width:340px; background:#fff; border:1px solid #ddd; border-radius:8px; padding:.7rem .8rem; box-shadow:0 10px 30px rgba(0,0,0,.14); }
    #why-pop .title { font-weight:700; margin:0 0 .25rem; }
    #why-pop .meta  { color:#666; font-size:.85em; margin:.15rem 0 .5rem; }
    #why-pop .jd    { background:#f7f7f7; border-left:3px solid #bde; padding:.45rem .55rem; border-radius:6px; font-size:.92em; }
    #why-pop .close { position:absolute; top:4px; right:6px; border:0; background:transparent; font-size:16px; cursor:pointer; color:#666; }
  `;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
})();

/* ---------- DOM ---------- */
const editor        = $('editor');
const fileInput     = $('docx_file');
const btnExport     = $('btn_export_docx');
const btnPrint      = $('btn_print_pdf');

const scoreline     = $('scoreline');
const gapsEl        = $('gaps');
const coverageEl    = $('coverage');
const suggEl        = $('suggestions');

const jobTitle      = $('job_title');
const jobCompany    = $('job_company');
const jobLocation   = $('job_location');
const jobDesc       = $('job_desc');
const profileBox    = $('profile_json');

const btnAutoServer = $('btn_auto_server');
const btnUndo       = $('btn_undo_auto');
const btnClear      = $('btn_clear_auto');
const autoHint      = $('auto_hint');

/* ---------- Add "Show inline diffs" toggle to toolbar ---------- */
(function addDiffToggle(){
  const bar = document.querySelector('.toolbar');
  if (!bar) return;
  const label = document.createElement('label');
  label.className = 'small';
  label.style.marginLeft = '6px';
  label.title = 'Toggle highlight of inserted text';
  label.innerHTML = `<input id="toggle_diffs" type="checkbox" checked> Show inline diffs`;
  bar.insertBefore(label, scoreline);
  const cb = label.querySelector('input');
  cb.onchange = () => document.body.classList.toggle('hide-diffs', !cb.checked);
})();

/* ---------- "Why added?" popover ---------- */
let whyPop = null;
function ensureWhyPop() {
  if (whyPop) return whyPop;
  whyPop = document.createElement('div');
  whyPop.id = 'why-pop';
  whyPop.style.display = 'none';
  whyPop.innerHTML = `<button class="close" aria-label="Close">×</button>
    <div class="title"></div>
    <div class="meta"></div>
    <div class="jd"></div>`;
  document.body.appendChild(whyPop);

  whyPop.addEventListener('click', (e)=>{ if (e.target.matches('.close')) hideWhyPop(); });
  document.addEventListener('keydown', (e)=>{ if (e.key === 'Escape') hideWhyPop(); });
  document.addEventListener('click', (e)=>{
    if (!whyPop) return;
    if (whyPop.style.display === 'none') return;
    if (e.target.closest('#why-pop') || e.target.closest('.why-btn')) return;
    hideWhyPop();
  });
  return whyPop;
}
function showWhyPop(btn, payload = {}, bulletText = "") {
  const pop = ensureWhyPop();
  const r = btn.getBoundingClientRect();
  const top = r.bottom + window.scrollY + 8;
  const left = Math.min(window.scrollX + r.left, window.scrollX + document.documentElement.clientWidth - 360);

  const sigs = Array.isArray(payload.signals) ? payload.signals : [];
  const labels = {
    title: 'mentioned in the job title',
    dict: 'recognized technology/skill',
    stem: 'extracted from a requirement phrase'
  };
  const sigText = sigs.map(s => labels[s] || s).join(', ');

  pop.querySelector('.title').textContent = `Why added: ${payload.target || payload.token || '(target)'}`;
  pop.querySelector('.meta').textContent =
    `Score ${Number(payload.score || 0).toFixed(2)} • freq=${payload.frequency || 1}` +
    (payload.in_title ? ' • in title' : '') +
    (payload.in_profile ? ' • in your profile' : '') +
    (sigText ? ` • ${sigText}` : '');
  pop.querySelector('.jd').textContent = payload.sample ? `JD evidence: “… ${payload.sample} …”` : 'JD evidence: (not found)';

  pop.style.top = `${top}px`; pop.style.left = `${left}px`; pop.style.display = 'block';
}
function hideWhyPop(){ if (whyPop) whyPop.style.display = 'none'; }

/* ---------- State ---------- */
const state = { profile: {}, job: {}, selRange: null, resumeLoaded:false };
let lastAutoNodes = [];
let autoNodesAll  = [];

/* ---------- Helpers ---------- */
function getJobFromUI(){
  return {
    title: jobTitle.value || '',
    company: jobCompany.value || '',
    location: jobLocation.value || '',
    description: jobDesc.value || ''
  };
}
function getResumeHTML(){ return editor.innerHTML || ''; }
function setResumeHTML(html){ editor.innerHTML = html || ''; }
function rememberSelection(){
  const sel = window.getSelection();
  if (sel && sel.rangeCount) state.selRange = sel.getRangeAt(0);
}
function sanitize(html){
  const div = document.createElement('div');
  div.innerHTML = html;
  div.querySelectorAll('script,style,iframe,object').forEach(n=>n.remove());
  return div.innerHTML;
}
function insertAtCursor(htmlFrag){
  editor.focus();
  const range = state.selRange || document.createRange();
  if (!state.selRange) { range.selectNodeContents(editor); range.collapse(false); }
  const template = document.createElement('template');
  template.innerHTML = htmlFrag.trim();
  const node = template.content.cloneNode(true);
  range.insertNode(node);
}
function jdReady() {
  const t = tokenize(`${jobTitle.value || ''} ${jobDesc.value || ''}`);
  return (jobDesc.value || '').trim().length >= 20 || t.length >= 10;
}
function hasResume() {
  const textLen = (editor.textContent || '').trim().length;
  return state.resumeLoaded || textLen >= 50; // pasted/typed counts too
}

/* ---------- Scoring & coverage ---------- */
function render(){
  try{
    state.job = getJobFromUI();

    if (!jdReady()) {
      scoreline.textContent = 'Score: —';
      gapsEl.innerHTML = '<span class="small muted">Paste a job description to see gaps.</span>';
      suggEl.innerHTML = '<span class="small muted">Suggestions appear after you paste a JD.</span>';
      coverageEl.innerHTML = '<span class="small muted">Shown after JD is pasted.</span>';
      enableButtons();
      return;
    }

    // Profile-aware global score (location & must-haves)
    const s = scoreJob(state.job, state.profile);
    scoreline.textContent = `Score: ${s.toFixed(4)}`;

    const gaps = explainGaps(state.job, state.profile);
    const coverage = jdCoverageAgainstResume(state.job, getResumeHTML());

    gapsEl.innerHTML = `
      <div>Location OK: <strong>${gaps.location_ok ? "Yes" : "No"}</strong></div>
      <div>Missing must-haves (profile → JD):
        ${(gaps.missing_must_haves || []).map(k=>`<span class="k miss">${pretty(k)}</span>`).join(" ") || "<em>none</em>"}
      </div>
      <div><strong>Uncovered JD keywords (JD → your resume):</strong>
        ${(coverage.misses || []).slice(0,60).map(k=>`<span class="k miss">${pretty(k)}</span>`).join(" ") || "<em>none</em>"}
      </div>
    `;

    const jobToks = [...coverage.job_tokens];
    const skills  = [...tokensFromTerms(state.profile.skills || [])];
    coverageEl.innerHTML = `
      <div>JD tokens (${jobToks.length}): ${jobToks.slice(0,120).map(k=>`<span class="k">${pretty(k)}</span>`).join(" ")}</div>
      <div>Your resume coverage: ${(coverage.score*100).toFixed(0)}% of JD tokens present</div>
      <div>Profile skills (${skills.length}): ${skills.map(k=>`<span class="k">${pretty(k)}</span>`).join(" ")}</div>
    `;

    rebuildSuggestions();
    enableButtons();
  }catch(e){
    scoreline.textContent = `Score: error`;
    gapsEl.textContent = e.message;
  }
}

/* ---------- SMART suggestions (X‑Y‑Z bullets) ---------- */
function rebuildSuggestions(){
  if (!jdReady()) {
    suggEl.innerHTML = '<span class="small muted">Suggestions appear after you paste a JD.</span>';
    return;
  }

  const targets = smartJDTargets(getJobFromUI(), getResumeHTML(), state.profile, 18);

  // Optional: portfolio-aware linking (profile_json.projects: [{name,url,tags:[]}, ...])
  const projects = Array.isArray(state.profile.projects) ? state.profile.projects : [];
  function bestProjectFor(token){
    const t = token.toLowerCase();
    let best = null, score = 0;
    for (const p of projects){
      const tags = (p.tags || []).map(x => String(x).toLowerCase());
      const hit = tags.includes(t) || tags.includes(pretty(t).toLowerCase());
      if (hit && (p.score || 1) > score) { best = p; score = p.score || 1; }
    }
    return best;
  }

  const bullets = [];
  for (const t of targets) {
    const proj = bestProjectFor(t.token);
    const tool = t.display;

    // X-Y-Z formula (Accomplished [X] as measured by [Y] by doing [Z])
    bullets.push({
      txt: `• Accomplished [X outcome] as measured by [Y metric] by using ${tool} to [Z concrete action].`,
      why: { target: tool, token: t.token, score: t.score, ...t.why }
    });
    bullets.push({
      txt: `• Shipped [feature] with ${tool}, reducing [time/cost] by [X%] via [method].`,
      why: { target: tool, token: t.token, score: t.score, ...t.why }
    });
    bullets.push({
      txt: `• Built/automated [process] in ${tool} to meet [KPI], verified by [test/monitor].`,
      why: { target: tool, token: t.token, score: t.score, ...t.why }
    });

    if (proj?.url) {
      bullets.push({
        txt: `• Demonstrated ${tool} in ${proj.name} ([link](${proj.url})), achieving [Y] by [Z].`,
        why: { target: tool, token: t.token, score: t.score, ...t.why, project: proj.name, project_url: proj.url }
      });
    }
  }

  // Render with reasons as tooltips
  suggEl.innerHTML = bullets.slice(0, 36).map(b => {
    const w = b.why || {};
    const tip = [
      `Target: ${w.target || w.token}`,
      w.in_title ? "appears in title" : "",
      w.in_profile ? "in your profile" : "",
      (w.signals || []).includes("stem") ? "found in requirement stem" : "",
      (w.signals || []).includes("dict") ? "dictionary hit" : "",
      `freq=${w.frequency || 1}`,
    ].filter(Boolean).join(" • ");
    return `<div class="suggestion" title="${escapeHtml(tip)}" data-txt="${encodeURIComponent(b.txt)}" data-why='${escapeAttr(JSON.stringify(w))}'>${escapeHtml(b.txt)}</div>`;
  }).join("");
}

/* ---------- Insert suggestion + attach why JSON ---------- */
document.addEventListener("click", (ev)=>{
  const n = ev.target.closest('.suggestion');
  if (n){
    const txt = decodeURIComponent(n.getAttribute('data-txt') || '');
    let why = {};
    try { why = JSON.parse(n.getAttribute('data-why') || '{}'); } catch {}
    rememberSelection();

    const payload = escapeAttr(JSON.stringify(why));
    const html = `
      <div class="auto-insert" data-why='${payload}'>
        <span class="ins">${escapeHtml(txt)}</span>
        <button class="why-btn" type="button" contenteditable="false" title="Why added?">?</button>
      </div>`;
    insertAtCursor(html);
    render();
  }
});

/* ---------- Why popover handler ---------- */
document.addEventListener('click', (e)=>{
  const btn = e.target.closest('.why-btn');
  if (!btn) return;
  const host = btn.closest('.auto-insert');
  let why = {};
  try { why = JSON.parse(host?.getAttribute('data-why') || '{}'); } catch {}
  showWhyPop(btn, why, (host?.textContent || '').trim());
});

/* ---------- DOCX import / export / print ---------- */
fileInput.addEventListener('change', async (e)=>{
  const f = e.target.files?.[0]; if (!f) return;
  try {
    await ensureMammoth();
    const buf = await f.arrayBuffer();
    const { value: html } = await window.mammoth.convertToHtml({ arrayBuffer: buf });
    setResumeHTML(sanitize(html));
    state.resumeLoaded = true;
    enableButtons();
    render();
  } catch (err) {
    alert('Could not import .docx: ' + String(err?.message || err));
  }
});
btnExport.addEventListener('click', ()=>{
  if (!window.htmlDocx?.asBlob) return alert('Export library not loaded yet, try again.');
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>${getResumeHTML()}</body></html>`;
  const blob = window.htmlDocx.asBlob(html);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'resume-edited.docx';
  a.click(); URL.revokeObjectURL(a.href);
});
btnPrint.addEventListener('click', ()=> window.print());

/* ---------- Auto-tailor (server) ---------- */
async function callServer() {
  await ensureSupabase();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) { alert("Sign in first on the Profile page."); return null; }

  const body = {
    title: jobTitle.value || '',
    company: jobCompany.value || '',
    location: jobLocation.value || '',
    jd_text: jobDesc.value || '',
    resume_html: getResumeHTML(),
    profile_json: (()=>{ try { return JSON.parse(profileBox.value || "{}"); } catch { return {}; } })()
  };

  const { data, error } = await supabase.functions.invoke('power-tailor', { body });
  if (error) throw new Error(error.message || 'invoke failed');
  return data?.result || null;
}

async function autoTailorServer() {
  btnAutoServer.disabled = true;
  try {
    const result = await callServer();
    if (!result?.block_html) throw new Error('No block returned');

    lastAutoNodes = [];
    const beforeCount = editor.childNodes.length;

    rememberSelection();
    insertAtCursor(result.block_html);

    const afterCount = editor.childNodes.length;
    for (let i = beforeCount; i < afterCount; i++) {
      const node = editor.childNodes[i];
      lastAutoNodes.push(node);
      autoNodesAll.push(node);
    }
    render();
  } catch (e) {
    alert('Auto-tailor failed: ' + String(e.message || e));
  } finally {
    enableButtons();
  }
}
btnAutoServer.addEventListener('click', autoTailorServer);

/* ---------- Undo / Clear ---------- */
function undoAuto() {
  lastAutoNodes.forEach(n => n.remove());
  autoNodesAll = autoNodesAll.filter(n => !lastAutoNodes.includes(n));
  lastAutoNodes = [];
  enableButtons();
  render();
}
function clearAuto() {
  editor.querySelectorAll('.auto-insert').forEach(n => n.remove());
  lastAutoNodes = [];
  autoNodesAll = [];
  enableButtons();
  render();
}
btnUndo.addEventListener('click', undoAuto);
btnClear.addEventListener('click', clearAuto);

/* ---------- Tiny tooltip/helper for “why disabled” ---------- */
function setAutoHint(reason) {
  btnAutoServer.title = reason || 'Send to server to insert a tailored block';
  autoHint.textContent = reason || '';
  autoHint.style.display = reason ? 'inline' : 'none';
}
function enableButtons() {
  const needs = [];
  if (!hasResume()) needs.push('load or paste your resume');
  if (!jdReady())  needs.push('paste a JD (≥20 chars)');
  const ok = needs.length === 0;
  btnAutoServer.disabled = !ok;
  btnUndo.disabled = lastAutoNodes.length === 0;
  btnClear.disabled = autoNodesAll.length === 0;
  setAutoHint(ok ? '' : `To enable: ${needs.join(' and ')}`);
}

/* ---------- Live inputs ---------- */
for (const id of ["job_title","job_company","job_location","job_desc","profile_json"]){
  document.addEventListener("input", (ev)=>{ if (ev.target && ev.target.id===id) {
    if (id === "profile_json"){
      try { state.profile = JSON.parse(profileBox.value || "{}"); } catch(_){ state.profile = {}; }
    }
    render(); // rebuildSuggestions() happens inside render()
  }});
}
// treat typed/pasted resume as a loaded resume too
editor.addEventListener('input', ()=>{ if ((editor.textContent||'').trim().length >= 50) state.resumeLoaded = true; enableButtons(); });
editor.addEventListener('keyup', ()=>{ render(); rememberSelection(); });
editor.addEventListener('mouseup', rememberSelection);
editor.addEventListener('blur', rememberSelection);

/* ---------- Load profile into textarea ---------- */
async function loadUserProfileFromSupabase() {
  try {
    await ensureSupabase();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;

    const { data, error } = await supabase.from('profiles').select('*').eq('id', user.id).single();
    if (error || !data) return false;

    const json = {
      skills: data.skills || [],
      target_titles: data.target_titles || [],
      must_haves: data.must_haves || [],
      location_policy: data.search_policy || {},
      // Optional: add projects to unlock portfolio-aware bullets
      // projects: [{ name:"Pointkedex", url:"https://...", tags:["pwa","serviceworker","react"] }]
    };

    profileBox.value = JSON.stringify(json, null, 2);
    state.profile = json;
    return true;
  } catch { return false; }
}
async function tryLoadProfileFile(){
  try{
    const r = await fetch('./data/profile.json', { cache: 'no-store' });
    if (r.ok){
      const j = await r.json();
      if (!profileBox.value.trim()) {
        profileBox.value = JSON.stringify(j||{}, null, 2);
        state.profile = j||{};
      }
    }
  }catch(_){}
}

/* ---------- Init ---------- */
window.addEventListener('DOMContentLoaded', async ()=>{
  await ensureSupabase();
  const loaded = await loadUserProfileFromSupabase();
  if (!loaded) await tryLoadProfileFile();
  render(); enableButtons();
});

/* ---------- utils ---------- */
function pretty(t){
  const map = {
    huggingface: "Hugging Face",
    reactnative: "React Native",
    serviceworker: "Service Worker",
    githubactions: "GitHub Actions",
    postgresql: "PostgreSQL",
    plpgsql: "PL/pgSQL",
    cicd: "CI/CD",
    fullstack: "Full-Stack"
  };
  return map[t] || t;
}
function escapeHtml(s){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function escapeAttr(s){ return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
