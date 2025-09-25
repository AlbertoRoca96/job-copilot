# src/skills/taxonomy.py
"""
Lightweight title→skills augmentation to make non-tech roles work out of the box.
Inspired by ESCO/O*NET occupation & skills data. Not exhaustive, but broad. 
(You can later replace this with a real ESCO/O*NET dump.)
Refs: ESCO (European Commission), O*NET Content Model. 
"""

from typing import Iterable, Set, List
import re

BASE_MAP = {
    # Editorial / content
    "editor": ["ap style", "copyediting", "proofreading", "fact-checking",
               "cms", "seo", "adobe", "wordpress", "google docs", "microsoft office"],
    "editorial assistant": ["copyediting", "proofreading", "scheduling", "cms", "seo",
                            "microsoft office", "adobe", "outlook"],
    "writer": ["research", "copywriting", "editing", "seo", "cms", "ap style"],
    "content": ["seo", "cms", "analytics", "social media", "copyediting"],

    # Admin / ops / support
    "administrative assistant": ["scheduling", "calendar management", "outlook",
                                 "excel", "word", "powerpoint", "record keeping", "customer service"],
    "office manager": ["scheduling", "procurement", "vendor management",
                       "excel", "budgeting", "facilities"],
    "customer service": ["crm", "ticketing", "phone etiquette", "conflict resolution"],

    # Marketing / comms
    "marketing": ["seo", "sem", "email marketing", "google analytics", "social media", "crm"],
    "social media": ["content calendar", "copywriting", "analytics", "community management"],

    # Finance / accounting
    "accountant": ["quickbooks", "excel", "reconciliation", "ap/ar", "tax", "gaap"],

    # Healthcare (generic)
    "medical assistant": ["ehr", "scheduling", "triage", "vitals", "hipaa"],
    "nurse": ["emr", "medication administration", "triage", "patient education"],

    # Hospitality / retail
    "retail": ["pos", "inventory", "merchandising", "customer service"],
    "barista": ["pos", "cash handling", "customer service", "scheduling"],

    # Generic business terms
    "project manager": ["jira", "confluence", "stakeholder management", "scheduling", "risk"],
    "analyst": ["excel", "reporting", "dashboards", "sql"],

    # Keep some common tech for hybrid roles
    "data": ["excel", "sql", "tableau", "python"],
    "it support": ["helpdesk", "ticketing", "windows", "active directory"],
}

def _tokenize(s: str) -> List[str]:
    return [w for w in re.split(r"[^A-Za-z0-9+.#/]+", (s or "").lower()) if w]

def augment_allowed_vocab(base: Set[str], titles: Iterable[str]) -> List[str]:
    out = set(base or set())
    for t in titles or []:
        for k, vals in BASE_MAP.items():
            if k in _tokenize(t):
                out.update(vals)
    # always keep individual words for phrase matches
    expanded = set()
    for x in out:
        expanded.add(x)
        for w in _tokenize(x):
            expanded.add(w)
    return sorted(expanded)
