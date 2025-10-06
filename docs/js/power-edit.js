// Power Edit live scoring + server Auto-tailor + profile autoload (Supabase).
// Quiet until a JD is present. Auto-tailor enables when JD present AND
// you either uploaded a .docx OR the editor already contains enough text.

import { scoreJob, explainGaps, tokenize, tokensFromTerms } from './scoring.js?v=2025-10-01-3';

const $ = (id) => document.getElementById(id);

// Supabase
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
function restoreSelection(){
  if (!state.selRange) return;
  const sel = window.getSelection();
  sel.removeAllRanges(); sel.addRange(state.selRange);
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
  return state.resumeLoaded || textLen >= 50; // pasted/typed resume counts too
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

    const s = scoreJob(state.job, state.profile);
    scoreline.textContent = `Score: ${s.toFixed(4)}`;

    const gaps = explainGaps(state.job, state.profile);
    gapsEl.innerHTML = `
      <div>Location OK: <strong>${gaps.location_ok ? "Yes" : "No"}</strong></div>
      <div>Missing must-haves: ${
        (gaps.missing_must_haves || []).map(k=>`<span class="k miss">${k}</span>`).join(" ") || "<em>none</em>"
      }</div>
      <div>Missing skills: ${
        (gaps.missing_skills || []).map(k=>`<span class="k miss">${k}</span>`).join(" ") || "<em>none</em>"
      }</div>
    `;

    const jobToks = [...tokenize(`${state.job.title} ${state.job.description}`)];
    const skills = [...tokensFromTerms(state.profile.skills || [])];
    coverageEl.innerHTML = `
      <div>Job tokens (${jobToks.length}): ${jobToks.slice(0,120).map(k=>`<span class="k">${k}</span>`).join(" ")}</div>
      <div>Profile skills (${skills.length}): ${skills.map(k=>`<span class="k">${k}</span>`).join(" ")}</div>
    `;

    enableButtons();
  }catch(e){
    scoreline.textContent = `Score: error`;
    gapsEl.textContent = e.message;
  }
}

/* ---------- Suggestions (placeholder patch: use [brackets]) ---------- */
function rebuildSuggestions(){
  if (!jdReady()) {
    suggEl.innerHTML = '<span class="small muted">Suggestions appear after you paste a JD.</span>';
    return;
  }
  const gaps = explainGaps(getJobFromUI(), state.profile);
  const sugg = [];
  for (const m of (gaps.missing_skills || []).slice(0, 10)){
    const nice = m.replace(/[-_]/g, ' ');
    sugg.push(`• Implemented ${nice} to improve [metric] by [X%].`);
    sugg.push(`• Built ${nice} workflow reducing [time/cost] by [X%].`);
    sugg.push(`• Used ${nice} to deliver [result], meeting [KPI].`);
  }
  suggEl.innerHTML = sugg.map(txt=>`<div class="suggestion" data-txt="${encodeURIComponent(txt)}">${txt}</div>`).join("");
}
document.addEventListener("click", (ev)=>{
  const n = ev.target.closest('.suggestion');
  if (n){
    const txt = decodeURIComponent(n.getAttribute('data-txt') || '');
    rememberSelection();
    insertAtCursor(`<div>${txt}</div>`);
    render();
  }
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
    render(); rebuildSuggestions();
  } catch (err) {
    alert('Could not import .docx: ' + String(err?.message || err));
  }
});
btnExport.addEventListener('click', ()=>{
  if (!window.htmlDocx?.asBlob) return alert('Export library not loaded yet, try again.');
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>${getResumeHTML()}</body></html>`;
  const blob = window.htmlDocx.asBlob(html); // per library docs, returns a Blob for download
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
    render(); rebuildSuggestions();
  } catch (e) {
    alert('Auto-tailor failed: ' + String(e.message || e));
  } finally {
    enableButtons();
  }
}
btnAutoServer.addEventListener('click', autoTailorServer);

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
    render(); rebuildSuggestions(); enableButtons();
  }});
}
// treat typed/pasted resume as a loaded resume too
editor.addEventListener('input', ()=>{ if ((editor.textContent||'').trim().length >= 50) state.resumeLoaded = true; enableButtons(); });
editor.addEventListener('keyup', ()=>{ render(); rebuildSuggestions(); rememberSelection(); });
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
      location_policy: data.search_policy || {}
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
  render(); rebuildSuggestions(); enableButtons();
});
