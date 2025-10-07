/* docs/js/scoring.js
 * Scoring + tokenization + morphology + template builders for Power Edit.
 * Deterministic, browser‑only. Plays nicely with server suggestions.
 *
 * Key upgrades:
 *  - Stronger STOP list (drops filler like "this", "you'll", numerics like "5pm")
 *  - Morphology: light stemming so "manage/managed/managing" align
 *  - Smarter JD miner that avoids numeric/time tokens and short words
 *  - Bridge builder that varies prepositions by category (never auto "and")
 */

/* -------------------- Stopwords & weak phrases -------------------- */

export const STOP = new Set([
  // articles, preps, auxiliaries, generic JD boilerplate
  "the","and","for","with","to","of","in","on","as","by","or","an","a","at","from","using",
  "we","you","our","your","their","they","them","it","its","it’s","is","are","be","this","that","these","those",
  "will","role","responsibilities","requirements","preferred","must","nice","plus",
  "including","include","etc","ability","skills","excellent","communication","experience",
  "years","year","team","teams","work","job","title","company","location","about","while",
  "each","other","deeply","planet","zero","waste","motivation","daily","value","passion","create"
]);

// Guardrails for rewrites; keep concise, ATS‑friendly
export const WEAK_PHRASES = [
  "responsible for","duties included","worked on","helped","assisted","participated in",
  "utilized","leveraged","various","etc","successfully","dynamic","rockstar","go-getter"
];

/* -------------------- Pretty names & category cues -------------------- */

const PRETTY = {
  "js":"JavaScript","javascript":"JavaScript","ts":"TypeScript","typescript":"TypeScript",
  "react":"React","reactjs":"React","react native":"React Native","node":"Node.js",
  "postgres":"PostgreSQL","postgresql":"PostgreSQL","sql":"SQL",
  "github actions":"GitHub Actions","gh actions":"GitHub Actions",
  "ci":"CI","ci/cd":"CI/CD","docker":"Docker",
  "aws":"AWS","azure":"Azure","gcp":"GCP","kubernetes":"Kubernetes","k8s":"Kubernetes",
  "rails":"Ruby on Rails","ruby on rails":"Ruby on Rails",
  "flask":"Flask","django":"Django","java":"Java","c++":"C++","c#":"C#","c":"C",
  "pandas":"pandas","numpy":"NumPy","playwright":"Playwright",
  "mammoth":"Mammoth","html-docx-js":"html-docx-js"
};

export const CUE_SETS = {
  database: ["database","sql","postgres","postgresql","schema","index","query","etl","migration","warehouse"],
  backend:  ["api","service","microservice","endpoint","server","auth","oauth","jwt","flask","django","rails","spring","node"],
  frontend: ["ui","ux","component","react","javascript","typescript","spa","responsive","accessibility"],
  devops:   ["ci","ci/cd","pipeline","build","deploy","docker","container","kubernetes","workflow","github actions"],
  analytics:["analytics","metrics","kpi","dashboard","tracking","events","instrumentation","report"],
  cloud:    ["aws","gcp","azure","s3","lambda","ec2","cloud","k8s"],
  testing:  ["test","qa","automation","e2e","integration","unit","playwright","jest","pytest"]
};

export function categorize(tok) {
  const t = (tok || "").toLowerCase();
  if (["postgres","postgresql","sql","database","warehouse"].some(w => t.includes(w))) return "database";
  if (["react","javascript","typescript","frontend","component","ui","ux"].some(w => t.includes(w))) return "frontend";
  if (["api","flask","django","rails","spring","backend","node"].some(w => t.includes(w))) return "backend";
  if (["ci","github actions","pipeline","docker","kubernetes","k8s"].some(w => t.includes(w))) return "devops";
  if (["kpi","analytics","dashboard","metrics"].some(w => t.includes(w))) return "analytics";
  if (["aws","gcp","azure","s3","lambda","cloud"].some(w => t.includes(w))) return "cloud";
  if (["test","qa","automation","jest","pytest","playwright"].some(w => t.includes(w))) return "testing";
  return "other";
}

/* -------------------- Core text helpers -------------------- */

export const canon = (s) => (s || "").replace(/\s+/g, " ").trim();

export function pretty(tok) {
  const t = (tok || "").toLowerCase();
  return PRETTY[t] || tok.replace(/\baws\b/gi,"AWS").replace(/\bgcp\b/gi,"GCP");
}

export function tokenize(text) {
  const out = [];
  (text || "").toLowerCase().replace(/[A-Za-z][A-Za-z0-9+./-]{1,}/g, m => { out.push(m); return m; });
  return out;
}
export function tokenSet(text) {
  return new Set(tokenize(text));
}

