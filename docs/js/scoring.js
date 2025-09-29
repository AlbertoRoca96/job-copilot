// docs/js/scoring.js
// Lightweight JS port of your Python scoring + gap explainers used in rank.py

const REMOTE = new Set([
  "remote","remotely","work from home","wfh","distributed",
  "us-remote","remote-us","remote (us)","remote, us",
  "remote in the us","anywhere in the us","anywhere (us)"
]);
const US_WORDS = new Set(["us","u.s.","united states","usa","u.s.a"]);
const US_STATES = new Set([
  "al","ak","az","ar","ca","co","ct","de","fl","ga","hi","id","il","in","ia",
  "ks","ky","la","me","md","ma","mi","mn","ms","mo","mt","ne","nv","nh","nj",
  "nm","ny","nc","nd","oh","ok","or","pa","ri","sc","sd","tn","tx","ut","vt",
  "va","wa","wv","wi","wy",
  "alabama","alaska","arizona","arkansas","california","colorado","connecticut","delaware",
  "florida","georgia","hawaii","idaho","illinois","indiana","iowa","kansas","kentucky",
  "louisiana","maine","maryland","massachusetts","michigan","minnesota","mississippi","missouri",
  "montana","nebraska","nevada","new hampshire","new jersey","new mexico","new york","north carolina",
  "north dakota","ohio","oklahoma","oregon","pennsylvania","rhode island","south carolina",
  "south dakota","tennessee","texas","utah","vermont","virginia","washington","west virginia",
  "wisconsin","wyoming","district of columbia","dc"
]);

const CANON = new Map([
  ["front-end","frontend"],["front end","frontend"],
  ["back-end","backend"],["back end","backend"]
]);
function _canon(t){ const v=(t||"").toLowerCase(); return CANON.get(v)||v; }

function tokenize(text){
  text = (text || "").toLowerCase().replaceAll("/", " ");
  const raw = new Set((text.match(/[a-z][a-z0-9+.-]{1,}/g)||[]));
  const expanded = new Set();
  for (const t of raw){
    expanded.add(t);
    if (t.includes("-")){
      t.split("-").forEach(p=>expanded.add(p));
      expanded.add(t.replaceAll("-",""));
    }
  }
  const final = new Set();
  for (const t of expanded){
    const c = _canon(t);
    final.add(c);
    if (c==="ml"){ final.add("machine"); final.add("learning"); }
    if (c==="machine"||c==="learning"){ final.add("ml"); }
    if (["frontend","front","end"].includes(c)){ ["frontend","front","end"].forEach(x=>final.add(x)); }
    if (["backend","back","end"].includes(c)){ ["backend","back","end"].forEach(x=>final.add(x)); }
  }
  return new Set([...final].filter(Boolean));
}

function containsAny(text, needles){
  const t = (text||"").toLowerCase();
  for (const n of (needles||[])){ if (t.includes((n||"").toLowerCase())) return true; }
  return false;
}
function _asList(v){ if (v==null) return []; return Array.isArray(v)?v:[v]; }
function tokensFromTerms(terms){
  const out = new Set();
  for (const term of _asList(terms)) for (const tok of tokenize(String(term))) out.add(tok);
  return out;
}

function isRemote(loc, desc){ return containsAny(loc, REMOTE) || containsAny(desc, REMOTE); }
function mentionsUS(text){ return containsAny(text, US_WORDS); }
function mentionsState(text, wanted){
  const t = (text||"").toLowerCase();
  for (const w of _asList(wanted)){
    const lw = String(w||"").toLowerCase();
    if (lw.length===2){ if (new RegExp(`\\b${lw}\\b`).test(t)) return true; }
    else if (lw && t.includes(lw)) return true;
  }
  return false;
}

function locationOk(job, policy){
  policy = policy || {};
  const loc = job.location || "";
  const desc = job.description || "";
  const combined = `${loc} ${desc}`;

  if (Boolean(policy.remote_only) && !isRemote(loc, desc)) return false;

  const allowed_countries = new Set(_asList(policy.allowed_countries||[]).map(x=>String(x).toLowerCase()));
  if (allowed_countries.size){
    if (![...allowed_countries].some(c => combined.toLowerCase().includes(c))){
      if (!(isRemote(loc, desc) && mentionsUS(combined))) return false;
    }
  }

  const allowed_states = new Set(_asList(policy.allowed_states||[]).map(x=>String(x).toLowerCase()));
  if (allowed_states.size && !mentionsState(combined, allowed_states)) return false;

  return true;
}

