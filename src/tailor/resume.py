# src/tailor/resume.py
import re
import difflib
from typing import List, Tuple, Dict, Set, Optional
from docx import Document
from docx.text.paragraph import Paragraph
from docx.text.run import Run

from .policies import load_policies  # still available (back-up), but default is inline inject

WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]{1,}")

# Canonical tech (and common tools) casing for added phrases
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
    # office / editorial / misc
    "microsoft office": "Microsoft Office",
    "word": "Word",
    "excel": "Excel",
    "powerpoint": "PowerPoint",
    "outlook": "Outlook",
    "adobe": "Adobe",
    "photoshop": "Photoshop",
    "illustrator": "Illustrator",
    "indesign": "InDesign",
    "power bi": "Power BI",
    "cms": "CMS",
    "seo": "SEO",
}

def tokens(text: str) -> Set[str]:
    return set(WORD_RE.findall((text or "").lower()))

def normalize_ws(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()

# ---------- change log (UI-facing) ----------

class ChangeLog:
    def __init__(self):
        self.items: List[dict] = []

    def add(self, section: str, before: str, after: str,
            reason: str, inserted_sentence: Optional[str] = None,
            anchor: Optional[str] = None):
        self.items.append({
            "anchor_section": (anchor or section or "").strip(),
            "original_paragraph_text": (before or "").strip(),
            "modified_paragraph_text": (after or "").strip(),
            "inserted_sentence": (inserted_sentence or "").strip() or None,
            "reason": reason
        })

# ---------- document helpers ----------

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

def _canon(s: str) -> str:
    out = s or ""
    for k in sorted(CANON.keys(), key=len, reverse=True):
        out = re.sub(rf"\b{re.escape(k)}\b", CANON[k], out, flags=re.IGNORECASE)
    return out

# ---------- inline injection ----------

def _dedup_ordered(seq: List[str]) -> List[str]:
    seen = set(); out = []
    for x in seq:
        k = (x or "").strip().lower()
        if not k or k in seen:
            continue
        seen.add(k); out.append(x)
    return out

def _choose_inline_targets(bullet_text: str,
                           jd_keywords: List[str],
                           allowed_vocab: Set[str],
                           cap: int = 3) -> List[str]:
    present = tokens(bullet_text)
    # Only inject terms we "allow" and that are missing from the bullet
    cands = [k for k in jd_keywords if k and k.lower() in allowed_vocab and k.lower() not in present]
    cands = [k for k in cands if len(k) <= 40]           # avoid very long phrases
    cands = _dedup_ordered(cands)[:cap]
    return cands

def _append_inline(p: Paragraph, phrase: str) -> str:
    base = _dominant_nonlink_run(p)
    added = f" — {phrase}"
    if base is None:
        p.add_run(added)
        return added
    r = p.add_run(added)
    copy_format(base, r)
    return added

def _inject_into_comma_list(text: str, add_items: List[str]) -> Optional[str]:
    """
    If a bullet already has a comma-separated list or (...) list,
    add new items at the end of that list. Otherwise return None.
    """
    t = text
    # parenthetical list
    m = re.search(r"\(([^)]+)\)", t)
    if m:
        inside = m.group(1).strip()
        if inside:
            new_inside = inside
            if not new_inside.endswith(",") and not new_inside.endswith(";"):
                new_inside += ", "
            new_inside += ", ".join(add_items)
            return t[:m.start(1)] + new_inside + t[m.end(1):]
    # plain comma list near the end
    if "," in t and len(t) < 400:
        if t.endswith("."):
            t2 = t[:-1]
            if not t2.endswith(","):
                t2 += ", "
            t2 += ", ".join(add_items)
            return t2 + "."
        else:
            t2 = t
            if not t2.endswith(","):
                t2 += ", "
            t2 += ", ".join(add_items)
            return t2
    return None

def _inject_keywords_inline(p: Paragraph,
                            jd_keywords: List[str],
                            allowed_vocab: Set[str]) -> Optional[str]:
    """
    Try to inject keywords inline. Strategy:
      1) If the bullet contains a (...) or comma list, append missing keywords there.
      2) Else, append a short em-dash phrase: " — Adobe, Outlook".
    Returns the exact added phrase (for change log), or None if nothing changed.
    """
    before = p.text
    adds = _choose_inline_targets(before, jd_keywords, allowed_vocab, cap=3)
    if not adds:
        return None
    adds_canon = [_canon(a) for a in adds]
    # attempt list injection
    updated = _inject_into_comma_list(before, adds_canon)
    if updated:
        p.text = updated
        return ", ".join(adds_canon)
    # fallback: em-dash phrase
    phrase = ", ".join(adds_canon)
    _append_inline(p, phrase)
    return phrase

# ---------- optional policy (disabled when inline_only=True) ----------

_GENERIC = {"data", "software", "engineer", "engineering"}

def _policy_score(policy: dict, stoks: Set[str], jd_vocab: Set[str]) -> float:
    jd_cues = set(policy.get("jd_cues") or [])
    bullet_cues = set(policy.get("bullet_cues") or [])
    overlap_jd = len(jd_vocab & jd_cues) if jd_cues else 0
    overlap_bul = len(stoks & bullet_cues) if bullet_cues else 0
    penalty = -1.0 if jd_cues and all(c in _GENERIC for c in jd_cues) else 0.0
    boost = 1.0 if policy.get("_source") == "runtime" else 0.0
    return 2.0 * overlap_jd + 1.0 * overlap_bul + boost + penalty

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
        req = set((pol.get("requires_any") or []))
        if req and not (allowed_vocab & req):
            continue
        bullet_cues = set(pol.get("bullet_cues") or [])
        if bullet_cues and not (stoks & bullet_cues):
            continue
        if difflib.SequenceMatcher(None, normalize_ws(sentence.lower()), normalize_ws(lc_clause)).ratio() > 0.85:
            continue
        score = _policy_score(pol, stoks, jd_vocab)
        if score > best_score:
            best_score = score
            best = pol
    if not best or best_score <= 0:
        return None
    used_clauses.add(best["clause"].lower())
    return best["clause"]

# ---------- passes ----------

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

def _rewrite_bullets_inline(paragraphs: List[Paragraph],
                            start: int, end: int,
                            jd_vocab: Set[str],
                            allowed_vocab: Set[str],
                            logger: ChangeLog,
                            section_label: str):
    added_any = False
    for idx in range(start, end):
        p = paragraphs[idx]
        if not paragraph_is_bullet(p):
            continue
        before = p.text
        phrase = _inject_keywords_inline(p, list(jd_vocab), allowed_vocab)
        if phrase:
            logger.add(section_label, before, p.text,
                       reason="Injected inline JD keywords.",
                       inserted_sentence=" — " + phrase,
                       anchor=f"{section_label} • bullet")
            added_any = True
    return added_any

def tailor_docx_in_place(doc: Document,
                         jd_keywords: List[str],
                         allowed_vocab_list: List[str],
                         inline_only: bool = True):
    """
    Tailor the existing resume **in place**:
      - Skills line: reorder/annotate by JD priority.
      - Projects & Work Experience: inject JD keywords **inline** (no fabricated sentences).
      - If inline_only=False, we can still append short policy phrases as a fallback.
    """
    logger = ChangeLog()
    policies = load_policies()  # available if you ever re-enable clause append
    jd_vocab = set(k.lower() for k in jd_keywords)
    allowed_vocab = set(k.lower() for k in allowed_vocab_list)
    used_clauses: Set[str] = set()

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

    # Projects
    for sec in ("side projects", "projects", "project experience"):
        if sec in ranges:
            s, e = ranges[sec]
            _rewrite_bullets_inline(pars, s, e, jd_vocab, allowed_vocab, logger, "Projects")

    # Work Experience
    for sec, label in (
        ("work experience", "Work Experience"),
        ("professional experience", "Work Experience"),
        ("experience", "Work Experience"),
    ):
        if sec in ranges:
            s, e = ranges[sec]
            changed = _rewrite_bullets_inline(pars, s, e, jd_vocab, allowed_vocab, logger, label)
            if (not changed) and (not inline_only):
                # Optional fallback: at most 2 short clause appends
                bullet_idxs = [i for i in range(s, e) if paragraph_is_bullet(pars[i])]
                for i, para_idx in enumerate(bullet_idxs[:2]):
                    p = pars[para_idx]
                    before = p.text
                    clause = choose_policy_for_sentence(before, jd_vocab, allowed_vocab, policies, used_clauses)
                    if not clause or len(before) > 350:
                        continue
                    # append as very short em-dash phrase, NOT a new sentence
                    phrase = re.sub(r"^(built|improved|optimized|implemented|designed|delivered|shipped|reduced|increased|created|developed|automated|migrated|refactored|scaled)\s+",
                                    "", clause, flags=re.IGNORECASE).strip().rstrip(".")
                    phrase = _canon(phrase)
                    r = p.add_run(" — " + phrase)
                    base = _dominant_nonlink_run(p)
                    if base: copy_format(base, r)
                    logger.add(label, before, p.text,
                               reason=f"Aligned to JD via clause",
                               inserted_sentence=" — " + phrase,
                               anchor=f"{label} • bullet")
            break

    return logger.items
