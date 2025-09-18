import re
import difflib
from typing import List, Tuple, Dict, Set
from docx import Document
from docx.text.paragraph import Paragraph
from docx.text.run import Run

WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]{1,}")

class ChangeLog:
    def __init__(self):
        self.items = []

    def add(self, section: str, before: str, after: str, reason: str):
        self.items.append({
            "section": section,
            "before": (before or "").strip(),
            "after": (after or "").strip(),
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
    # append as its own run, keep existing punctuation
    add = " " + suffix if not p.text.rstrip().endswith(".") else " " + (suffix[:-1] + "." if suffix.endswith(")") else suffix + ".")
    r = p.add_run(add)
    # copy formatting from last non-empty run
    last = None
    for run in p.runs[::-1]:
        if normalize_ws(run.text):
            last = run
            break
    if last:
        copy_format(last, r)

# ------------ Context mapping for smart placement ------------
# Minimal, extensible map: a keyword is preferred when the sentence mentions one of these context cues
KEY_CONTEXT = {
    "pytorch": {"torch", "resnet", "model", "training", "inference", "cv", "vision", "ml", "ai"},
    "tensorflow": {"keras", "tensor", "model", "training"},
    "computer vision": {"opencv", "vision", "image", "detec", "classif"},
    "rag": {"retrieval", "vector", "embedding", "search", "knowledge", "chunk"},
    "postgresql": {"sql", "postgres", "database", "supabase"},
    "sql": {"sql", "query", "database", "postgres"},
    "react": {"react", "frontend", "ui", "component"},
    "react native": {"react native", "expo", "mobile"},
    "typescript": {"typescript", "ts", "react", "frontend", "expo"},
    "javascript": {"javascript", "js", "frontend", "react"},
    "github actions": {"ci", "pipeline", "workflow", "cron", "automation"},
    "playwright": {"scrape", "browser", "automation", "e2e", "test"},
    "flask": {"api", "server", "backend"},
    "docker": {"container", "image", "compose"},
    "linux": {"linux", "bash", "shell"},
    "rest api": {"rest", "api", "endpoint"},
}

SOFT_KEYWORDS_DEFAULT = {"communication", "collaboration", "teamwork", "leadership", "ownership"}

def pick_keyword_for_sentence(sentence: str,
                              candidates: List[str],
                              used: Set[str],
                              soft_pool: Set[str]) -> str | None:
    """
    Pick ONE keyword that:
      - hasn't been used yet globally
      - matches the sentence context if possible
      - prefers hard (non-soft) keywords
      - only uses a soft keyword if no suitable hard keyword exists (and only once globally)
    """
    stoks = tokens(sentence)
    # 1) hard candidates not used yet
    hard = [k for k in candidates if k not in used and k.lower() not in soft_pool]
    soft = [k for k in candidates if k not in used and k.lower() in soft_pool]

    def score(k: str) -> int:
        cues = KEY_CONTEXT.get(k.lower(), set())
        return len(stoks & cues)

    # prefer context-matching hard keywords
    hard_sorted = sorted(hard, key=lambda k: (score(k), k), reverse=True)
    if hard_sorted and (score(hard_sorted[0]) > 0 or hard_sorted):
        return hard_sorted[0]

    # otherwise a single soft keyword if none placed yet anywhere
    if soft:
        return soft[0]
    return None

def rewrite_bullets_in_section(paragraphs,
                               start: int, end: int,
                               target_bullets: List[str],
                               candidate_keywords: List[str],
                               used_keywords: Set[str],
                               soft_pool: Set[str],
                               logger: ChangeLog,
                               section_label: str,
                               max_rewrites=3):
    """
    Append ONE suitable keyword per rewritten bullet; no duplicates across the whole document.
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
        p = paragraphs[para_idx]
        before = p.text

        kw = pick_keyword_for_sentence(before, candidate_keywords, used_keywords, soft_pool)
        if not kw:
            continue

        # make sure we only add one keyword to this bullet
        append_parenthetical_run(p, f"({kw})")
        used_keywords.add(kw.lower())
        logger.add(section_label, before, p.text, reason=f"Inserted targeted JD keyword: {kw}")
        rewrites += 1

def reorder_skills_or_annotate(paragraphs, start: int, end: int,
                               prioritized: List[str],
                               used_keywords: Set[str],
                               logger: ChangeLog):
    """
    If the skills line is single-run comma text, reorder existing items to surface prioritized terms
    (only if they already exist). Otherwise, append a small '(Priority: ...)' note listing up to 6
    prioritized terms that exist on that line (no duplicates vs. already used keywords).
    """
    def reorder_line_text(text: str, prio: List[str]) -> str:
        items = [normalize_ws(x) for x in re.split(r",\s*", text) if x.strip()]
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

        existing = tokens(t)
        prio_present = [k for k in prioritized if k.lower() in existing and k.lower() not in used_keywords]

        if len(p.runs) == 1:
            before = p.runs[0].text
            after = reorder_line_text(before, prio_present)
            if after != before:
                p.runs[0].text = after
                logger.add("Technical Skills", before, after,
                           reason="Reordered to surface JD-matching skills already present.")
        else:
            if prio_present:
                show = ", ".join(prio_present[:6])
                before = p.text
                append_parenthetical_run(p, f"(Priority: {show})")
                after = p.text
                logger.add("Technical Skills", before, after,
                           reason="Annotated priorities without altering styling.")
        # mark reordered ones as 'used' to avoid repeating in bullets
        for k in prio_present[:6]:
            used_keywords.add(k.lower())
        return  # only touch first candidate line

def tailor_docx_in_place(doc: Document,
                         portfolio_bullets: Dict[str, List[str]],
                         jd_keywords_hard: List[str],
                         jd_keywords_soft: List[str]):
    """
    Returns: list of change-log items.
    Guarantees: each keyword is used at most once across the document; bullets get <=1 keyword each.
    """
    logger = ChangeLog()
    used: Set[str] = set()  # global uniqueness

    ranges = find_section_ranges(doc, [
        "Education",
        "Side Projects", "Projects",
        "Work Experience",
        "Technical Skills",
        "Workshops",
        "References",
    ])
    pars = doc.paragraphs

    # 1) Technical Skills — reorder/annotate first, and mark used ones
    if "technical skills" in ranges:
        s, e = ranges["technical skills"]
        reorder_skills_or_annotate(pars, s, e, jd_keywords_hard + jd_keywords_soft, used, logger)

    # Build pools
    soft_pool = set(k.lower() for k in jd_keywords_soft)
    candidates = jd_keywords_hard + jd_keywords_soft

    # 2) Projects / Side Projects
    for sec in ("side projects", "projects"):
        if sec in ranges:
            s, e = ranges[sec]
            source = (portfolio_bullets.get("Side Projects", []) +
                      portfolio_bullets.get("Projects", []))
            rewrite_bullets_in_section(pars, s, e, source, candidates, used, soft_pool,
                                       logger, section_label="Side Projects" if sec == "side projects" else "Projects",
                                       max_rewrites=3)

    # 3) Work Experience
    if "work experience" in ranges:
        s, e = ranges["work experience"]
        rewrite_bullets_in_section(pars, s, e, portfolio_bullets.get("Work Experience", []),
                                   candidates, used, soft_pool, logger,
                                   section_label="Work Experience",
                                   max_rewrites=3)

    return logger.items
