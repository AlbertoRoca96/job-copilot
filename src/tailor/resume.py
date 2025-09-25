# src/tailor/resume.py
import re
import difflib
from typing import List, Tuple, Dict, Set, Optional, Callable
from docx import Document
from docx.text.paragraph import Paragraph
from docx.text.run import Run

from .policies import load_policies  # optional fallback clauses (kept for compatibility)

# --------- tokenization & casing ---------

WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]{1,}")

# Canonical casing for common tools/skills (extend as needed)
CANON = {
    # tech
    "c++": "C++", "python": "Python", "pytorch": "PyTorch", "tensorflow": "TensorFlow",
    "scikit-learn": "scikit-learn", "sklearn": "scikit-learn", "xgboost": "XGBoost",
    "javascript": "JavaScript", "typescript": "TypeScript", "react": "React",
    "react native": "React Native", "expo": "Expo", "opencv": "OpenCV", "sql": "SQL",
    "postgres": "Postgres", "postgresql": "Postgres", "supabase": "Supabase",
    "github actions": "GitHub Actions", "ci": "CI", "nlp": "NLP", "ml": "ML",
    "rag": "RAG", "webassembly": "WebAssembly", "wasm": "WebAssembly",
    # office/editorial/etc.
    "microsoft office": "Microsoft Office", "word": "Word", "excel": "Excel",
    "powerpoint": "PowerPoint", "outlook": "Outlook", "adobe": "Adobe",
    "photoshop": "Photoshop", "illustrator": "Illustrator", "indesign": "InDesign",
    "power bi": "Power BI", "cms": "CMS", "seo": "SEO",
}

def tokens(text: str) -> Set[str]:
    return set(WORD_RE.findall((text or "").lower()))

