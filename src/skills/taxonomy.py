# src/skills/taxonomy.py
"""
Generic title→skills augmentation backed by ESCO and/or O*NET dumps.

- Looks in data/skills/esco/* and data/skills/onet/* for CSV/TXT files.
- Parses occupation ↔ skill mappings with flexible header detection.
- Normalizes to lowercase tokens and also expands phrases into unigrams.
- Caches results in-memory; safe to call on every job.

If no ESCO/O*NET files are present, we fall back to BASE_MAP below.

Data references:
- ESCO bulk downloads (CSV/ODS/RDF) by the European Commission.
  See "Download ESCO" and "Data formats" pages.
- O*NET database files (e.g., Skills.txt, Occupation Data.txt / Occupation Titles.txt)
  and the Skills table documentation.

This module has NO network calls. Ship the data with your repo or upload later.

Author: job-copilot
"""

from __future__ import annotations

from typing import Iterable, List, Set, Dict, Tuple
from pathlib import Path
from functools import lru_cache
import csv
import re

# ---------- tiny, curated safety-net for when no datasets are present ----------

BASE_MAP: Dict[str, List[str]] = {
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

    # Business / mgmt / analysis
    "project manager": ["jira", "confluence", "stakeholder management", "scheduling", "risk"],
    "analyst": ["excel", "reporting", "dashboards", "sql"],

    # Hybrid data / IT support
    "data": ["excel", "sql", "tableau", "python"],
    "it support": ["helpdesk", "ticketing", "windows", "active directory"],
}

# ---------- tokenization / normalization helpers ----------

_WS_SPLIT = re.compile(r"[^A-Za-z0-9+.#/]+")

def _tok(s: str) -> List[str]:
    return [w for w in _WS_SPLIT.split((s or "").lower()) if w]

def _norm(s: str) -> str:
    return " ".join(_tok(s))

def _expand_phrase_set(terms: Iterable[str]) -> Set[str]:
    """
    Keep the original phrase AND add its unigrams so matching works for both.
    """
    out: Set[str] = set()
    for t in terms or []:
        t = (t or "").strip().lower()
        if not t:
            continue
        out.add(t)
        for w in _tok(t):
            out.add(w)
    return out

# ---------- file discovery ----------

ROOT = Path(__file__).resolve().parents[2]    # repo root (…/src/skills/taxonomy.py -> repo/)
DATA_DIR = ROOT / "data" / "skills"
ESCO_DIR = DATA_DIR / "esco"
ONET_DIR = DATA_DIR / "onet"

def _iter_files(folder: Path, exts: Tuple[str, ...]) -> List[Path]:
    if not folder.exists():
        return []
    out: List[Path] = []
    for p in folder.rglob("*"):
        if p.is_file() and p.suffix.lower() in exts:
            out.append(p)
    return out

# ---------- ESCO parsing ----------

# We try to find two things:
# 1) occupation titles (any CSV with a column like ["occupation", "occupation_label", "preferredLabel", "title"])
# 2) occupation↔skill relations (any CSV with two columns that look like occupation title and skill name)
# Many ESCO “CSV” exports include separate files; column names vary. We detect heuristically.

def _likely_col(name: str, *candidates: str) -> bool:
    n = name.strip().lower().replace(" ", "").replace("_", "")
    return any(n.startswith(c) or n == c for c in candidates)

def _is_skill_header(h: str) -> bool:
    h = h.lower()
    return any(k in h for k in ("skill", "competence", "ability"))

def _is_occ_header(h: str) -> bool:
    h = h.lower()
    return any(k in h for k in ("occupation", "role", "job", "title", "preferredlabel"))

def _read_csv_rows(path: Path) -> Iterable[Dict[str, str]]:
    with path.open("r", encoding="utf-8", errors="ignore", newline="") as f:
        sniffer = csv.Sniffer()
        sample = f.read(4096)
        f.seek(0)
        dialect = sniffer.sniff(sample, delimiters=",;\t|")
        reader = csv.DictReader(f, dialect=dialect)
        for row in reader:
            yield {k.strip(): (v or "").strip() for k, v in row.items()}

@lru_cache(maxsize=1)
def _load_esco_pairs() -> List[Tuple[str, str]]:
    pairs: List[Tuple[str, str]] = []
    for csv_path in _iter_files(ESCO_DIR, (".csv", ".tsv", ".txt", ".ods")):
        try:
            for row in _read_csv_rows(csv_path):
                # candidate headers
                occ_keys = [k for k in row.keys() if _is_occ_header(k)]
                skl_keys = [k for k in row.keys() if _is_skill_header(k)]
                if not occ_keys or not skl_keys:
                    continue
                occ = row.get(occ_keys[0], "")
                skl = row.get(skl_keys[0], "")
                occ = occ.strip()
                skl = skl.strip()
                if occ and skl:
                    pairs.append((occ, skl))
        except Exception:
            continue
    return pairs

@lru_cache(maxsize=1)
def _esco_title_to_skills() -> Dict[str, Set[str]]:
    m: Dict[str, Set[str]] = {}
    for occ, skl in _load_esco_pairs():
        t = _norm(occ)
        s = _norm(skl)
        if not t or not s:
            continue
        m.setdefault(t, set()).add(s)
    return m

# ---------- O*NET parsing ----------

