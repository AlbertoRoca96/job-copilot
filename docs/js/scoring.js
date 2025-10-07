// docs/scording.js
// Lightweight ATS-style scoring used on Power Edit.
// Intentionally simple: JD tokens vs resume tokens; phrase boost from obvious 2+ word phrases.
// NO insert suggestions here (UI removed); just a numeric "Score" and internal hits/misses.

(function (global) {
  const WORD_RE = /[A-Za-z][A-Za-z0-9+./-]{1,}/g;
  const STOP = new Set([
    "the","a","an","and","or","for","with","to","of","in","on","as","by","using",
    "we","you","i","our","your","their","they","it","its","it’s","is","are","be",
    "this","that","these","those","will","role","responsibilities","requirements",
    "preferred","must","including","include","etc","ability","skills","excellent",
    "communication","experience","years","year","team","teams","work","job","title",
    "company","location","applicants","range","bonus","salary","benefits","visa","sponsor"
  ]);

  function toks(s) { return (String(s || "").toLowerCase().match(WORD_RE)) || []; }
  function tokset(s) { return new Set(toks(s)); }
  function uniq(arr) { const seen = new Set(); return arr.filter(x => (seen.has(x) ? false : (seen.add(x), true))); }

  function minePhrases(jd) {
    // very small phrase miner: keep 2–3 word chunks that look like skills/tools
    const low = String(jd || "").toLowerCase();
    const cand = [
      "ruby on rails","react native","react","typescript","javascript","python",
      "postgresql","sql","linux","github actions","playwright","flask","power bi",
      "machine learning","computer vision","customer service","inventory","pos",
      "excel","powerpoint","outlook","microsoft office","ap style","cms"
    ];
    const hits = [];
    for (const p of cand) if (low.includes(p)) hits.push(p);
    return uniq(hits);
  }

  function tokensFrom(text) {
    const arr = toks(text).filter((w) => !STOP.has(w));
    const set = new Set(arr);
    // add split variants for hyphenated tokens
    arr.forEach((w) => {
      if (w.includes("-")) {
        w.split("-").forEach((p) => p && set.add(p));
        set.add(w.replace(/-/g, ""));
      }
    });
    return set;
  }

  function computeAtsScore(jdText, resumeText) {
    const jdTokens = tokensFrom(jdText || "");
    const resTokens = tokensFrom(resumeText || "");
    const phrases = minePhrases(jdText || "");
    let hits = 0, wants = 0;

    // phrase boosts (count each once)
    for (const ph of phrases) {
      wants++;
      const words = ph.split(/\s+/);
      const ok = words.every((w) => resTokens.has(w));
      if (ok) hits += 2; // phrase gets extra credit
    }

    // unigram coverage
    jdTokens.forEach((t) => {
      wants++;
      if (resTokens.has(t)) hits += 1;
    });

    const score = wants ? (100 * hits / (wants * 1.0)) : 0;
    // Provide diagnostic lists if you ever want to surface later (kept internal here)
    const miss = [];
    jdTokens.forEach((t) => { if (!resTokens.has(t)) miss.push(t); });
    return { score: Math.max(0, Math.min(100, score)), misses: miss.slice(0, 64), phrases };
  }

  function deriveAllowedVocabFromResume(resumePlain) {
    // basic: collect 2+ character tokens that look skill-like
    const arr = toks(resumePlain || "");
    const keep = arr.filter((w) => w.length >= 2 && !STOP.has(w));
    return uniq(keep).slice(0, 200);
  }

  // expose globals used by power-edit.js
  global.computeAtsScore = computeAtsScore;
  global.deriveAllowedVocabFromResume = deriveAllowedVocabFromResume;
})(window);
