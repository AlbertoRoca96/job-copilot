# src/tailor/resume.py
import re
import difflib
from typing import List, Tuple, Dict, Set, Optional
from docx import Document
from docx.text.paragraph import Paragraph
from docx.text.run import Run

from .policies import load_policies  # merges runtime + base

WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]{1,}")

# Canonical tech casing for added clauses (keeps ATS-safe tokens but looks polished)
CANON = {
    "c++": "C++",
    "python": "Python",
    "pytorch": "PyTorch",
    "tensorflow": "TensorFlow",
    "scikit-learn": "scikit-learn",
    "sklearn": "scikit-learn",
    "xgboost": "XGBoost",
    "javascript": "JavaScript",
    "typescript": "TypeScript",
    "react": "React",
    "react native": "React Native",
    "expo": "Expo",
    "opencv": "OpenCV",
    "sql": "SQL",
    "postgres": "Postgres",
    "postgresql": "Postgres",
    "supabase": "Supabase",
    "github actions": "GitHub Actions",
    "ci": "CI",
    "nlp": "NLP",
    "ml": "ML",
    "rag": "RAG",
    "webassembly": "WebAssembly",
    "wasm": "WebAssembly",
}

# ---------- helpers ----------

def tokens(text: str) -> Set[str]:
    return set(WORD_RE.findall((text or "").lower()))