# O*NET DB text files are tab-delimited. Skills.txt provides (O*NET-SOC Code, Element Name, ...).
# We also want a code->title map from Occupation Data.txt or Occupation Titles.txt.
# References: "Skills" table page & Data Dictionary.
# (No runtime network; we just read whatever is present.)
#
# Columns we look for:
#   - Skills.txt: code: ["O*NET-SOC Code"], skill: ["Element Name"] OR ["Skill"] OR ["ElementName"]
#   - Occupation Data.txt / Occupation Titles.txt: ["O*NET-SOC Code"] + ["Title"]

def _read_tsv_rows(path: Path) -> Iterable[Dict[str, str]]:
    with path.open("r", encoding="utf-8", errors="ignore", newline="") as f:
        reader = csv.DictReader(f, delimiter="\t")
        for row in reader:
            yield {k.strip(): (v or "").strip() for k, v in row.items()}

def _find_col(row: Dict[str, str], *cands: str) -> str | None:
    keys = {k.lower().strip(): k for k in row.keys()}
    for c in cands:
        c2 = c.lower().strip()
        if c2 in keys:
            return keys[c2]
    # try compacted header names (remove spaces)
    compact = {"".join(k.lower().split()): k for k in row.keys()}
    for c in cands:
        c2 = "".join(c.lower().split())
        if c2 in compact:
            return compact[c2]
    return None

@lru_cache(maxsize=1)
def _load_onet_code_to_title() -> Dict[str, str]:
    out: Dict[str, str] = {}
    for p in _iter_files(ONET_DIR, (".txt",)):
        if "occupation" not in p.name.lower():
            continue
        try:
            it = iter(_read_tsv_rows(p))
            first = next(it, None)
            if not first:
                continue
            code_col = _find_col(first, "O*NET-SOC Code", "Onet-SOC Code", "SOC Code", "O*NET-SOC")
            title_col = _find_col(first, "Title", "Occupation", "Occupation Title")
            if not code_col or not title_col:
                continue
            # include first row, then rest
            rows = [first] + list(it)
            for r in rows:
                code = r.get(code_col, "").strip()
                title = r.get(title_col, "").strip()
                if code and title:
                    out[code] = title
        except Exception:
            continue
    return out

@lru_cache(maxsize=1)
def _load_onet_pairs() -> List[Tuple[str, str]]:
    pairs: List[Tuple[str, str]] = []
    title_by_code = _load_onet_code_to_title()
    for p in _iter_files(ONET_DIR, (".txt",)):
        if "skills" not in p.name.lower():
            continue
        try:
            it = iter(_read_tsv_rows(p))
            first = next(it, None)
            if not first:
                continue
            code_col = _find_col(first, "O*NET-SOC Code", "Onet-SOC Code", "SOC Code", "O*NET-SOC")
            skill_col = _find_col(first, "Element Name", "Skill", "ElementName")
            if not code_col or not skill_col:
                continue
            rows = [first] + list(it)
            for r in rows:
                code = r.get(code_col, "").strip()
                skill = r.get(skill_col, "").strip()
                if not code or not skill:
                    continue
                title = title_by_code.get(code) or code
                pairs.append((title, skill))
        except Exception:
            continue
    return pairs

@lru_cache(maxsize=1)
def _onet_title_to_skills() -> Dict[str, Set[str]]:
    m: Dict[str, Set[str]] = {}
    for occ, skl in _load_onet_pairs():
        t = _norm(occ)
        s = _norm(skl)
        if not t or not s:
            continue
        m.setdefault(t, set()).add(s)
    return m

# ---------- public API ----------

def _from_base_map(titles: Iterable[str]) -> Set[str]:
    out: Set[str] = set()
    for t in titles or []:
        tl = _norm(t)
        for k, vals in BASE_MAP.items():
            if k in tl.split():
                out.update(vals)
    return out

@lru_cache(maxsize=128)
def _esco_lookup(title_norm: str) -> Set[str]:
    # exact, then contains
    m = _esco_title_to_skills()
    if title_norm in m:
        return set(m[title_norm])
    hits = set()
    for k, vals in m.items():
        if k in title_norm or title_norm in k:
            hits.update(vals)
    return hits

@lru_cache(maxsize=128)
def _onet_lookup(title_norm: str) -> Set[str]:
    m = _onet_title_to_skills()
    if title_norm in m:
        return set(m[title_norm])
    hits = set()
    for k, vals in m.items():
        if k in title_norm or title_norm in k:
            hits.update(vals)
    return hits

def augment_allowed_vocab(base: Set[str], titles: Iterable[str]) -> List[str]:
    """
    Merge:
      - existing base skills (from profile/portfolio)
      - ESCO inferred skills for provided target_titles
      - O*NET inferred skills for provided target_titles
      - BASE_MAP back-off

    Returns a sorted list with phrase+unigram expansion so downstream
    matchers can use both.
    """
    base = set((base or set()))
    titles = list(titles or [])

    # Normalize titles once
    titles_norm = [_norm(t) for t in titles if (t or "").strip()]

    esco_terms: Set[str] = set()
    onet_terms: Set[str] = set()
    for tn in titles_norm:
        esco_terms.update(_esco_lookup(tn))
        onet_terms.update(_onet_lookup(tn))

    # If neither dataset present/matched, fall back to tiny curated map
    fallback_terms = _from_base_map(titles_norm)

    merged: Set[str] = set()
    merged.update(base)
    merged.update(esco_terms)
    merged.update(onet_terms)
    merged.update(fallback_terms)

    # Expand phrases into unigrams for better JD matching
    expanded = _expand_phrase_set(merged)
    return sorted(expanded)
