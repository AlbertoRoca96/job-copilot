import re
from typing import Dict, Set, List

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

def tokenize(text: str) -> Set[str]:
    return set(re.findall(r"[A-Za-z][A-Za-z0-9+.-]{1,}", (text or '').lower()))

def contains_any(text: str, needles: Set[str]) -> bool:
    t = (text or "").lower()
    return any(n in t for n in needles)

def is_remote(loc: str, desc: str) -> bool:
    return contains_any(loc, REMOTE_KEYWORDS) or contains_any(desc, REMOTE_KEYWORDS)

def mentions_us(text: str) -> bool:
    return contains_any(text, US_KEYWORDS)

def mentions_state(text: str, wanted: Set[str]) -> bool:
    t = (text or "").lower()
    # exact state codes (word boundaries) or substrings of full names
    for w in wanted:
        lw = w.lower()
        if len(lw) == 2:
            if re.search(rf"\b{re.escape(lw)}\b", t):
                return True
        else:
            if lw in t:
                return True
    return False

def location_ok(job: Dict, policy: Dict) -> bool:
    # If no policy, allow everything
    if not policy:
        return True

    loc = job.get('location', '') or ''
    desc = job.get('description', '') or ''
    combined = f"{loc} {desc}"

    # remote-only filter
    if policy.get('remote_only'):
        if not is_remote(loc, desc):
            return False

    # country filter (applies only if provided and not remote-only OR you want "Remote (US)")
    allowed_countries = {c.lower() for c in policy.get('allowed_countries', [])}
    if allowed_countries:
        # Consider it OK if the text mentions any allowed country OR (remote + US implied)
        if not any(c in combined.lower() for c in allowed_countries):
            # Heuristic: if it's clearly remote and mentions US terms, accept
            if not (is_remote(loc, desc) and mentions_us(combined)):
                return False

    # state filter (optional, for the future)
    allowed_states = {s.lower() for s in policy.get('allowed_states', [])}
    if allowed_states:
        if not mentions_state(combined, allowed_states):
            return False

    return True

def score_job(job: Dict, profile: Dict) -> float:
    # Location policy gate: reject if it doesn't match
    policy = profile.get('location_policy', {})
    if not location_ok(job, policy):
        return 0.0

    title = job.get('title','')
    desc  = job.get('description','')
    loc   = job.get('location','')

    tokens = tokenize(title) | tokenize(desc)

    must = set(map(str.lower, profile.get('must_haves', [])))
    if must and not must.issubset(tokens):
        return 0.0

    skills = set(map(str.lower, profile.get('skills', [])))
    overlap = len(skills & tokens) / max(1, len(skills))

    target_titles = set(map(str.lower, profile.get('target_titles', [])))
    title_tokens = tokenize(title)
    title_sim = len(target_titles & title_tokens) / max(1, len(target_titles))

    # Soft location boost (even when remote-only)
    loc_boost = 0.0
    if contains_any(loc, {"virginia","va","east coast","eastern time","et","est"}):
        loc_boost = 0.1

    return round(0.6*overlap + 0.3*title_sim + loc_boost, 4)
