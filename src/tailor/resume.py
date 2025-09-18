import re
import difflib
from typing import List, Tuple, Dict, Set
from docx import Document
from docx.text.paragraph import Paragraph
from docx.text.run import Run

WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]{1,}")

class ChangeLog:
    """Collects human-readable diffs to show on the dashboard."""
    def __init__(self):
        self.items = []  # each: {section, before, after, reason}

    def add(self, section: str, before: str, after: str, reason: str):
        self.items.append({
            "section": section,
            "before": before.strip(),
            "after": after.strip(),
            "reason": reason
        })

def tokens(text: str) -> Set[str]:
    return set(WORD_RE.findall((text or "").lower()))

def normalize_ws(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()

def find_section_ranges(doc: Document, section_titles: List[str]) -> Dict[str, Tuple[int,int]]:
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
    try:
        to_run.font.name = from_run.font.name
        to_run.font.size = from_run.font.size
        to_run.font.bold = from_run.font.bold
        to_run.font.italic = from_run.font.italic
        to_run.font.underline = from_run.font.underline
    except Exception:
        pass

def append_parenthetical_run(p: Paragraph, suffix: str):
    if not suffix:
        return
    full = p.text.rstrip()
    add = " " + suffix if not full.endswith(".") else " " + (suffix[:-1] + "." if suffix.endswith(")") else suffix + ".")
    r = p.add_run(add)
    last = None
    for run in p.runs[::-1]:
        if normalize_ws(run.text):
            last = run
            break
    if last:
        copy_format(last, r)

def inject_keywords_parenthetical(paragraph: Paragraph, kws: List[str]) -> str:
    """Append up to 2 missing keywords; return the AFTER text (for logging)."""
    before = paragraph.text
    present = tokens(before)
    missing = [k for k in kws if k.lower() not in present]
    if not missing:
        return before
    label = ", ".join(missing[:2])
    append_parenthetical_run(paragraph, f"({label})")
    return paragraph.text

def rewrite_bullets_in_section(paragraphs, start: int, end: int,
                               target_bullets: List[str], ats_keywords: List[str],
                               logger: ChangeLog, section_label: str,
                               max_rewrites=3):
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
        before = paragraphs[para_idx].text
        after = inject_keywords_parenthetical(paragraphs[para_idx], ats_keywords)
        if after != before:
            logger.add(section_label, before, after,
                       reason=f"Added ATS keywords seen in JD (limited to your allowed vocab).")
            rewrites += 1

def rewrite_skills(paragraphs, start: int, end: int,
                   prioritized_keywords: List[str], logger: ChangeLog):
    """Reorder single-run skills line; else append '(Priority: ...)' as a run."""
    for i in range(start, end):
        p = paragraphs[i]
        t = normalize_ws(p.text)
        if not t or paragraph_is_bullet(p) or "," not in t or len(t) >= 500:
            continue

        if len(p.runs) == 1:
            before = p.runs[0].text
            after = reorder_skills_line_text(before, prioritized_keywords)
            if after != before:
                p.runs[0].text = after
                logger.add("Technical Skills", before, after,
                           reason="Reordered to surface JD keywords already present in your skills.")
        else:
            chosen = [k for k in prioritized_keywords if k.lower() in tokens(t)]
            if chosen:
                before = p.text
                append_parenthetical_run(p, f"(Priority: {', '.join(chosen[:6])})")
                after = p.text
                if after != before:
                    logger.add("Technical Skills", before, after,
                               reason="Annotated priorities (complex formatting preserved).")
        return  # only touch first candidate line

def tailor_docx_in_place(doc: Document,
                         portfolio_bullets: Dict[str, List[str]],
                         ats_keywords: List[str],
                         prioritized_skills: List[str]):
    """
    Returns a list of change log items describing the minimal edits.
    """
    logger = ChangeLog()

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
            rewrite_bullets_in_section(pars, s, e, source, ats_keywords, logger,
                                       section_label="Side Projects" if sec == "side projects" else "Projects",
                                       max_rewrites=3)

    # Work Experience
    if "work experience" in ranges:
        s, e = ranges["work experience"]
        rewrite_bullets_in_section(pars, s, e, portfolio_bullets.get("Work Experience", []),
                                   ats_keywords, logger, section_label="Work Experience",
                                   max_rewrites=3)

    # Technical Skills
    if "technical skills" in ranges:
        s, e = ranges["technical skills"]
        rewrite_skills(pars, s, e, prioritized_skills, logger)

    return logger.items
