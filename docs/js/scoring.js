/* docs/js/scoring.js
   Lightweight JD keyword miner + coverage helpers used by power-edit.js.
   Mirrors the shape/intent of the Python planner (call_llm_weaves/mined_plan),
   but runs entirely in the browser.
*/

export const CONFIG = {
  MID_SENTENCE_STYLE: 'dash',  // 'comma' | 'dash' | 'auto'
  DASH_THRESHOLD: 7,
  MAX_WEAVE_WORDS: 18,
  MAX_TERMS: 24
};

export const STOP = new Set([
  'the','and','for','with','to','of','in','on','as','by','or','an','a','at','from','using',
  'we','you','our','your','will','role','responsibilities','requirements','preferred','must',
  'including','include','etc','ability','skills','excellent','communication','experience',
  'year','years','plus','bonus','team','teams','work','working'
]);

// canonical display casing for common terms used in both JD + resume
const CANON = {
  'ap style':'AP style','cms':'CMS','pos':'POS','crm':'CRM',
  'microsoft office':'Microsoft Office','excel':'Excel','word':'Word','powerpoint':'PowerPoint','outlook':'Outlook',
  'adobe':'Adobe','photoshop':'Photoshop','illustrator':'Illustrator','indesign':'InDesign',
  'sql':'SQL','supabase':'Supabase','github actions':'GitHub Actions',
  'javascript':'JavaScript','typescript':'TypeScript','react':'React','react native':'React Native',
};

export function canon(s='') {
  let out = s;
  // longest keys first
  Object.keys(CANON).sort((a,b)=>b.length-a.length).forEach(k=>{
    const rx = new RegExp(`\\b${escapeRegExp(k)}\\b`,'ig');
    out = out.replace(rx, CANON[k]);
  });
  return out;
}

export function normalizeWS(s=''){ return (s||'').replace(/\s+/g,' ').trim(); }
export function uniq(a){ return [...new Set(a)]; }
export function escapeRegExp(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }

export function tokenize(s=''){
  // allow tokens like c++, node.js, pl/pgsql
  return (s.toLowerCase().match(/[a-z][a-z0-9+./-]{1,}/g) || []);
}
export function tokenSet(s=''){ return new Set(tokenize(s)); }

// Pull only the meaningful parts of the JD for mining.
export function importantJDText(jdRaw=''){
  // Keep everything; light collapse only.
  return normalizeWS(jdRaw);
}

// Very small synonyms mapper to collapse noisy variants.
function norm(s){
  const SYN = {
    'js':'javascript','reactjs':'react','ts':'typescript','ml':'machine learning',
    'cv':'computer vision','postgres':'postgresql','gh actions':'github actions',
    'gh-actions':'github actions','ci/cd':'ci','rest':'rest','etl':'data pipeline'
  };
  const t = (s||'').toLowerCase().trim();
  return SYN[t] || t;
}

// Score phrases & unigrams from allowed vocab + the JD itself.
// Prefer (a) phrases from profile/allowed vocabulary seen in JD,
// then (b) frequent meaningful unigrams from the JD.
// Finally, remove anything already well represented in the resume.
export function topJDKeywords({ jdText='', resumeHtml='', profileSkills=[] , cap=CONFIG.MAX_TERMS }={}){
  const jd = importantJDText(jdText);
  const resumeTxt = normalizeWS(stripHtml(resumeHtml).toLowerCase());
  const resumeTokens = tokenSet(resumeTxt);

  // candidate phrases: come from profile skills / tags (if present)
  const allowed = (profileSkills||[]).map(s=>norm(String(s))).filter(Boolean);
  const phrases = allowed.filter(x=>x.includes(' '));
  const unigrams = allowed.filter(x=>!x.includes(' '));

  const scores = new Map();

  // helper: count whole-phrase occurrences
  const countPhrase = (text, phrase) => {
    const rx = new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'ig');
    const m = text.match(rx);
    return m ? m.length : 0;
  };

  // phrase scoring (heavier weight)
  phrases.forEach(ph=>{
    if (ph.split(/\s+/).some(w=>STOP.has(w))) return;
    const c = countPhrase(jd.toLowerCase(), ph);
    if (c) scores.set(ph, (scores.get(ph)||0) + 3*c);
  });

  // JD-derived meaningful unigrams (light weight)
  tokenSet(jd).forEach(w=>{
    const ww = norm(w);
    if (STOP.has(ww)) return;
    if (ww.length < 3) return;
    scores.set(ww, (scores.get(ww)||0) + 1);
  });

  // down-rank things already present in resume text
  [...scores.keys()].forEach(k=>{
    const toks = tokenSet(k);
    if ([...toks].every(t => resumeTokens.has(t))) {
      scores.set(k, (scores.get(k)||0) * 0.5);
    }
  });

  const ranked = [...scores.entries()]
    .sort((a,b)=> b[1]-a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([k])=>canon(k));

  return uniq(ranked).slice(0, cap);
}

// quick HTML -> text
export function stripHtml(html=''){
  const el = document.createElement('div');
  el.innerHTML = html;
  return el.textContent || el.innerText || '';
}

// Basic coverage matrix used for the Jobscan-style chips.
export function coverageAgainstResume({ resumeHtml='', terms=[] }={}){
  const text = stripHtml(resumeHtml).toLowerCase();
  const hits = [];
  const misses = [];
  (terms||[]).forEach(t=>{
    const rx = new RegExp(`\\b${escapeRegExp(t.toLowerCase())}\\b`,'i');
    (rx.test(text) ? hits : misses).push(canon(t));
  });
  return { hits: uniq(hits), misses: uniq(misses) };
}

// Right‑rail suggestion templates (still available for manual insert)
export function suggestionBullets(terms=[]){
  const T = (kw) => [
   `• Improved ${kw} by streamlining workflow.`,
   `• Reduced defects with ${kw}.`,
   `• Automated steps using ${kw}.`,
  ];
  const out = [];
  (terms||[]).slice(0, 12).forEach(kw => out.push(...T(canon(kw))));
  return uniq(out);
}