def normalize_ws(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()

def _canon(s: str) -> str:
    out = s or ""
    for k in sorted(CANON.keys(), key=len, reverse=True):
        out = re.sub(rf"\b{re.escape(k)}\b", CANON[k], out, flags=re.IGNORECASE)
    return out

# --------- change log (UI-facing) ---------

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

# --------- document helpers ---------

def find_section_ranges(doc: Document, section_titles: List[str]) -> Dict[str, Tuple[int, int]]:
    """Return {lower_title: (start_idx, end_idx)} (end is exclusive)."""
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
    """Heuristic: list-like style or leading glyph."""
    try:
        name = (getattr(p.style, "name", "") or "").lower()
    except Exception:
        name = ""
    if "list" in name or "bullet" in name or "number" in name:
        return True
    t = normalize_ws(p.text)
    return t.startswith(("•", "-", "–", "·"))

def copy_format(from_run: Run, to_run: Run):
    """Copy common font + style hints."""
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
    """Pick the longest non-hyperlink run as a formatting source."""
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

def _clear_runs(p: Paragraph):
    """Remove all runs (low-level)."""
    for r in list(p.runs):
        try:
            r._element.getparent().remove(r._element)  # noqa
        except Exception:
            pass

def _set_text_preserve_para_style(p: Paragraph, text: str, base: Optional[Run]):
    """
    Assign text as a single run, then re-apply base run formatting so
    we don't end up with default run formatting everywhere.
    """
    p.text = text  # replaces runs with one run; keeps paragraph-level style. :contentReference[oaicite:2]{index=2}
    if base and p.runs:
        copy_format(base, p.runs[0])

# --------- QUOTED LOGIC: Pass 1/2/3 IMPLEMENTATION ---------

# --- Pass 1: listline priorities (Skills & similar) ---
def inject_listline_priorities(doc: Document,
                               jd_keywords: List[str],
                               backoff_terms: List[str],
                               log_change: Callable[[str, str, str, str], None]):
    """
    Reorder inline skill/tool lists and insert plausible synonyms.
    - Detect paragraphs under Skills/Technical Skills sections.
    - Split comma/semicolon lists, normalize tokens.
    - Priority = JD hits (ordered) + backoff terms (ESCO/O*NET).
    - Rebuild the same paragraph text preserving run formatting (best-effort).
    """
    ranges = find_section_ranges(doc, ["Technical Skills", "Skills", "Core Skills"])
    if not ranges:
        return 0

    # choose the first matching skills section
    key = next(iter([k for k in ("technical skills", "skills", "core skills") if k in ranges]), None)
    if not key:
        return 0

    start, end = ranges[key]
    changes = 0
    jd_lc = [k.strip().lower() for k in jd_keywords if k and k.strip()]
    backoff_lc = [k.strip().lower() for k in backoff_terms if k and k.strip()]

    for i in range(start, end):
        p = doc.paragraphs[i]
        t = normalize_ws(p.text)
        if not t or paragraph_is_bullet(p) or len(t) > 600:
            continue

        # detect list-ish lines (commas/semicolons)
        if "," not in t and ";" not in t:
            continue

        # split & normalize
        raw_items = re.split(r"\s*[;,]\s*", t)
        items = [normalize_ws(x) for x in raw_items if x.strip()]
        if not items:
            continue

        present_tokens = tokens(t)
        present_text = t.lower()

        # Priority 1: JD hits that already exist in the line (preserve JD order)
        prio = []
        for k in jd_lc:
            # match as token OR substring for multiword phrases
            if k in present_tokens or k in present_text:
                prio.append(k)

        # Priority 2: backoff terms (ESCO/O*NET-derived) that are missing but plausible
        # Only add if not already present as substring
        to_add = [k for k in backoff_lc if k not in present_text]

        # Reorder existing items by priority (stable)
        by_lc = {x.lower(): x for x in items}
        seen: Set[str] = set()
        ordered: List[str] = []
        for k in prio:
            for cand in list(by_lc.keys()):
                if k == cand and cand not in seen:
                    ordered.append(by_lc[cand]); seen.add(cand)
        for x in items:
            if x.lower() not in seen:
                ordered.append(x)

        # Enrich: add plausible missing items at end (cap to avoid stuffing)
        add_cap = 3
        adds = []
        for k in to_add:
            if len(adds) >= add_cap:
                break
            adds.append(_canon(k))
        after_text = ", ".join(ordered + adds)
        after_text = _canon(after_text)

        if after_text != p.text:
            before = p.text
            base = _dominant_nonlink_run(p)
            _set_text_preserve_para_style(p, after_text, base)
            log_change("Technical Skills", before, after_text, "Reordered/enriched inline skills list.")
            changes += 1
            # We stop after first meaningful skills line to avoid over-editing
            break

    return changes

# --- small utility to locate first sentence boundary ---
def _first_sentence_split(text: str) -> int:
    m = re.search(r'([.!?])(\s|$)', text)
    return (m.start(1) + 1) if m else len(text)

# --- Pass 2: weave phrase into an existing bullet (no new sentence) ---
def weave_phrase_into_bullet(paragraph: Paragraph,
                             phrase: str,
                             copy_format_fn: Callable[[Run, Run], None],
                             log_change: Callable[[str, str, str, str, Optional[str], Optional[str]], None],
                             section_label: str = "Work Experience") -> bool:
    """
    Insert ' using <phrase>' before the first sentence terminator.
    Preserve dominant run format via copy_format(existing_run, new_run).
    """
    phrase = _canon(phrase or "").strip().rstrip(".")
    if not phrase:
        return False

    base = _dominant_nonlink_run(paragraph)
    txt = "".join(r.text for r in paragraph.runs) if paragraph.runs else paragraph.text
    insert_at = _first_sentence_split(txt)
    glue = " " if insert_at and insert_at <= len(txt) and txt[insert_at - 1].isalnum() else ""
    pre, post = txt[:insert_at], txt[insert_at:]
    new_text = pre + f"{glue} using {phrase}" + post

    before = paragraph.text
    # safest path: reset text, then reapply formatting
    _set_text_preserve_para_style(paragraph, new_text, base)
    log_change(section_label, before, paragraph.text,
               reason="Wove JD-aligned phrase inline.",
               inserted_sentence=f" using {phrase}",
               anchor=f"{section_label} • bullet")
    return True

# --- Orchestrator hook inside your existing tailor_docx_in_place() ---
def apply_universal_passes(doc: Document,
                           sections: Optional[Dict[str, Tuple[int, int]]],
                           jd_keywords: List[str],
                           allowed_vocab: Set[str],
                           backoff_terms: List[str],
                           log_change: Callable[[str, str, str, str, Optional[str], Optional[str]], None]) -> int:
    """
    Run Pass 1 for Skills; Pass 2 over bullets; Pass 3 fallback 'Using ...' appends
    if a section had 0 changes.
    """
    total = 0
    # Pass 1: Skills
    total += inject_listline_priorities(doc, jd_keywords, backoff_terms,
                                        lambda sec, b, a, r: log_change(sec, b, a, r, None, sec))

    # Prep sections map
    sections = sections or find_section_ranges(doc, [
        "Side Projects", "Projects", "Project Experience",
        "Work Experience", "Professional Experience", "Experience",
    ])

    # Helper to choose top phrase from JD keywords within allowed vocab
    def choose_top_phrase(jd_kws: List[str], allowed: Set[str]) -> Optional[str]:
        for k in jd_kws:
            if k and k.lower() in allowed and len(k) <= 48:
                return _canon(k)
        return None

    # Pass 2: weave into existing bullets in Projects and Work Experience
    def weave_section(sec_keys: List[str], label: str) -> bool:
        changed = False
        for key in sec_keys:
            if key in sections:
                s, e = sections[key]
                for i in range(s, e):
                    p = doc.paragraphs[i]
                    if not paragraph_is_bullet(p):
                        continue
                    target = choose_top_phrase(jd_keywords, allowed_vocab)
                    if target and weave_phrase_into_bullet(p, target, copy_format, log_change, section_label=label):
                        changed = True
        return changed

    changed_projects = weave_section(["side projects", "projects", "project experience"], "Projects")
    changed_work = weave_section(["work experience", "professional experience", "experience"], "Work Experience")
    total += (1 if changed_projects else 0) + (1 if changed_work else 0)

    # Pass 3: fallback appenders (only if no changes in a section)
    def append_using_phrase_fallback(sec_keys: List[str], label: str) -> bool:
        # find bullets and pick up to two shortest (<220 chars)
        chosen_phrase = choose_top_phrase(jd_keywords, allowed_vocab)
        if not chosen_phrase:
            return False
        for key in sec_keys:
            if key not in sections:
                continue
            s, e = sections[key]
            bullets = [(i, len(doc.paragraphs[i].text)) for i in range(s, e) if paragraph_is_bullet(doc.paragraphs[i])]
            bullets = [b for b in bullets if b[1] < 220]
            bullets.sort(key=lambda x: x[1])
            made = False
            for idx, _ in bullets[:2]:
                p = doc.paragraphs[idx]
                before = p.text
                base = _dominant_nonlink_run(p)
                suffix = f" Using {chosen_phrase}."
                # ensure spacing / punctuation
                text = before.rstrip()
                if text.endswith("."):
                    text = text[:-1]
                new_text = text + suffix
                _set_text_preserve_para_style(p, new_text, base)
                log_change(label, before, p.text,
                           reason="Fallback appender to ensure visible tailoring.",
                           inserted_sentence=suffix.strip(),
                           anchor=f"{label} • bullet")
                made = True
            if made:
                return True
        return False

    if not changed_projects:
        if append_using_phrase_fallback(["side projects", "projects", "project experience"], "Projects"):
            total += 1
    if not changed_work:
        if append_using_phrase_fallback(["work experience", "professional experience", "experience"], "Work Experience"):
            total += 1

    return total

# --------- existing policy machinery (optional/fallback) ---------

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

# --------- public entrypoint ---------

def tailor_docx_in_place(doc: Document,
                         jd_keywords: List[str],
                         allowed_vocab_list: List[str],
                         backoff_terms: Optional[List[str]] = None,
                         inline_only: bool = True) -> List[dict]:
    """
    Tailor the existing resume **in place** with universal passes + optional policy fallback.
      - Pass 1: reorder/enrich Skills inline list(s) using JD + backoff (ESCO/O*NET).
      - Pass 2: weave short phrases into existing bullets (Projects, Work Experience).
      - Pass 3: if a section saw 0 changes, append one concise 'Using <phrase>.' to 1–2 shortest bullets.
      - If inline_only=False, also try short policy clauses (legacy behavior).
    Returns the change log items.
    """
    logger = ChangeLog()
    policies = load_policies()  # remains available if inline_only=False
    jd_vocab = set(k.lower() for k in jd_keywords if k)
    allowed_vocab = set(k.lower() for k in allowed_vocab_list if k)
    backoff_terms = backoff_terms or []

    # sections map once
    sections = find_section_ranges(doc, [
        "Education",
        "Side Projects", "Projects", "Project Experience",
        "Work Experience", "Professional Experience", "Experience",
        "Technical Skills", "Skills", "Core Skills",
        "Workshops", "References",
    ])

    def log_change(sec, before, after, reason, inserted=None, anchor=None):
        logger.add(sec, before, after, reason, inserted_sentence=inserted, anchor=anchor)

    # Universal passes
    apply_universal_passes(doc, sections, jd_keywords, allowed_vocab, backoff_terms, log_change)

    # Optional: policy-based micro-clauses as final fallback (very conservative)
    if not inline_only:
        used_clauses: Set[str] = set()
        for sec_key, label in (
            ("work experience", "Work Experience"),
            ("professional experience", "Work Experience"),
            ("experience", "Work Experience"),
        ):
            if sec_key not in sections:
                continue
            s, e = sections[sec_key]
            for i in range(s, e):
                p = doc.paragraphs[i]
                if not paragraph_is_bullet(p) or len(p.text) > 350:
                    continue
                clause = choose_policy_for_sentence(p.text, jd_vocab, allowed_vocab, policies, used_clauses)
                if not clause:
                    continue
                phrase = re.sub(r"^(built|improved|optimized|implemented|designed|delivered|shipped|reduced|increased|created|developed|automated|migrated|refactored|scaled)\s+",
                                "", clause, flags=re.IGNORECASE).strip().rstrip(".")
                phrase = _canon(phrase)
                before = p.text
                base = _dominant_nonlink_run(p)
                suffix = f" — {phrase}"
                _set_text_preserve_para_style(p, before.rstrip() + suffix, base)
                logger.add(label, before, p.text,
                           reason="Optional policy clause (fallback).",
                           inserted_sentence=suffix.strip(),
                           anchor=f"{label} • bullet")

    return logger.items
