import re
import difflib
from typing import List, Tuple, Dict, Set
from docx import Document
from docx.text.paragraph import Paragraph
from docx.text.run import Run

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
    ranges = {}
    sorted_hits = sorted(hits.items(), key=lambda kv: kv[1])
    for k, start in sorted_hits:
        later = [v for _, v in sorted_hits if v > start]
        end = later[0] if later else len(doc.paragraphs)
        ranges[k] = (start, end)
    return ranges

def paragraph_is_bullet(p: Paragraph) -> bool:
    name = (p.style.name or "").lower()
    if "list" in name or "bullet" in name or "number" in name:
        return True
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
    return i if scores[i] >= 0.58 else -1

def reorder_skills_line_text(text: str, prioritized: List[str]) -> str:
    """
    Keep your comma-separated skills format, move prioritized terms forward IF they already exist.
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

def copy_format(from_run: Run, to_run: Run):
    """Copy basic character formatting so the appended text looks identical."""
    try:
        to_run.font.name = from_run.font.name
        to_run.font.size = from_run.font.size
        to_run.font.bold = from_run.font.bold
        to_run.font.italic = from_run.font.italic
        to_run.font.underline = from_run.font.underline
    except Exception:
        pass  # be tolerant across different docs

def append_parenthetical_run(p: Paragraph, suffix: str):
    """
    Append e.g. ' (react, postgresql).' as a new run, copying formatting from the last existing run.
    Does NOT alter existing runs (so hyperlinks and emphasis remain).
    """
    if not suffix:
        return
    # Respect sentence final '.'
    full = p.text.rstrip()
    add = suffix
    if full.endswith("."):
        add = " " + suffix[:-1] + "." if suffix.endswith(")") else " " + suffix + "."
        # but we won't modify the old period—just append with our own punctuation
    else:
        add = " " + suffix
    r = p.add_run(add)
    # copy formatting from last run if available
    last = None
    for run in p.runs[::-1]:
        if normalize_ws(run.text):
            last = run
            break
    if last:
        copy_format(last, r)

def inject_keywords_parenthetical(paragraph: Paragraph, kws: List[str]):
    """
    Add up to 2 missing keywords in a small parenthetical at the end of the paragraph,
    preserving all original formatting/hyperlinks.
    """
    present = tokens(paragraph.text)
    missing = [k for k in kws if k.lower() not in present]
    if not missing:
        return
    label = ", ".join(missing[:2])
    append_parenthetical_run(paragraph, f"({label})")

def rewrite_bullets_in_section(paragraphs, start: int, end: int,
                               target_bullets: List[str], ats_keywords: List[str],
                               max_rewrites=3):
    """
    Inside [start,end), locate bullet paragraphs and append a tiny ATS parenthetical
    to up to max_rewrites bullets that best match your curated portfolio bullets.
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
        inject_keywords_parenthetical(paragraphs[para_idx], ats_keywords)
        rewrites += 1

def rewrite_skills(paragraphs, start: int, end: int, prioritized_keywords: List[str]):
    """
    Reorder the FIRST non-bullet, comma-separated paragraph under 'Technical Skills'
    **only if it is a single run** (safe). If multiple runs exist (styled chunks),
    leave the line intact and append a ' (Priority: ...)' parenthetical as a separate run.
    """
    for i in range(start, end):
        p = paragraphs[i]
        t = normalize_ws(p.text)
        if not t or paragraph_is_bullet(p):
            continue
        if "," not in t or len(t) >= 500:
            continue

        if len(p.runs) == 1:
            # safe: rewrite the single run text
            new_text = reorder_skills_line_text(p.runs[0].text, prioritized_keywords)
            p.runs[0].text = new_text
        else:
            # preserve styling: append a parenthetical instead of rewriting runs
            chosen = [k for k in prioritized_keywords if k.lower() in tokens(t)]
            if chosen:
                append_parenthetical_run(p, f"(Priority: {', '.join(chosen[:6])})")
        return  # only touch the first candidate line

def tailor_docx_in_place(doc: Document,
                         portfolio_bullets: Dict[str, List[str]],
                         ats_keywords: List[str],
                         prioritized_skills: List[str]):
    """
    No new paragraphs/sections. We only:
      - append tiny ATS parentheticals to up to 3 bullets in Projects/Work Experience
      - reorder (or parenthetical-annotate) the first line under 'Technical Skills'
    """
    ranges = find_section_ranges(doc, [
        "Education",
        "Side Projects", "Projects",
        "Work Experience",
        "Technical Skills",
        "Workshops",
        "References",
    ])
    pars = doc.paragraphs

    # Projects / Side Projects
    for sec in ("side projects", "projects"):
        if sec in ranges:
            s, e = ranges[sec]
            source = (portfolio_bullets.get("Side Projects", []) +
                      portfolio_bullets.get("Projects", []))
            rewrite_bullets_in_section(pars, s, e, source, ats_keywords, max_rewrites=3)

    # Work Experience
    if "work experience" in ranges:
        s, e = ranges["work experience"]
        rewrite_bullets_in_section(pars, s, e, portfolio_bullets.get("Work Experience", []),
                                   ats_keywords, max_rewrites=3)

    # Technical Skills
    if "technical skills" in ranges:
        s, e = ranges["technical skills"]
        rewrite_skills(pars, s, e, prioritized_skills)
