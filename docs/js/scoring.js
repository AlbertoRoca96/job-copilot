/* docs/js/scoring.js
 * Scoring, tokenization and simple “bridge phrase” helpers used by power-edit.js.
 * All functions are deterministic; no network calls.
 */

export const STOP = new Set([
  "the","and","for","with","to","of","in","on","as","by","or","an","a","at","from","using",
  "we","you","our","your","will","role","responsibilities","requirements","preferred","must",
  "including","include","etc","ability","skills","excellent","communication","experience",
  "years","year","team","teams","work"
]);

// Pretty render for common tokens
const PRETTY = {
  "js": "JavaScript", "javascript": "JavaScript", "ts": "TypeScript", "typescript": "TypeScript",
  "react": "React", "reactjs": "React", "react native": "React Native", "node": "Node.js",
  "postgres": "PostgreSQL", "postgresql": "PostgreSQL", "sql": "SQL",
  "github actions": "GitHub Actions", "gh actions": "GitHub Actions",
  "ci": "CI", "ci/cd": "CI/CD", "docker": "Docker",
  "aws":"AWS","azure":"Azure","gcp":"GCP","kubernetes":"Kubernetes","k8s":"Kubernetes",
  "rails":"Ruby on Rails","ruby on rails":"Ruby on Rails",
  "flask":"Flask","django":"Django","java":"Java","c++":"C++","c#":"C#","c":"C",
  "pandas":"pandas","numpy":"NumPy","seaborn":"seaborn","playwright":"Playwright",
  "mammoth":"Mammoth","html-docx-js":"html-docx-js"
};

// Category cues (used to pick the best bullet to weave into)
export const CUE_SETS = {
  database: ["database","sql","postgres","postgresql","schema","index","query","etl","migration","warehouse"],
  backend:  ["api","service","microservice","endpoint","server","requests","auth","oauth","jwt","flask","django","rails","spring"],
  frontend: ["ui","ux","component","react","javascript","typescript","spa","responsive","accessibility"],
  devops:   ["ci","ci/cd","pipeline","build","deploy","docker","container","kubernetes","workflow","github actions"],
  analytics:["analytics","metrics","kpi","dashboard","tracking","events","instrumentation","report"],
  cloud:    ["aws","gcp","azure","s3","lambda","ec2","kinesis","pubsub","cloud","k8s"],
  testing:  ["test","qa","automation","e2e","integration","unit","playwright","jest","pytest"]
};

// Heuristic mapping for JD tokens to a coarse category
export function categorize(tok) {
  const t = tok.toLowerCase();
  if (["postgres","postgresql","sql","database","warehouse"].some(w => t.includes(w))) return "database";
  if (["react","javascript","typescript","frontend","component","ui","ux"].some(w => t.includes(w))) return "frontend";
  if (["api","flask","django","rails","spring","backend","node"].some(w => t.includes(w))) return "backend";
  if (["ci","cd","github actions","pipeline","docker","kubernetes","k8s"].some(w => t.includes(w))) return "devops";
  if (["kpi","analytics","dashboard","metrics"].some(w => t.includes(w))) return "analytics";
  if (["aws","gcp","azure","s3","lambda","cloud"].some(w => t.includes(w))) return "cloud";
  if (["test","qa","automation","jest","pytest","playwright"].some(w => t.includes(w))) return "testing";
  return "other";
}

export function canon(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

export function pretty(tok) {
  const t = tok.toLowerCase();
  return PRETTY[t] || tok.replace(/\baws\b/i,"AWS").replace(/\bgcp\b/i,"GCP");
}

export function tokenize(text) {
  const out = [];
  (text || "").toLowerCase().replace(/[A-Za-z][A-Za-z0-9+./-]{1,}/g, m => { out.push(m); return m; });
  return out;
}

export function tokenSet(text) {
  return new Set(tokenize(text));
}

// Extract a small, ranked set of JD targets we want to weave
export function smartJDTargets(jdText, allowed = []) {
  const toks = tokenize(jdText);
  const scores = new Map();
  const allowedSet = new Set(allowed.map(a => a.toLowerCase()));

  for (const t of toks) {
    if (STOP.has(t)) continue;
    // If we have an allowed list (from profile/skills), weight those higher.
    const base = allowedSet.size ? (allowedSet.has(t) ? 2 : 1) : 1;
    scores.set(t, (scores.get(t) || 0) + base);
  }
  // phrases (2-3grams) that appear often
  const words = (jdText || "").toLowerCase().split(/\s+/);
  for (let i = 0; i < words.length - 1; i++) {
    const bigram = `${words[i]} ${words[i+1]}`.trim();
    if (bigram.split(" ").some(w => STOP.has(w))) continue;
    if (bigram.length < 5) continue;
    scores.set(bigram, (scores.get(bigram) || 0) + 3);
  }

  const ranked = [...scores.entries()]
    .sort((a,b) => b[1] - a[1])
    .map(([k,_]) => k)
    .filter(k => k.length <= 40);

  const deduped = [];
  const seen = new Set();
  for (const k of ranked) {
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({
      token: k,
      display: pretty(k),
      category: categorize(k)
    });
    if (deduped.length >= 24) break;
  }
  return deduped;
}

// Build a compact, non-fabricating clause that can be appended to a bullet.
export function bridgeForToken(display, category = "other", style = "dash", dashThreshold = 7) {
  const phrase = display; // keep it truthful & minimal
  const words = String(phrase).trim().split(/\s+/).length;
  const delim = (style === "comma") ? ", " : (style === "auto" ? (words >= dashThreshold ? " — " : ", ") : " — ");

  // Category-specific light wording (no outcomes fabricated)
  const tail =
    category === "database" ? `with ${phrase}` :
    category === "devops"   ? `via ${phrase}` :
    category === "frontend" ? `with ${phrase}` :
    category === "backend"  ? `with ${phrase}` :
    category === "analytics"? `with ${phrase}` :
    category === "cloud"    ? `on ${phrase}` :
    `with ${phrase}`;

  return `${delim}${tail}`;
}

// Coverage helpers (small, Jobscan-style)
export function jdCoverageAgainstResume(jd, resumePlain) {
  const jdWords = tokenSet(jd);
  const resWords = tokenSet(resumePlain);
  const hits = [...jdWords].filter(w => resWords.has(w));
  const misses = [...jdWords].filter(w => !resWords.has(w));
  return { hits, misses };
}

export function explainGaps(jd, resumePlain) {
  const { hits, misses } = jdCoverageAgainstResume(jd, resumePlain);
  const topMisses = misses.slice(0, 50);
  return { hits, misses: topMisses };
}