/* -------------------- Light stemming (variants) -------------------- */
/* Mirrors Jobscan‑style acceptance of close variants so hits/misses are useful.  */
const STEM_RULES = [[/ing$/, ""],[/ed$/, ""],[/s$/, ""],[/ies$/, "y"]];
function stem(word) { let w = (word || "").toLowerCase(); for (const [re,r] of STEM_RULES) w = w.replace(re,r); return w; }
export function morphEq(a, b) { return stem(a) === stem(b); }

/* -------------------- JD target miner -------------------- */

function badWord(w) { return STOP.has(w) || /\d/.test(w) || w.length < 3; }

export function smartJDTargets(jdText, allowed = []) {
  const toks = tokenize(jdText);
  const scores = new Map();
  const allowedSet = new Set((allowed || []).map(x => x.toLowerCase()));

  // 1) score unigrams (skip numerics/stopwords)
  for (const t of toks) {
    if (badWord(t)) continue;
    const base = allowedSet.size ? (allowedSet.has(t) ? 3 : 1) : 1;
    scores.set(t, (scores.get(t) || 0) + base);
  }

  // 2) phrase lift (bigrams/trigrams) but reject digits/filler
  const words = (jdText || "").toLowerCase().split(/\s+/);
  for (let i = 0; i < words.length - 1; i++) {
    const bigram = `${words[i]} ${words[i+1]}`.trim();
    if (bigram.split(" ").some(badWord)) continue;
    if (bigram.length < 5) continue;
    scores.set(bigram, (scores.get(bigram) || 0) + 4);
    if (i + 2 < words.length) {
      const trigram = `${words[i]} ${words[i+1]} ${words[i+2]}`.trim();
      if (!trigram.split(" ").some(badWord) && trigram.length >= 7) {
        scores.set(trigram, (scores.get(trigram) || 0) + 3);
      }
    }
  }

  // Rank, dedupe by stem, emit up to 24 targets with category
  const ranked = [...scores.entries()].sort((a,b) => b[1] - a[1]).map(([k]) => k);
  const seen = new Set();
  const out = [];
  for (const k of ranked) {
    const key = stem(k);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ token: k, display: pretty(k), category: categorize(k) });
    if (out.length >= 24) break;
  }
  return out;
}

/* -------------------- Bridge builder (mid‑sentence / end) -------------------- */

export function bridgeForToken(display, category = "other", style = "auto", dashThreshold = 7) {
  const phrase = String(display || "").trim();
  const words = phrase ? phrase.split(/\s+/).length : 0;
  const delim  = (style === "comma") ? ", " : (style === "dash") ? " — " : (words >= dashThreshold ? " — " : ", ");

  // Vary the preposition so we never rely on “and …”
  const tail =
    category === "database" ? `with ${phrase}` :
    category === "devops"   ? `via ${phrase}`  :
    category === "frontend" ? `with ${phrase}` :
    category === "backend"  ? `with ${phrase}` :
    category === "analytics"? `for ${phrase}`  :
    category === "cloud"    ? `on ${phrase}`   :
    `with ${phrase}`;

  return `${delim}${tail}`;
}

/* -------------------- Weakness detection & metric templates -------------------- */

export function assessWeakness(text, wordCap = 40) {
  const t = canon(text);
  const words = t ? t.split(/\s+/).length : 0;
  const long = words > wordCap;
  const weak = WEAK_PHRASES.find(w => new RegExp(`\\b${w}\\b`, "i").test(t)) || null;
  return { long, weak, words };
}

export function templatesForSkill(skill) {
  const s = pretty(skill);
  return [
    `Implemented ${s} to improve [KPI] by [X%].`,
    `Built ${s} workflow reducing [time/cost/defects] by [X%].`,
    `Used ${s} to deliver [feature/output], meeting [SLA/target].`
  ];
}

/* -------------------- Coverage -------------------- */

export function jdCoverageAgainstResume(jd, resumePlain) {
  const jdWords = tokenSet(jd);
  const resWords = tokenSet(resumePlain);
  const hits   = [...jdWords].filter(w => [...resWords].some(r => morphEq(w, r)));
  const misses = [...jdWords].filter(w => ![...resWords].some(r => morphEq(w, r)));
  return { hits, misses };
}

export function explainGaps(jd, resumePlain) {
  const { hits, misses } = jdCoverageAgainstResume(jd, resumePlain);
  return { hits, misses: misses.slice(0, 50) };
}
