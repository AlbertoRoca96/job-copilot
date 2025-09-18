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
    Return {lowercased_title: (start_idx, end_idx_exclusive)} for paragraphs whose text
    equals a section heading (case-insensitive, trimmed). If not found, omit.
    """
    wants = [normalize_ws(t).lower() for t in section_titles]
    hits = {}
    for i, p in enumerate(doc.paragraphs):
        t = normalize_ws(p.text).lower()
        for w in wants:
            if t == w:
                hits[w] = i
    # build ranges
    ranges = {}
    sorted_hits = sorted(hits.items(), key=lambda kv: kv[1])
    for k, start in sorted_hits:
        later = [v for _, v in sorted_hits if v > start]
        end = later[0] if later else len(doc.paragraphs)
        ranges[k] = (start, end)
    return ranges

def paragraph_is_bullet(p) -> bool:
    name = (p.style.name or "").lower()
    if "list" in name or "bullet" in name or "number" in name:
        return True
    # fallback for inline bullets
    t = normalize_ws(p.text)
    return t.startswith(("•", "-", "–", "·"))

def best_match_idx(source_lines: List[str], target_text: str) -> int:
    target = normalize_ws(target_text)
    if not target:
        return -1
    scores = [difflib.SequenceMatcher(None, normalize_ws(s), target).ratio() for s in source_lines]
    if not scores:
        return -1
    i = max(range(len(scores)), key=lambda k: scores[k])
    return i if scores[i] >= 0.58 else -1  # slightly strict so we don't rewrite the wrong bullet

def reorder_skills_line(text: str, prioritized: List[str]) -> str:
    """
    Keep your single-line skills format, move prioritized terms forward IF they already exist.
    """
    items = [normalize_ws(x) for x in re.split(r",\s*", text) if x.strip()]
    if not items:
        return text
    by_lc = {x.lower(): x for x in items}
    seen, ordered = set(), []
    for k in prioritized:
        lc = k.lower()
        if lc in by_lc and lc not in seen:
            ordered.append(by_lc[lc]); seen.add(lc)
    for x in items:
        if x.lower() not in seen:
            ordered.append(x)
    return ", ".join(ordered)

def inject_keywords_parenthetical(sentence: str, kws: List[str]) -> str:
    """
    Append up to 2 *missing* keywords in a tiny parenthetical. Does not change style or structure.
    Only adds keywords that aren't already present.
    """
    present = tokens(sentence)
    missing = [k for k in kws if k.lower() not in present]
    if not missing:
        return sentence
    add = ", ".join(missing[:2])
    if not add:
        return sentence
    if sentence.endswith("."):
        return sentence[:-1] + f" ({add})."
    return sentence + f" ({add})"

def rewrite_bullets_in_section(paragraphs, start: int, end: int,
                               target_bullets: List[str], ats_keywords: List[str],
                               max_rewrites=3):
    """
    Inside [start,end), find bullet paragraphs and rewrite up to max_rewrites by
    appending a tiny ATS keyword parenthetical. We pick bullets that best match your
    curated portfolio bullets so we touch relevant lines.
    """
    bullet_idxs = [i for i in range(start, end) if paragraph_is_bullet(paragraphs[i])]
    bullet_texts = [normalize_ws(paragraphs[i].text) for i in bullet_idxs]
    rewrites = 0
    for tb in target_bullets:
        if rewrites >= max_rewrites:
            break
        j = best_match_idx(bullet_texts, tb)
        if j == -1:
            continue
        para_idx = bullet_idxs[j]
        paragraphs[para_idx].text = inject_keywords_parenthetical(paragraphs[para_idx].text, ats_keywords)
        rewrites += 1

def rewrite_skills(paragraphs, start: int, end: int, prioritized_keywords: List[str]):
    """
    Reorder the FIRST non-bullet, comma-separated paragraph after the 'Technical Skills'
    heading (most resumes use that line). We only reorder terms already present.
    """
    for i in range(start, end):
        p = paragraphs[i]
        t = normalize_ws(p.text)
        if not t:             # skip empty spacing
            continue
        if paragraph_is_bullet(p):
            continue
        if "," in t and len(t) < 500:
            p.text = reorder_skills_line(p.text, prioritized_keywords)
            return

def tailor_docx_in_place(doc: Document,
                         portfolio_bullets: Dict[str, List[str]],
                         ats_keywords: List[str],
                         prioritized_skills: List[str]):
    """
    No new paragraphs/sections. We only:
      - add tiny ATS parentheticals to up to 3 bullets in Projects/Work Experience
      - reorder the first line under 'Technical Skills'
    """
    # headings your resume uses
    ranges = find_section_ranges(doc, [
        "Education",
        "Side Projects", "Projects",
        "Work Experience",
        "Technical Skills",
        "Workshops",
        "References",
    ])
    pars = doc.paragraphs

    # Projects
    for sec in ("side projects", "projects"):
        if sec in ranges:
            s, e = ranges[sec]
            rewrite_bullets_in_section(pars, s, e, portfolio_bullets.get("Side Projects", []) + portfolio_bullets.get("Projects", []), ats_keywords, max_rewrites=3)

    # Work Experience
    if "work experience" in ranges:
        s, e = ranges["work experience"]
        rewrite_bullets_in_section(pars, s, e, portfolio_bullets.get("Work Experience", []), ats_keywords, max_rewrites=3)

    # Technical Skills
    if "technical skills" in ranges:
        s, e = ranges["technical skills"]
        rewrite_skills(pars, s, e, prioritized_skills)
