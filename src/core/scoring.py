# src/core/scoring.py
import re
from typing import Dict, Set, List, Iterable, Any

# -------- Location helpers (unchanged in spirit) --------

REMOTE_KEYWORDS = {
    "remote", "remotely", "work from home", "wfh", "distributed",
    "us-remote", "remote-us", "remote (us)", "remote, us",
    "remote in the us", "anywhere in the us", "anywhere (us)"
}
US_KEYWORDS = {"us", "u.s.", "united states", "usa", "u.s.a"}

US_STATES = {
    "al","ak","az","ar","ca","co","ct","de","fl","ga","hi","id","il","in","ia",
    "ks","ky","la","me","md","ma","mi","mn","ms","mo","mt","ne","nv","nh","nj",
    "nm","ny","nc","nd","oh","ok","or","pa","ri","sc","sd","tn","tx","ut","vt",
    "va","wa","wv","wi","wy",
    "alabama","alaska","arizona","arkansas","california","colorado","connecticut","delaware",
    "florida","georgia","hawaii","idaho","illinois","indiana","iowa","kansas","kentucky",
    "louisiana","maine","maryland","massachusetts","michigan","minnesota","mississippi","missouri",
    "montana","nebraska","nevada","new hampshire","new jersey","new mexico","new york","north carolina",
    "north dakota","ohio","oklahoma","oregon","pennsylvania","rhode island","south carolina",
    "south dakota","tennessee","texas","utah","vermont","virginia","washington","west virginia",
    "wisconsin","wyoming", "district of columbia", "dc"
}

# -------- Text normalization --------

_CANON_MAP = {
    "front-end": "frontend",
    "front end": "frontend",
    "back-end": "backend",
    "back end": "backend",
}

def _canon(tok: str) -> str:
    t = (tok or "").lower()
    return _CANON_MAP.get(t, t)

def tokenize(text: str) -> Set[str]:
    """
    Tokenize to a set of lowercase terms and expand common variants:
    - keep hyphenated variant, split pieces, and de-hyphenated form
    - add canonical synonyms (frontend/backend)
    - expand 'ml' <-> 'machine'+'learning'
    """
    text = (text or "").lower().replace("/", " ")
    raw = set(re.findall(r"[a-z][a-z0-9+.-]{1,}", text))

    expanded: Set[str] = set()
    for t in raw:
        expanded.add(t)
        if "-" in t:
            expanded.update(t.split("-"))
            expanded.add(t.replace("-", ""))

    final: Set[str] = set()
    for t in expanded:
        c = _canon(t)
        final.add(c)
        # symmetric expansions that help matching
        if c == "ml":
            final.update({"machine", "learning"})
        if c in {"machine", "learning"}:
            final.add("ml")
        if c in {"frontend", "front", "end"}:
            final.update({"frontend", "front", "end"})
        if c in {"backend", "back", "end"}:
            final.update({"backend", "back", "end"})

    return {x for x in final if x}

def _as_list(v: Any) -> List[Any]:
    if v is None:
        return []
    if isinstance(v, (list, tuple, set)):
        return list(v)
    return [v]

def _lower_list(v: Any) -> List[str]:
    return [str(x).lower() for x in _as_list(v) if x is not None]

def contains_any(text: str, needles: Iterable[str]) -> bool:
    t = (text or "").lower()
    return any((n or "").lower() in t for n in (needles or []))

def tokens_from_terms(terms: Iterable[str]) -> Set[str]:
    """Tokenize a list of phrases into a single token set with normalization."""
    out: Set[str] = set()
    for term in _as_list(terms):
        out |= tokenize(str(term))
    return out

# -------- Policy gates --------

def is_remote(loc: str, desc: str) -> bool:
    return contains_any(loc, REMOTE_KEYWORDS) or contains_any(desc, REMOTE_KEYWORDS)

def mentions_us(text: str) -> bool:
    return contains_any(text, US_KEYWORDS)

def mentions_state(text: str, wanted: Iterable[str]) -> bool:
    t = (text or "").lower()
    for w in _as_list(wanted):
        lw = str(w).lower()
        if len(lw) == 2:
            if re.search(rf"\b{re.escape(lw)}\b", t):
                return True
        elif lw and lw in t:
            return True
    return False

def location_ok(job: Dict, policy: Dict) -> bool:
    policy = policy or {}
    loc = (job.get("location") or "")
    desc = (job.get("description") or "")
    combined = f"{loc} {desc}"

    if bool(policy.get("remote_only")) and not is_remote(loc, desc):
        return False

    allowed_countries = set(_lower_list(policy.get("allowed_countries")))
    if allowed_countries:
        if not any(c in combined.lower() for c in allowed_countries):
            if not (is_remote(loc, desc) and mentions_us(combined)):
                return False

    allowed_states = set(_lower_list(policy.get("allowed_states")))
    if allowed_states and not mentions_state(combined, allowed_states):
        return False

    return True

# -------- Scoring --------

def score_job(job: Dict, profile: Dict) -> float:
    # Location gate
    if not location_ok(job, profile.get("location_policy") or {}):
        return 0.0

    title = (job.get("title") or "")
    desc  = (job.get("description") or "")
    loc   = (job.get("location") or "")

    job_tokens = tokenize(title) | tokenize(desc)

    # Must-have terms (as tokens)
    must_tokens = tokens_from_terms(profile.get("must_haves"))
    if must_tokens and not must_tokens.issubset(job_tokens):
        return 0.0

    # Skill overlap on normalized tokens
    skill_tokens = tokens_from_terms(profile.get("skills"))
    skill_overlap = len(skill_tokens & job_tokens) / max(1, len(skill_tokens))

    # Title similarity: compare token sets (handles phrases like "front end")
    target_title_tokens = tokens_from_terms(profile.get("target_titles"))
    title_similarity = len(target_title_tokens & tokenize(title)) / max(1, len(target_title_tokens))

    # Soft location boost: prefer matches to user-provided locations; fallback heuristic
    loc_boost = 0.0
    loc_terms = tokens_from_terms(profile.get("locations"))
    if loc_terms and (loc_terms & tokenize(f"{loc} {desc}")):
        loc_boost = 0.1
    elif contains_any(loc, {"virginia","va","east coast","eastern time","et","est"}):
        loc_boost = 0.1

    return round(0.6 * skill_overlap + 0.3 * title_similarity + loc_boost, 4)
