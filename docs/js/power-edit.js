// docs/js/power-edit.js
// Power Edit glue. Live scoring via scoring.js, DOCX import/export via mammoth/html-docx-js.

import { scoreJob, explainGaps, tokenize, tokensFromTerms } from './scoring.js';

const $ = (id) => document.getElementById(id);
const state = { profile: {}, job: {}, selRange: null };

function getJobFromUI(){
  return {
    title: $('job_title').value || '',
    company: $('job_company').value || '',
    location: $('job_location').value || '',
    description: $('job_desc').value || ''
  };
}

function getResumeHTML(){
  return $('editor').innerHTML || '';
}

function setResumeHTML(html){
  $('editor').innerHTML = html || '';
  // place caret at beginning
  const el = $('editor');
  const range = document.createRange();
  range.setStart(el, 0);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function restoreSelection(){
  if (!state.selRange) return;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(state.selRange);
}

function rememberSelection(){
  const sel = window.getSelection();
  if (sel && sel.rangeCount) state.selRange = sel.getRangeAt(0);
}

function sanitize(html){
  // super-light sanitizer (we only allow a subset)
  const div = document.createElement('div');
  div.innerHTML = html;
  div.querySelectorAll('script,style,iframe,object').forEach(n=>n.remove());
  return div.innerHTML;
}

function render(){
  try{
    state.job = getJobFromUI();
    const s = scoreJob(state.job, state.profile);
    $('scoreline').textContent = `Score: ${s.toFixed(4)}`;

    const gaps = explainGaps(state.job, state.profile);
    $('gaps').innerHTML = `
      <div>Location OK: <strong>${gaps.location_ok ? "Yes" : "No"}</strong></div>
      <div>Missing must-haves: ${
        gaps.missing_must_haves.map(k=>`<span class="k miss">${k}</span>`).join(" ") || "<em>none</em>"
      }</div>
      <div>Missing skills: ${
        gaps.missing_skills.map(k=>`<span class="k miss">${k}</span>`).join(" ") || "<em>none</em>"
      }</div>
    `;

    // Suggestions: derive from missing skills + simple quantified templates.
    const sugg = [];
    for (const m of gaps.missing_skills.slice(0, 10)){
      const nice = m.replace(/[-_]/g, ' ');
      sugg.push(`• Implemented ${nice} to improve <impact metric> by <X%/value>.`);
      sugg.push(`• Built ${nice} workflows that reduced <time/cost> by <X%> across <team/project>.`);
      sugg.push(`• Used ${nice} to deliver <project/result>, meeting <KPI> within <time/cost> constraints.`);
    }
    $('suggestions').innerHTML = sugg.map(txt=>`<div class="suggestion" data-txt="${encodeURIComponent(txt)}">${txt}</div>`).join("");

    // Coverage chips
    const jobToks = [...tokenize(`${state.job.title} ${state.job.description}`)];
    const skills = [...tokensFromTerms(state.profile.skills || [])];
    $('coverage').innerHTML = `
      <div>Job tokens (${jobToks.length}): ${jobToks.slice(0,120).map(k=>`<span class="k">${k}</span>`).join(" ")}</div>
      <div>Profile skills (${skills.length}): ${skills.map(k=>`<span class="k">${k}</span>`).join(" ")}</div>
    `;
  }catch(e){
    $('scoreline').textContent = `Score: error`;
    $('gaps').textContent = e.message;
  }
}

/* Event wiring */
for (const id of ["job_title","job_company","job_location","job_desc","profile_json"]){
  document.addEventListener("input", (ev)=>{ if (ev.target && ev.target.id===id) {
    if (id === "profile_json"){
      try { state.profile = JSON.parse($('profile_json').value || "{}"); } catch(_){ state.profile = {}; }
    }
    render();
  }});
}

$('editor').addEventListener('keyup', render);
$('editor').addEventListener('mouseup', rememberSelection);
$('editor').addEventListener('keyup', rememberSelection);
$('editor').addEventListener('blur', rememberSelection);

document.addEventListener("click", (ev)=>{
  const n = ev.target.closest('.suggestion');
  if (n){
    const txt = decodeURIComponent(n.getAttribute('data-txt') || '');
    rememberSelection();
    $('editor').focus();
    restoreSelection();
    document.execCommand('insertText', false, `\n${txt}\n`);
    render();
  }
});

/* DOCX import */
async function loadDocx(file){
  const arrayBuffer = await file.arrayBuffer();
  const { value: html } = await window.mammoth.convertToHtml({ arrayBuffer });
  setResumeHTML(sanitize(html));
  render();
}

$('docx_file').addEventListener('change', async (e)=>{
  const f = e.target.files?.[0];
  if (f) await loadDocx(f);
});

/* DOCX export */
$('btn_export_docx').addEventListener('click', ()=>{
  const html = `
    <!doctype html><html><head><meta charset="utf-8"></head>
    <body>${getResumeHTML()}</body></html>`;
  const blob = window.htmlDocx.asBlob(html);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'resume-edited.docx';
  a.click();
  URL.revokeObjectURL(a.href);
});

/* Print / Save as PDF */
$('btn_print_pdf').addEventListener('click', ()=>{ window.print(); });

/* Attempt to auto-load profile */
async function tryLoadProfile(){
  try{
    const r = await fetch('./data/profile.json', { cache: 'no-store' });
    if (r.ok){
      const j = await r.json();
      $('profile_json').value = JSON.stringify(j||{}, null, 2);
      state.profile = j||{};
    }
  }catch(_){ /* noop */ }
}

/* Init */
window.addEventListener('DOMContentLoaded', async ()=>{
  await tryLoadProfile();
  render();
});
