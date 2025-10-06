// docs/js/scoring.js
// Deterministic scoring helpers used by Match Report & Power Edit.
// Exports: scoreJob, explainGaps, tokenize, tokensFromTerms.

/** Canonicalize common multi-word/variant tech terms before tokenizing. */
function precanon(str = "") {
  return String(str).replace(/\b(hugging)\s+(face)\b/gi, "huggingface")
                    .replace(/\b(github)\s+(actions?)\b/gi, "githubactions")
                    .replace(/\b(react)\s+(native)\b/gi, "reactnative")
                    .replace(/\b(service)\s+(worker)\b/gi, "serviceworker")
                    .replace(/\b(full)\s*[-\s]?(stack)\b/gi, "fullstack");
}

export function tokenize(str = "") {
  return precanon(str)
    .toLowerCase()
    .replace(/[\/]/g, " ")
    .match(/[a-z][a-z0-9+.-]{1,}/g) || [];
}

export function tokensFromTerms(arr = []) {
  const out = new Set();
  for (const t of arr) {
    const canon = precanon(String(t));
    tokenize(canon).forEach(x => {
      out.add(x);
      if (x.includes("-")) out.add(x.replaceAll("-", "")); // front-end -> frontend
    });
  }
  return Array.from(out);
}

function uniq(arr) { return Array.from(new Set(arr.filter(Boolean))); }
function pct(n, d) { return d > 0 ? n / d : 0; }

function locOk(job, profile = {}) {
  const pol = profile.location_policy || {};
  const wantRemote = !!pol.remote_only;
  const loc = `${job.location || ""} ${job.description || ""}`.toLowerCase();
  if (wantRemote && !/remote|work from home|distributed/.test(loc)) return false;

  const countries = (pol.allowed_countries || []).map(s => String(s).toLowerCase());
  const states    = (pol.allowed_states    || []).map(s => String(s).toLowerCase());
  const allowList = countries.concat(states);

  if (allowList.length) {
    const ok = allowList.some(x => loc.includes(x));
    if (!ok && wantRemote) return /united states|usa|u\.s\./.test(loc);
    return ok;
  }
  return true;
}

export function explainGaps(job = {}, profile = {}) {
  const jobToks = uniq(tokenize(`${job.title || ""} ${job.description || ""}`));
  const profSkills = tokensFromTerms(profile.skills || []);
  const musts = tokensFromTerms(profile.must_haves || []);

  const missing_must_haves = musts.filter(m => !jobToks.includes(m));
  const missing_skills = profSkills.filter(s => !jobToks.includes(s)).slice(0, 50);

  return {
    location_ok: locOk(job, profile),
    missing_must_haves,
    missing_skills,
    job_tokens: jobToks,
    profile_skills: profSkills
  };
}

export function scoreJob(job = {}, profile = {}) {
  const g = explainGaps(job, profile);
  const prof = new Set(g.profile_skills);
  const hits = g.job_tokens.filter(t => prof.has(t)).length;
  const hitPct = pct(hits, g.job_tokens.length);
  const mustMiss = g.missing_must_haves.length;

  const base = 0.35;
  const locBump = g.location_ok ? 0.15 : -0.05;
  const mustPenalty = Math.min(0.3, mustMiss * 0.08);

  return Math.max(0, Math.min(1, base + locBump + 0.6 * hitPct - mustPenalty));
}