export function scoreJob(job, profile){
  if (!locationOk(job, (profile.location_policy||{}))) return 0.0;

  const title = job.title||"";
  const desc  = job.description||"";
  const loc   = job.location||"";

  const jobTokens = new Set([...tokenize(title), ...tokenize(desc)]);

  const must = tokensFromTerms(profile.must_haves||[]);
  for (const m of must){ if (!jobTokens.has(m)) return 0.0; }

  const skillTokens  = tokensFromTerms(profile.skills||[]);
  const titleTokens  = tokensFromTerms(profile.target_titles||[]);
  const titleOnlyTok = tokenize(title);

  const skillOverlap = skillTokens.size ? ([...skillTokens].filter(t=>jobTokens.has(t)).length / skillTokens.size) : 0;
  const titleSim     = titleTokens.size ? ([...titleTokens].filter(t=>titleOnlyTok.has(t)).length / titleTokens.size) : 0;

  let locBoost = 0.0;
  const locTerms = tokensFromTerms(profile.locations||[]);
  const blobTokens = tokenize(`${loc} ${desc}`);
  if ([...locTerms].some(t=>blobTokens.has(t))) locBoost = 0.1;
  else if (containsAny(loc, ["virginia","va","east coast","eastern time","et","est"])) locBoost = 0.1;

  return Math.round((0.6*skillOverlap + 0.3*titleSim + locBoost) * 10000)/10000;
}

export function explainGaps(job, profile){
  const title = job.title||"", desc = job.description||"";
  const jobTok = new Set([...tokenize(title), ...tokenize(desc)]);
  const skillTok = tokensFromTerms(profile.skills||[]);
  const mustTok  = tokensFromTerms(profile.must_haves||[]);
  const titleTok = tokensFromTerms(profile.target_titles||[]);

  const missingMust = [...mustTok].filter(t=>!jobTok.has(t));
  const skillMiss   = [...skillTok].filter(t=>!jobTok.has(t));
  const titleHits   = [...titleTok].filter(t=>tokenize(title).has(t));

  const locOK = locationOk(job, profile.location_policy||{});
  return {
    location_ok: locOK,
    missing_must_haves: missingMust,
    missing_skills: skillMiss.slice(0, 12),
    title_token_hits: titleHits,
  };
}

/* ---- Tiny UI glue ---- */
function $(id){ return document.getElementById(id); }
function render(){
  try{
    const job = {
      title: $('job_title').value,
      company: $('job_company').value,
      location: $('job_location').value,
      description: $('job_desc').value
    };
    let profile = {};
    try { profile = JSON.parse($('profile_json').value || "{}"); } catch(_){ profile = {}; }

    const s = scoreJob(job, profile);
    $('scoreline').textContent = `Score: ${s.toFixed(4)}`;

    const gaps = explainGaps(job, profile);
    $('gaps').innerHTML = `
      <div>Location OK: <strong>${gaps.location_ok ? "Yes" : "No"}</strong></div>
      <div>Missing must-haves: ${
        gaps.missing_must_haves.map(k=>`<span class="k miss">${k}</span>`).join(" ") || "<em>none</em>"
      }</div>
      <div>Missing skills: ${
        gaps.missing_skills.map(k=>`<span class="k miss">${k}</span>`).join(" ") || "<em>none</em>"
      }</div>
    `;

    const jobToks = [...tokenize(`${job.title} ${job.description}`)];
    const skills = [...tokensFromTerms(profile.skills||[])];
    $('coverage').innerHTML = `
      <div>Job tokens (${jobToks.length}): ${jobToks.slice(0,120).map(k=>`<span class="k">${k}</span>`).join(" ")}</div>
      <div>Profile skills (${skills.length}): ${skills.map(k=>`<span class="k">${k}</span>`).join(" ")}</div>
    `;
  }catch(e){
    $('scoreline').textContent = `Score: error`;
    $('gaps').textContent = e.message;
  }
}

for (const id of ["job_title","job_company","job_location","job_desc","profile_json"]){
  document.addEventListener("input", (ev)=>{ if (ev.target && ev.target.id===id) render(); });
}
window.addEventListener("DOMContentLoaded", render);
