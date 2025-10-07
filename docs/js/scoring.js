// js/scoring.js
// Deterministic helpers + "smart suggestion" extraction.
// Exports:
// - tokenize, tokensFromTerms, explainGaps, scoreJob
// - jdCoverageAgainstResume(job, resumeHtml)
// - smartJDTargets(job, resumeHtml, profile, topN)

//////////////////////////
// Canon + pretty maps  //
//////////////////////////

/** Canonicalize common multi-word/variant tech terms before tokenizing. */
function precanon(str = "") {
  return String(str)
    // multi-word tech → single token
    .replace(/\bruby\s+on\s+rails\b/gi, "rails")
    .replace(/\bnode\.?js\b/gi, "nodejs")
    .replace(/\breact\s+native\b/gi, "reactnative")
    .replace(/\bservice\s+worker(s)?\b/gi, "serviceworker")
    .replace(/\bgit(hub)?\s+actions?\b/gi, "githubactions")
    .replace(/\bhugging\s+face\b/gi, "huggingface")
    .replace(/\b(c\+\+)\b/gi, "c++")
    .replace(/\b(c#|c-sharp)\b/gi, "csharp")
    .replace(/\b(pl\/?pgsql)\b/gi, "plpgsql")
    .replace(/\b(postgre(sql)?|postgres)\b/gi, "postgresql")
    .replace(/\bci[\/\-]?cd\b/gi, "cicd")
    .replace(/\bfull\s*[-\s]?stack\b/gi, "fullstack");
}

const PRETTY = {
  rails: "Ruby on Rails",
  nodejs: "Node.js",
  reactnative: "React Native",
  serviceworker: "Service Worker",
  githubactions: "GitHub Actions",
  huggingface: "Hugging Face",
  "c++": "C++",
  csharp: "C#",
  plpgsql: "PL/pgSQL",
  postgresql: "PostgreSQL",
  cicd: "CI/CD",
  fullstack: "Full-Stack",
};

const GENERIC_BAN = new Set([
  "engineer","engineering","developer","development","software","systems","team",
  "customer","users","clients","program","project","solution","product","our","we",
  "daily","motivation","road","zero","waste","benefits","policy","applicants","visa"
]);

// Lightweight English stoplist (kept small on purpose)
const STOP = new Set("a an and are as at be by for from in is it of on or that the this to with while where who will would".split(" "));

//////////////////////////
// Token utilities      //
//////////////////////////

export function tokenize(str = "") {
  return precanon(str)
    .toLowerCase()
    .replace(/[\/]/g, " ")
    .match(/[a-z][a-z0-9+.#-]{1,}/g) || [];
}

export function tokensFromTerms(arr = []) {
  const out = new Set();
  for (const t of arr) {
    const canon = precanon(String(t));
    tokenize(canon).forEach(x => {
      out.add(x);
      if (x.includes("-")) out.add(x.replaceAll("-", "")); // front-end → frontend
    });
  }
  return Array.from(out);
}

const uniq = (arr) => Array.from(new Set(arr.filter(Boolean)));
const pct  = (n, d) => (d > 0 ? n / d : 0);

//////////////////////////
// Location & scoring   //
//////////////////////////

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

//////////////////////////
// JD vs Resume coverage//
//////////////////////////

export function jdCoverageAgainstResume(job = {}, resumeHtml = "") {
  const jobToks = uniq(tokenize(`${job.title || ""} ${job.description || ""}`));
  const resToks = uniq(tokenize(String(resumeHtml)));
  const resSet  = new Set(resToks);
  const hits    = jobToks.filter(t => resSet.has(t));
  const misses  = jobToks.filter(t => !resSet.has(t));
  const score   = jobToks.length ? hits.length / jobToks.length : 0;
  return { hits, misses, score, job_tokens: jobToks, resume_tokens: resToks };
}

//////////////////////////
// SMART TARGETS        //
//////////////////////////

// 1) Keep only meaningful JD sections (drop About/EEO/Benefits/legalese).
function importantJDText(jd = "") {
  // Split on major paragraph/heading boundaries
  const parts = String(jd).split(/\n{2,}|(?:^|\n)\s*(?:###?|----+)\s*/);

  // Heuristic keepers: requirements/qualifications/responsibilities/what you'll do
  const keepIf = /(require(d|ments)|qualifications?|what\s+you(?:'|’)ll\s+do|responsibilit|skills|must\s+have|nice\s+to\s+have|you\s+will|experience\s+with)/i;

  // Junk sections to drop:
  const dropIf = /(about\s+us|who\s+we\s+are|mission|benefits|compensation|pay\s+range|legal|eeo|equal\s+opportunity|affirmative\s+action|privacy|accommodation|visa|sponsorship|hours?\s+et|work\s+authori[sz]ation)/i;

  const kept = parts.filter(p => keepIf.test(p) && !dropIf.test(p));
  return kept.length ? kept.join("\n\n") : String(jd);
}

// 2) Dictionary of tech/skills we care about (extendable).
const TECH_DICT = [
  // languages + runtimes
  "python","java","javascript","typescript","c++","csharp","go","rust","ruby","php",
  // frameworks
  "rails","django","flask","spring","spring boot","react","reactnative","next.js","nodejs","express",
  // testing & e2e
  "playwright","cypress","jest","pytest","selenium",
  // data & ml
  "postgresql","mysql","sqlite","mongodb","redis","plpgsql","pytorch","tensorflow","opencv","huggingface",
  // devops
  "docker","kubernetes","aws","azure","gcp","lambda","s3","cloudfront","githubactions","cicd","terraform",
  // web platform
  "pwa","serviceworker","graphql","rest","grpc","websocket"
];

const SOFT_BUT_REAL = [
  "code review","unit testing","architecture","design patterns","requirements analysis",
  "agile","scrum","stakeholder management","documentation"
];

// Extract a nearby snippet from the JD for "why" popovers
function pickSnippet(haystack, raw, canon, display) {
  const hay = String(haystack);
  const lower = hay.toLowerCase();
  const candidates = [String(raw||""), String(display||""), String(canon||"")].map(s => s.toLowerCase()).filter(Boolean);
  for (const needle of candidates) {
    const i = lower.indexOf(needle);
    if (i >= 0) {
      const start = Math.max(0, i - 50);
      const end = Math.min(hay.length, i + needle.length + 50);
      return hay.slice(start, end).replace(/\s+/g, " ").trim();
    }
  }
  return "";
}

// 3) Extract candidate phrases from important JD text.
function extractCandidates(job = {}) {
  const title = String(job.title || "");
  const core  = importantJDText(String(job.description || ""));

  // (a) grab dictionary hits
  const textLC = precanon(core).toLowerCase();
  const hits = new Map(); // canon -> {display,count,signals:Set,sample?:string}

  function addHit(raw, reason) {
    const canon = precanon(raw).toLowerCase().trim();
    if (!canon || STOP.has(canon) || GENERIC_BAN.has(canon)) return;
    const display = PRETTY[canon] || (raw.trim().length <= 3 ? raw.toUpperCase() : titleCase(raw.trim()));
    const obj = hits.get(canon) || { display, count:0, signals:new Set(), sample:"" };
    obj.count++;
    obj.signals.add(reason);
    obj.display = PRETTY[canon] || obj.display;
    if (!obj.sample) obj.sample = pickSnippet(core, raw, canon, obj.display);
    hits.set(canon, obj);
  }

  // dict terms
  for (const term of [...TECH_DICT, ...SOFT_BUT_REAL]) {
    const rx = new RegExp(`\\b${escapeRx(term)}\\b`, "ig");
    textLC.replace(rx, (m) => { addHit(m, "dict"); return m; });
  }

  // (b) phrases after typical requirement stems: "experience with <X>", "proficiency in <Y>"
  const stems = [
    /experience\s+with\s+([a-z0-9+.#\- ]{2,40})/ig,
    /proficien(?:t|cy)\s+in\s+([a-z0-9+.#\- ]{2,40})/ig,
    /knowledge\s+of\s+([a-z0-9+.#\- ]{2,40})/ig,
    /familiar(?:ity)?\s+with\s+([a-z0-9+.#\- ]{2,40})/ig,
    /using\s+([a-z0-9+.#\- ]{2,40})/ig,
  ];
  for (const rx of stems) {
    let m;
    while ((m = rx.exec(core))) {
      const phrase = cleanPhrase(m[1]);
      if (phrase) addHit(phrase, "stem");
    }
  }

  // (c) title boost
  for (const term of [...TECH_DICT, "fullstack","backend","frontend"]) {
    if (new RegExp(`\\b${escapeRx(term)}\\b`, "i").test(precanon(title))) {
      addHit(term, "title");
    }
  }

  return hits; // Map(canon -> {display,count,signals,sample})
}

function cleanPhrase(s) {
  // trim to 1–3 words, drop stop/generic, keep tech-y shapes
  const toks = tokenize(s).filter(t => !STOP.has(t) && !GENERIC_BAN.has(t));
  if (toks.length === 0 || toks.length > 3) return "";
  return toks.join(" ");
}

function escapeRx(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function titleCase(s){ return s.replace(/\b[a-z]/g, c => c.toUpperCase()); }

// 4) Rank and filter vs resume/profile
export function smartJDTargets(job = {}, resumeHtml = "", profile = {}, topN = 15) {
  const cand = extractCandidates(job);
  const resumeSet = new Set(uniq(tokenize(String(resumeHtml))));
  const profileSet = new Set(tokensFromTerms(profile.skills || []));

  const ranked = [];
  for (const [canon, info] of cand.entries()) {
    // Ignore if resume already covers the canon token
    if (resumeSet.has(canon)) continue;

    // Base score from frequency
    let score = Math.min(3, info.count * 0.6);

    // Signals
    if (info.signals.has("title")) score += 1.5;
    if (info.signals.has("dict"))  score += 1.0;
    if (info.signals.has("stem"))  score += 1.0;

    // Profile overlap (you already claim this skill)
    if (profileSet.has(canon)) score += 1.2;

    // Nudge against overly generic terms
    if (GENERIC_BAN.has(canon)) score -= 2.0;

    // Keep only meaningful
    if (score >= 1.0) {
      ranked.push({
        token: canon,
        display: info.display,
        score,
        why: {
          frequency: info.count,
          signals: Array.from(info.signals),
          in_profile: profileSet.has(canon),
          in_title: info.signals.has("title"),
          sample: info.sample || ""
        }
      });
    }
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, topN);
}
