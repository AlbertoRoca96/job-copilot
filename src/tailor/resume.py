import re
import difflib
from typing import List, Tuple, Dict, Set
from docx import Document

WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]{1,}")

def tokens(text: str) -> Set[str]:
    return set(WORD_RE.findall((text or "").lower()))

def normalize_ws(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()

def find_section_ranges(doc: Document, section_titles: List[str]) -> Dict[str, Tuple[int,int]]:
    """
    Returns {title: (start_idx, end_idx_exclusive)} for paragraphs whose text
    matches a section heading (case-insensitive exact match after trimming).
    If a section is not found, it's omitted.
    """
    # normalize titles
    want = [normalize_ws(t).lower() for t in section_titles]
    idx_by_title = {}
    for i, p in enumerate(doc.paragraphs):
        t = normalize_ws(p.text).lower()
        for w in want:
            if t == w:
                idx_by_title[w] = i

    ranges = {}
    # build ranges by next heading (order of appearance)
    sorted_hits = sorted(idx_by_title.items(), key=lambda kv: kv[1])
    for k, start in sorted_hits:
        # end is next hit start or end of doc
        later_starts = [v for kk, v in sorted_hits if v > start]
        end = later_starts[0] if later_starts else len(doc.paragraphs)
        ranges[k] = (start, end)
    return ranges

def paragraph_is_bullet(p) -> bool:
    """
    Heuristic: treat paragraph as bullet if its style name contains 'List' or it has numbering/bullet formatting.
    python-docx doesn't expose list props directly without deeper XML;
    style name heuristic works on most resumes exported from Word/Google Docs.
    """
    name = (p.style.name or "").lower()
    if "list" in name or "bullet" in name or "number" in name:
        return True
    # fallback simple bullets like "•", "-", "·" at start
    if normalize_ws(p.text).startswith(("•", "-", "–", "·")):
        return True
    return False

def best_match_idx(source_lines: List[str], target_text: str) -> int:
    """Find the index in source_lines whose text is most similar to target_text (0..1 score), return -1 if very low."""
    target = normalize_ws(target_text)
    if not target:
        return -1
    scores = [difflib.SequenceMatcher(None, normalize_ws(s), target).ratio() for s in source_lines]
    if not scores:
        return -1
    best_i = max(range(len(scores)), key=lambda i: scores[i])
    return best_i if scores[best_i] >= 0.55 else -1  # threshold; tweak if needed

def reorder_skills_line(text: str, prioritized: List[str]) -> str:
    """
    Given a comma-separated skills line, move prioritized skills to the front (keeping the same punctuation).
    This preserves your single-line skills formatting but surfaces ATS keywords earlier.
    """
    items = [normalize_ws(x) for x in re.split(r",\s*", text) if x.strip()]
    if not items:
        return text
    # map lowercase -> original to preserve casing as written
    original_by_lc = {x.lower(): x for x in items}
    seen = set()
    ordered = []
    for k in prioritized:
        lc = k.lower()
        if lc in original_by_lc and lc not in seen:
            ordered.append(original_by_lc[lc]); seen.add(lc)
    for x in items:
        if x.lower() not in seen:
            ordered.append(x)
    return ", ".join(ordered)

def inject_keywords_into_sentence(sentence: str, kws: List[str]) -> str:
    """
    Light-touch augmentation: if sentence doesn't already contain a keyword, append a concise parenthetical
    with up to 2 missing keywords to match JD phrasing. Keeps bullet intact and avoids style changes.
    """
    existing = tokens(sentence)
    missing = [k for k in kws if k.lower() not in existing]
    if not missing:
        return sentence
    add = ", ".join(missing[:2])
    # prefer ending with a short parenthetical
    if sentence.endswith("."):
        return sentence[:-1] + f" ({add})."
    return sentence + f" ({add})"

def rewrite_bullets_in_section(paragraphs, start: int, end: int, target_bullets: List[str], ats_keywords: List[str], max_rewrites=3):
    """
    Within [start,end), find bullet paragraphs and rewrite up to max_rewrites that best
    match target_bullets (from portfolio). We do *surgical* edits: replace only the text (keeps style).
    """
    # collect bullet paragraph indices and their texts
    bullet_idxs = [i for i in range(start, end) if paragraph_is_bullet(paragraphs[i])]
    bullet_texts = [normalize_ws(paragraphs[i].text) for i in bullet_idxs]
    # plan rewrites
    rewrites = 0
    for tb in target_bullets:
        if rewrites >= max_rewrites:
            break
        j = best_match_idx(bullet_texts, tb)
        if j == -1:
            continue
        para_idx = bullet_idxs[j]
        # apply ATS-visible but truthful tweak
        new_text = inject_keywords_into_sentence(paragraphs[para_idx].text, ats_keywords)
        paragraphs[para_idx].text = new_text
        rewrites += 1

def rewrite_skills(paragraphs, start: int, end: int, prioritized_keywords: List[str]):
    """
    Find a likely skills line in [start,end) (non-bullet, comma-separated) and reorder terms
    to bring prioritized keywords forward. Keeps same paragraph/style.
    """
    for i in range(start, end):
        p = paragraphs[i]
        t = normalize_ws(p.text)
        if not paragraph_is_bullet(p) and ("," in t) and len(t) < 400 and "skills" in t.lower():
            p.text = reorder_skills_line(p.text, prioritized_keywords)
            return

def tailor_docx_in_place(doc: Document,
                         portfolio_bullets: Dict[str, List[str]],
                         ats_keywords: List[str],
                         prioritized_skills: List[str]):
    """
    Keeps the doc structure; tweaks:
      - Side Projects / Work Experience: rewrite up to 3 bullets with ATS-safe keywords
      - Technical Skills: reorder line to surface prioritized skills first
    portfolio_bullets: {"Side Projects": [bullet_texts], "Work Experience": [bullet_texts]}
    """
    # Sections we aim for (case-insensitive exact title text)
    ranges = find_section_ranges(doc, ["Side Projects", "Work Experience", "Technical Skills", "Projects"])
    pars = doc.paragraphs

    # Projects / Side Projects
    for sec_name in ["Side Projects", "Projects"]:
        key = sec_name.lower()
        if key in ranges:
            s, e = ranges[key]
            rewrite_bullets_in_section(pars, s, e, portfolio_bullets.get(sec_name, []), ats_keywords, max_rewrites=3)

    # Work Experience
    key = "work experience"
    if key in ranges:
        s, e = ranges[key]
        rewrite_bullets_in_section(pars, s, e, portfolio_bullets.get("Work Experience", []), ats_keywords, max_rewrites=3)

    # Technical Skills — reorder once
    key = "technical skills"
    if key in ranges:
        s, e = ranges[key]
        rewrite_skills(pars, s, e, prioritized_skills)
