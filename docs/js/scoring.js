// docs/js/scoring.js
// Tiny, deterministic ATS-ish scorer + allowed-vocab miner used by Power Edit.
// Exposes two globals:
//   window.computeAtsScore(jdText, resumeText) -> { score(0..10), hits[], misses[] }
//   window.deriveAllowedVocabFromResume(resumeText) -> string[] (<=200)

(function () {
  const WORD_RE = /[A-Za-z][A-Za-z0-9+./-]{1,}/g;
  const STOP = new Set([
    "the","a","an","and","or","for","with","to","of","in","on","as","by","using",
    "we","you","our","your","their","they","it","its","is","are","be","this","that","these","those",
    "will","role","responsibilities","requirements","preferred","must","including","include","etc",
    "ability","skills","experience","years","year","team","teams","work","job","title","company",
    "location","applicants","salary","benefits","visa","sponsor","bonus","range"
  ]);

  const CURATED_PHRASES = [
    // editorial / comms
    "AP style","CMS","content calendar","social media","copyediting","proofreading","fact checking",
    "style guide","house style","seo","analytics",
    // admin / ops
    "calendar management","travel arrangements","expense reports","meeting notes","data entry",
    "record keeping","documentation","process improvement","help desk","ticketing","crm",
    // tech-lite
    "Microsoft Office","Word","Excel","PowerPoint","Outlook","Google Sheets","Google Docs",
    "Adobe","Photoshop","Illustrator","InDesign",
    // common SWE/data (kept generic; used only if present in resume)
    "Python","JavaScript","TypeScript","React","SQL","PostgreSQL","Linux","GitHub Actions",
    "Playwright","REST API","data pipeline","machine learning","Tableau",
  ];

  function toks(s) {
    return (String(s || "").toLowerCase().match(WORD_RE) || []);
  }
  function tokset(s) { return new Set(toks(s)); }
  function norm(s) { return String(s || "").toLowerCase(); }
  function uniq(arr) {
    const seen = new Set(); const out = [];
    for (const x of arr) { const k = String(x).toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(x); } }
    return out;
  }

  // ---- JD term ranking (very lightweight reflection of server side) ----
  function rankJdTerms(jd, allowed, cap = 48) {
    const desc = norm(jd);
    const allowedSet = new Set((allowed || []).map((s) => norm(s)));
    const scores = new Map();

    // phrase boost
    for (const a of allowedSet) {
      if (!a || a.split(" ").length < 2) continue;
      const re = new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (re.test(desc)) scores.set(a, (scores.get(a) || 0) + 3);
    }
    // unigram pass
    const seen = new Set(toks(desc));
    for (const w of seen) {
      if (STOP.has(w)) continue;
      if (allowedSet.size && !allowedSet.has(w) && w.length <= 2) continue;
      scores.set(w, (scores.get(w) || 0) + 1);
    }
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k)
      .filter((k) => k && !STOP.has(k))
      .slice(0, cap);
  }

  // ---- Scoring (0..10) using JD terms coverage
  function computeAtsScore(jdText, resumeText) {
    const allowed = deriveAllowedVocabFromResume(resumeText);
    const terms = rankJdTerms(jdText, allowed, 48);

    const rset = tokset(resumeText);
    const hits = [];
    const misses = [];
    for (const t of terms) {
      const ts = toks(t).filter((x) => !STOP.has(x));
      const ok = ts.some((x) => rset.has(x));
      (ok ? hits : misses).push(t);
    }
    // score: weighted coverage, scaled to 0..10
    const raw = terms.length ? hits.length / terms.length : 0;
    const score = Math.max(0, Math.min(10, +(raw * 10).toFixed(1)));
    return { score, hits, misses, terms };
  }

  // ---- Allowed vocab miner (resume-derived)
  function deriveAllowedVocabFromResume(resumeText) {
    const text = String(resumeText || "");
    const baseTokens = toks(text).filter((t) => !STOP.has(t));
    const uniques = uniq(baseTokens);

    // detect common bigrams in the resume (to give phrases a chance)
    const words = (String(resumeText || "").toLowerCase().match(WORD_RE) || []);
    const bigrams = [];
    for (let i = 0; i < words.length - 1; i++) {
      const ph = `${words[i]} ${words[i + 1]}`;
      if (!STOP.has(words[i]) && !STOP.has(words[i + 1])) bigrams.push(ph);
    }

    // include curated phrases only if they appear anywhere in the resume (case-insensitive)
    const presentCurated = CURATED_PHRASES.filter((p) =>
      new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(resumeText || "")
    );

    // merge & cap
    const vocab = uniq([...presentCurated, ...bigrams, ...uniques]).slice(0, 200);
    return vocab;
  }

  // expose
  window.computeAtsScore = computeAtsScore;
  window.deriveAllowedVocabFromResume = deriveAllowedVocabFromResume;
})();