def normalize_ws(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()

class ChangeLog:
    """
    UI-facing granular changes. We DO NOT relabel sections:
      - anchor_section: the fixed resume section label (e.g., "Projects")
      - anchor: an optional finer-grained anchor (e.g., "Projects • bullet #2")
    """
    def __init__(self):
        self.items: List[dict] = []

    def add(self, section: str, before: str, after: str,
            reason: str, inserted_sentence: Optional[str] = None,
            anchor: Optional[str] = None):
        self.items.append({
            "anchor_section": (section or "").strip(),
            "anchor": (anchor or "").strip() or None,
            "original_paragraph_text": (before or "").strip(),
            "modified_paragraph_text": (after or "").strip(),
            "inserted_sentence": (inserted_sentence or "").strip() or None,
            "reason": reason
        })

def find_section_ranges(doc: Document, section_titles: List[str]) -> Dict[str, Tuple[int, int]]:
    wants = [normalize_ws(t).lower() for t in section_titles]
    hits: Dict[str, int] = {}
    for i, p in enumerate(doc.paragraphs):
        t = normalize_ws(p.text).lower()
        for w in wants:
            if t == w:
                hits[w] = i
    ranges: Dict[str, Tuple[int, int]] = {}
    sorted_hits = sorted(hits.items(), key=lambda kv: kv[1])
    for k, start in sorted_hits:
        later = [v for _, v in sorted_hits if v > start]
        end = later[0] if later else len(doc.paragraphs)
        ranges[k] = (start, end)
    return ranges

def paragraph_is_bullet(p: Paragraph) -> bool:
    # Heuristic: list-ish style name OR leading glyph
    try:
        name = (getattr(p.style, "name", "") or "").lower()
    except Exception:
        name = ""
    if "list" in name or "bullet" in name or "number" in name:
        return True
    t = normalize_ws(p.text)
    return t.startswith(("•", "-", "–", "·"))

def copy_format(from_run: Run, to_run: Run):
    try:
        to_run.font.name = from_run.font.name
        to_run.font.size = from_run.font.size
        to_run.font.bold = from_run.font.bold
        to_run.font.italic = from_run.font.italic
        to_run.font.underline = from_run.font.underline
        try:
            to_run.style = from_run.style
        except Exception:
            pass
    except Exception:
        pass

def _dominant_nonlink_run(p: Paragraph) -> Optional[Run]:
    best, best_len = None, -1
    for r in p.runs:
        txt = (r.text or "")
        style_name = (getattr(r.style, "name", "") or "").lower()
        if not txt.strip():
            continue
        if "hyperlink" in style_name:
            continue
        L = len(txt.strip())
        if L > best_len:
            best, best_len = r, L
    if best is None:
        for r in reversed(p.runs):
            if (r.text or "").strip():
                return r
    return best

def canonicalize_clause(clause: str) -> str:
    s = clause or ""
    for k in sorted(CANON.keys(), key=len, reverse=True):
        pattern = re.compile(rf"\b{re.escape(k)}\b", flags=re.IGNORECASE)
        s = pattern.sub(CANON[k], s)
    return s

def build_added_sentence_from_clause(clause: str) -> str:
    """
    Produce a short, grammatical sentence.
    - If clause already starts with a verb (incl. editorial verbs), append as-is.
    - If it starts with 'using/with', rewrite to 'Using …'.
    - Otherwise, capitalize and append as a sentence.
    """
    if not clause:
        return ""
    canon = canonicalize_clause((clause or "").strip().rstrip("."))

    verb_pat = (
        r"^(built|improved|optimized|implemented|designed|delivered|shipped|reduced|"
        r"increased|created|developed|automated|migrated|refactored|scaled|"
        r"edited|proofread|copyedited|copy-edited|fact-checked|coordinated|scheduled|"
        r"published|wrote|curated|formatted|produced|managed|monitored|organized|drafted)\s+(.+)$"
    )
    m = re.match(verb_pat, canon, flags=re.IGNORECASE)
    if m:
        verb = m.group(1)
        rest = m.group(2)
        cap = verb[:1].upper() + verb[1:]
        return f" {cap} {rest}."
    m2 = re.match(r"^(using|with)\s+(.+)$", canon, flags=re.IGNORECASE)
    if m2:
        return f" Using {m2.group(2)}."
    return f" {canon[:1].upper() + canon[1:]}."

# ---------- policy selection ----------

_GENERIC = {"data", "software", "engineer", "engineering"}

def _policy_score(policy: dict, stoks: Set[str], jd_vocab: Set[str]) -> float:
    jd_cues = set(policy.get("jd_cues") or [])
    bullet_cues = set(policy.get("bullet_cues") or [])
    overlap_jd = len(jd_vocab & jd_cues) if jd_cues else 0
    overlap_bul = len(stoks & bullet_cues) if bullet_cues else 0
    penalty = -1.0 if jd_cues and all(c in _GENERIC for c in jd_cues) else 0.0
    boost = 1.0 if policy.get("_source") == "runtime" else 0.0
    return 2.0 * overlap_jd + 1.0 * overlap_bul + boost + penalty

def _readability_ok(clause: str) -> bool:
    s = (clause or "").strip()
    if not s:
        return False
    w = [w for w in s.split() if w.strip()]
    if not (4 <= len(w) <= 18):
        return False
    if s.count(',') > 2 or s.count('/') > 2:
        return False
    VAGUE = {"various","multiple","numerous","optimize","synergy","innovative"}
    toks = tokens(s)
    if len(VAGUE & toks) >= 2:
        return False
    return True

def choose_policy_for_sentence(sentence: str,
                               jd_vocab: Set[str],
                               allowed_vocab: Set[str],
                               policies: List[dict],
                               used_clauses: Set[str]) -> Optional[str]:
    stoks = tokens(sentence)
    best: Optional[dict] = None
    best_score = -1e9
    for pol in policies:
        clause = (pol.get("clause") or "").strip()
        if not clause:
            continue
        lc_clause = clause.lower()
        if lc_clause in used_clauses:
            continue
        if not _readability_ok(clause):
            continue
        req = set((pol.get("requires_any") or []))
        if req and not (allowed_vocab & req):
            continue
        bullet_cues = set(pol.get("bullet_cues") or [])
        if bullet_cues and not (stoks & bullet_cues):
            continue
        if difflib.SequenceMatcher(None, normalize_ws(sentence.lower()),
                                   normalize_ws(lc_clause)).ratio() > 0.85:
            continue
        score = _policy_score(pol, stoks, jd_vocab)
        if score > best_score:
            best_score = score
            best = pol
    if not best or best_score <= 0:
        return None
    used_clauses.add(best["clause"].lower())
    return best["clause"]

# ---------- rewriting passes ----------

def _rewrite_bullets_in_place(paragraphs: List[Paragraph],
                              start: int, end: int,
                              jd_vocab: Set[str],
                              allowed_vocab: Set[str],
                              policies: List[dict],
                              logger: ChangeLog,
                              section_label: str,
                              max_rewrites: int = 3,
                              used_clauses: Optional[Set[str]] = None):
    if used_clauses is None:
        used_clauses = set()
    bullet_idxs = [i for i in range(start, end) if paragraph_is_bullet(paragraphs[i])]
    rewrites = 0
    for idx, para_idx in enumerate(bullet_idxs):
        if rewrites >= max_rewrites:
            break
        p = paragraphs[para_idx]
        before = p.text
        clause = choose_policy_for_sentence(before, jd_vocab, allowed_vocab, policies, used_clauses)
        if not clause:
            continue
        if len(before) > 350:
            continue
        added = build_added_sentence_from_clause(clause)
        base = _dominant_nonlink_run(p)
        if base is None:
            p.add_run(added)
        else:
            r = p.add_run(added)
            copy_format(base, r)
        logger.add(section_label, before, p.text,
                   reason=f"Aligned to JD via clause: “{canonicalize_clause(clause)}”",
                   inserted_sentence=added,
                   anchor=f"{section_label} • bullet #{idx+1}")
        rewrites += 1

def reorder_or_annotate_skills(paragraphs: List[Paragraph],
                               start: int, end: int,
                               prioritized: List[str],
                               logger: ChangeLog):
    def reorder_line_text(text: str, prio: List[str]) -> str:
        import re as _re
        items = [normalize_ws(x) for x in _re.split(r",\s*", text) if x.strip()]
        if not items:
            return text
        by_lc = {x.lower(): x for x in items}
        seen, ordered = set(), []
        for k in prio:
            lc = k.lower()
            if lc in by_lc and lc not in seen:
                ordered.append(by_lc[lc]); seen.add(lc)
        for x in items:
            if x.lower() not in seen:
                ordered.append(x)
        return ", ".join(ordered)

    for i in range(start, end):
        p = paragraphs[i]
        t = normalize_ws(p.text)
        if not t or paragraph_is_bullet(p) or "," not in t or len(t) >= 500:
            continue
        prio_present = [k for k in prioritized if k.lower() in tokens(t)]
        if len(p.runs) == 1:
            before = p.runs[0].text
            after = reorder_line_text(before, prio_present)
            if after != before:
                p.runs[0].text = after
                logger.add("Technical Skills", before, after,
                           reason="Reordered to surface JD-matching skills already present.")
        else:
            if prio_present:
                before = p.text
                r = p.add_run(f" (Priority: {', '.join(prio_present[:6])})")
                last = next((run for run in reversed(p.runs) if normalize_ws(run.text)), None)
                if last:
                    copy_format(last, r)
                logger.add("Technical Skills", before, p.text,
                           reason="Annotated priorities without altering styling.")
        return  # only the first candidate line

def tailor_docx_in_place(doc: Document,
                         jd_keywords: List[str],
                         allowed_vocab_list: List[str]):
    """
    Directly tailor the existing resume document:
      - Reorder/annotate skills lines.
      - Append concise JD-aligned sentences to bullets in Projects and Work Experience.
      - Return UI-ready granular change objects.
    """
    logger = ChangeLog()
    policies = load_policies()
    jd_vocab = set(k.lower() for k in jd_keywords)
    allowed_vocab = set(k.lower() for k in allowed_vocab_list)
    used_clauses: Set[str] = set()

    # Be generous with heading synonyms—user templates vary.
    ranges = find_section_ranges(doc, [
        "Education",
        "Side Projects", "Projects", "Project Experience",
        "Work Experience", "Professional Experience", "Experience",
        "Technical Skills", "Skills", "Core Skills",
        "Workshops", "References",
    ])
    pars = doc.paragraphs

    # Skills
    for key in ("technical skills", "skills", "core skills"):
        if key in ranges:
            s, e = ranges[key]
            reorder_or_annotate_skills(pars, s, e, list(jd_vocab), logger)
            break

    # Projects / Side Projects
    for sec in ("side projects", "projects", "project experience"):
        if sec in ranges:
            s, e = ranges[sec]
            _rewrite_bullets_in_place(
                pars, s, e, jd_vocab, allowed_vocab, policies,
                logger, "Projects", max_rewrites=3, used_clauses=used_clauses
            )

    # Work Experience
    for sec, label in (
        ("work experience", "Work Experience"),
        ("professional experience", "Work Experience"),
        ("experience", "Work Experience"),
    ):
        if sec in ranges:
            s, e = ranges[sec]
            _rewrite_bullets_in_place(
                pars, s, e, jd_vocab, allowed_vocab, policies, logger,
                label, max_rewrites=3, used_clauses=used_clauses
            )
            break

    return logger.items
