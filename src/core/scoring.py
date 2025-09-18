import re
from typing import Dict, Set

def tokenize(text: str) -> Set[str]:
    return set(re.findall(r"[A-Za-z][A-Za-z0-9+.-]{1,}", (text or '').lower()))

def score_job(job: Dict, profile: Dict) -> float:
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

    allowed = profile.get('locations', ['remote'])
    loc_match = any(k.lower() in loc.lower() for k in allowed) or ('remote' in tokens)

    return round(0.6*overlap + 0.3*title_sim + 0.1*(1 if loc_match else 0), 4)
