# src/core/scoring.py
import re
from typing import Dict, Set, List, Iterable, Any

# Remote/location heuristics
REMOTE_KEYWORDS = {
    "remote", "remotely", "work from home", "wfh", "distributed",
    "us-remote", "remote-us", "remote (us)", "remote, us",
    "remote in the us", "anywhere in the us", "anywhere (us)"
}

US_KEYWORDS = {"us", "u.s.", "united states", "usa", "u.s.a"}

# two-letter US states + common long names
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

# ---------------------- helpers ----------------------

def _as_list(v: Any) -> List[Any]:
    """Normalize potentially-null / scalar / iterable profile fields to a list."""
    if v is None:
        return []
    if isinstance(v, (list, tuple, set)):
        return list(v)
    # Treat scalars/strings as a single-element list
    return [v]

def _lower_set(v: Any) -> Set[str]:
    """Produce a lowercase set from possibly-null list/scalar."""
    return {str(x).lower() for x in _as_list(v) if x is not None}

def tokenize(text: str) -> Set[str]:
    return set(re.findall(r"[A-Za-z][A-Za-z0-9+.-]{1,}", (text or '').lower()))

def contains_any(text: str, needles: Iterable[str]) -> bool:
    t = (text or "").lower()
    return any((n or "").lower() in t for n in needles or [])

def is_remote(loc: str, desc: str) -> bool:
    return contains_any(loc, REMOTE_KEYWORDS) or contains_any(desc, REMOTE_KEYWORDS)

def mentions_us(text: str) -> bool:
    return contains_any(text, US_KEYWORDS)

def mentions_state(text: str, wanted: Iterable[str]) -> bool:
    t = (text or "").lower()
    for w in _as_list(wanted):
        lw = str(w).lower()
        if len(lw) == 2:
            # whole-token two-letter state code
            if re.search(rf"\b{re.escape(lw)}\b", t):  # word boundary match
                return True
        elif lw and lw in t:
            return True
    return False

# ---------------------- policy gates ----------------------

def location_ok(job: Dict, policy: Dict) -> bool:
    # If no policy, allow everything
    policy = policy or {}
    loc = (job.get('location') or '')
    desc = (job.get('description') or '')
    combined = f"{loc} {desc}"

    # remote-only filter
    if bool(policy.get('remote_only')):
        if not is_remote(loc, desc):
            return False

    # country filter (optional)
    allowed_countries = _lower_set(policy.get('allowed_countries'))
    if allowed_countries:
        if not any(c in combined.lower() for c in allowed_countries):
            # Heuristic: if clearly remote and mentions US terms, accept
            if not (is_remote(loc, desc) and mentions_us(combined)):
                return False

    # state filter (optional)
    allowed_states = _lower_set(policy.get('allowed_states'))
    if allowed_states and not mentions_state(combined, allowed_states):
        return False

    return True

# ---------------------- scoring ----------------------

def score_job(job: Dict, profile: Dict) -> float:
    # Location policy gate: reject if it doesn't match
    if not location_ok(job, profile.get('location_policy') or {}):
        return 0.0

    title = (job.get('title') or '')
    desc  = (job.get('description') or '')
    loc   = (job.get('location') or '')

    tokens = tokenize(title) | tokenize(desc)

    # Hard must-have skills (all required must be present)
    must = _lower_set(profile.get('must_haves'))
    if must and not must.issubset(tokens):
        return 0.0

    # Skill overlap
    skills = _lower_set(profile.get('skills'))
    overlap = len(skills & tokens) / max(1, len(skills))

    # Title similarity
    target_titles = _lower_set(profile.get('target_titles'))
    title_tokens = tokenize(title)
    title_sim = len(target_titles & title_tokens) / max(1, len(target_titles))

    # Soft location boost (even when remote-only)
    loc_boost = 0.0
    if contains_any(loc, {"virginia","va","east coast","eastern time","et","est"}):
        loc_boost = 0.1

    return round(0.6 * overlap + 0.3 * title_sim + loc_boost, 4)
