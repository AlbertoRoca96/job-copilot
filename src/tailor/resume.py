import re
import difflib
from typing import List, Tuple, Dict, Set, Optional
from docx import Document
from docx.text.paragraph import Paragraph
from docx.text.run import Run

from .policies import load_policies  # merges runtime + base

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
    name = (p.style.name or "").lower()
    if "list" in name or "bullet" in name or "number" in name:
        return True
    t = normalize_ws(p.text)
    return t.startswith(("•", "-", "–", "·"))

def best_match_idx(source_lines: List[str], target_text: str) -> int:
    target = normalize_ws(target_text)
    if not target:
        return -1
    scores = [
        difflib.SequenceMatcher(None, normalize_ws(s), target).ratio()
        for s in source_lines
    ]
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

def append_clause(p: Paragraph, clause: str):
    if not clause:
        return
    sep = "; " if p.text.strip().endswith((")", "]", "”", "\"", ".", "…")) else " — "
    add = f"{sep}{clause}."
    r = p.add_run(add)
    last = next((run for run in reversed(p.runs) if normalize_ws(run.text)), None)
    if last:
        copy_format(last, r)

# ---- policy scoring (prefer LLM/runtime, prefer specific cues, avoid generic spam) ----

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

        req = set(pol.get("requires_any") or [])
        if req and not (allowed_vocab & req):
            continue

        bullet_cues = set(pol.get("bullet_cues") or [])
        if bullet_cues and not (stoks & bullet_cues):
            continue

        score = _policy_score(pol, stoks, jd_vocab)
        if score > best_score:
            best_score = score
            best = pol

    if not best or best_score <= 0:
        return None

    used_clauses.add(best["clause"].lower())
    return best["clause"]

def rewrite_bullets_in_section(paragraphs: List[Paragraph],
                               start: int, end: int,
                               target_bullets: List[str],
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
        clause = choose_policy_for_sentence(before, jd_vocab, allowed_vocab, policies, used_clauses)
        if not clause:
            continue
        if len(before) > 350:
            continue
        append_clause(p, clause)
        logger.add(section_label, before, p.text, reason=f"Aligned to JD via clause: “{clause}”")
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
                         portfolio_bullets: Dict[str, List[str]],
                         jd_keywords: List[str],
                         allowed_vocab_list: List[str]):
    logger = ChangeLog()
    policies = load_policies()  # runtime policies (LLM) take precedence
    jd_vocab = set(k.lower() for k in jd_keywords)
    allowed_vocab = set(k.lower() for k in allowed_vocab_list)
    used_clauses: Set[str] = set()

    ranges = find_section_ranges(doc, [
        "Education", "Side Projects", "Projects", "Work Experience",
        "Technical Skills", "Workshops", "References",
    ])
    pars = doc.paragraphs

    # Skills
    if "technical skills" in ranges:
        s, e = ranges["technical skills"]
        reorder_or_annotate_skills(pars, s, e, list(jd_vocab), logger)

    # Projects / Side Projects
    for sec in ("side projects", "projects"):
        if sec in ranges:
            s, e = ranges[sec]
            src = (portfolio_bullets.get("Side Projects", []) +
                   portfolio_bullets.get("Projects", []))
            rewrite_bullets_in_section(
                pars, s, e, src, jd_vocab, allowed_vocab, policies,
                logger, "Projects", max_rewrites=3, used_clauses=used_clauses
            )

    # Work Experience
    if "work experience" in ranges:
        s, e = ranges["work experience"]
        rewrite_bullets_in_section(
            pars, s, e, portfolio_bullets.get("Work Experience", []),
            jd_vocab, allowed_vocab, policies, logger,
            "Work Experience", max_rewrites=3, used_clauses=used_clauses
        )

    return logger.items
