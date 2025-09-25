# src/skills/taxonomy.py
import os, csv, json, re, difflib
from typing import Dict, List, Set, Tuple

HERE = os.path.dirname(__file__)
# You can override with env var; otherwise we auto-detect under ./data/taxonomy/*
DATA_ROOT = os.environ.get(
    "SKILLS_DATA_DIR",
    os.path.abspath(os.path.join(HERE, "..", "..", "data", "taxonomy"))
)

CACHE_PATH = os.path.join(DATA_ROOT, "cache", "skills_cache.v1.json")

def _ensure_dirs():
    os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)

def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())

# ---------------------------
# ESCO bulk download support
# ---------------------------
# Expected files (official bulk download contains these; English variants often end with _en):
# - occupations.csv or occupations_en.csv
# - skills.csv or skills_en.csv
# - occupationSkillRelations.csv (relationType: essential / optional)
#
# ESCO download & file structure docs:
# https://esco.ec.europa.eu/en/downloads  
# https://ec.europa.eu/esco/portal/document/en/980c1a0c-9f00-4e2a-8aa3-5b7bfc1a5b9b  (Structure) 

def _esco_file(dirpath: str, base: str) -> str | None:
    cand = [
        os.path.join(dirpath, base),
        os.path.join(dirpath, base.replace(".csv", "_en.csv")),
        os.path.join(dirpath, base.replace(".csv", ".CSV")),
        os.path.join(dirpath, base.replace(".csv", "_en.CSV")),
    ]
    for p in cand:
        if os.path.isfile(p):
            return p
    return None

def _load_esco(esco_dir: str) -> Tuple[Dict[str, Set[str]], Dict[str, Set[str]]]:
    """
    Returns:
      occ_title_to_skills: {occupation_title -> {skill,...}}
      skill_lexicon: {"skill term" -> set([term])} for quick membership
    """
    occ_rel_path = _esco_file(esco_dir, "occupationSkillRelations.csv")
    skills_path  = _esco_file(esco_dir, "skills.csv")
    occs_path    = _esco_file(esco_dir, "occupations.csv")

    if not (occ_rel_path and skills_path and occs_path):
        return {}, {}

    # read skills (id -> label)
    skill_label: Dict[str, str] = {}
    with open(skills_path, newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            sid = (row.get("id") or row.get("skillId") or "").strip()
            lab = (row.get("preferredLabel") or row.get("label") or "").strip()
            if sid and lab:
                skill_label[sid] = lab

    # read occupations (id -> title)
    occ_title: Dict[str, str] = {}
    with open(occs_path, newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            oid = (row.get("id") or row.get("occupationId") or "").strip()
            lab = (row.get("preferredLabel") or row.get("label") or "").strip()
            if oid and lab:
                occ_title[oid] = lab

    # relations (occupationId, skillId, relationType)
    occ_to_skills: Dict[str, Set[str]] = {}
    with open(occ_rel_path, newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            oid = (row.get("occupationId") or row.get("occupation") or "").strip()
            sid = (row.get("skillId") or row.get("skill") or "").strip()
            if not (oid and sid): 
                continue
            lab = skill_label.get(sid)
            if not lab:
                continue
            title = occ_title.get(oid)
            if not title:
                continue
            occ_to_skills.setdefault(title, set()).add(lab)

    # skill lexicon (simple)
    lex: Dict[str, Set[str]] = {}
    for s in skill_label.values():
        lex.setdefault(_norm(s), set()).add(s)

    return occ_to_skills, lex

# ---------------------------
# O*NET database support
# ---------------------------
# You can use EITHER the downloadable database (TXT files) or the Web Services API.
# Database files list & Skills.txt dictionary: https://www.onetcenter.org/dl_files/Database_30.0/Documentation/DatabaseSchema.html (Skills.txt) 
# Web Services overview (always latest DB): https://services.onetcenter.org/reference/database :contentReference[oaicite:3]{index=3}
#
# For offline parsing we look for:
#   - "Occupation Data.txt" (or Titles.txt) for O*NET-SOC -> Title
#   - "Skills.txt" listing ElementID/ElementName
#   - "Occupation-Skills.txt" (or "Occupation Skills.txt") mapping SOC -> ElementID + Scales
#
# NOTE: field names differ by release; we keep this parser permissive.

def _find_onet_file(dirpath: str, *candidates: str) -> str | None:
    names = set()
    for c in candidates:
        names.add(c)
        names.add(c.replace(" ", "-"))
        names.add(c.replace(" ", "_"))
        if not c.lower().endswith(".txt"):
            names.add(c + ".txt")
    for root, _, files in os.walk(dirpath):
        pool = {f.lower(): os.path.join(root, f) for f in files}
        for n in names:
            p = pool.get(n.lower())
            if p:
                return p
    return None

def _load_onet(onet_dir: str) -> Tuple[Dict[str, Set[str]], Dict[str, Set[str]]]:
    occ_file = _find_onet_file(onet_dir, "Occupation Data.txt", "Occupation Titles.txt", "Occupation.txt")
    skills_file = _find_onet_file(onet_dir, "Skills.txt")
    occ_skills_file = _find_onet_file(onet_dir, "Occupation-Skills.txt", "Occupation Skills.txt")

    if not (occ_file and skills_file and occ_skills_file):
        return {}, {}

    # SOC -> Title
    soc_title: Dict[str, str] = {}
    with open(occ_file, encoding="utf-8", errors="ignore") as f:
        r = csv.DictReader(f, delimiter="\t")
        # Try likely title column names
        for row in r:
            soc = (row.get("O*NET-SOC Code") or row.get("O*NET-SOC Code ".strip()) or row.get("Onet-SOC Code") or "").strip()
            title = (row.get("Title") or row.get("Title ".strip()) or row.get("Occupation") or "").strip()
            if soc and title:
                soc_title[soc] = title

    # ElementID -> Skill Name
    elem_name: Dict[str, str] = {}
    with open(skills_file, encoding="utf-8", errors="ignore") as f:
        r = csv.DictReader(f, delimiter="\t")
        for row in r:
            el = (row.get("Element ID") or row.get("ElementID") or "").strip()
            nm = (row.get("Element Name") or row.get("Element Name ".strip()) or row.get("Name") or "").strip()
            if el and nm:
                elem_name[el] = nm

    # SOC -> skills (threshold: keep skills with non-empty scale)
    occ_to_skills: Dict[str, Set[str]] = {}
    with open(occ_skills_file, encoding="utf-8", errors="ignore") as f:
        r = csv.DictReader(f, delimiter="\t")
        for row in r:
            soc = (row.get("O*NET-SOC Code") or row.get("Onet-SOC Code") or "").strip()
            el = (row.get("Element ID") or row.get("ElementID") or "").strip()
            # A minimal threshold: keep rows that have either Importance or Level present
            imp = (row.get("Scale ID") or row.get("Scale") or "").strip()
            if not (soc and el):
                continue
            name = elem_name.get(el)
            if not name:
                continue
            title = soc_title.get(soc)
            if not title:
                continue
            occ_to_skills.setdefault(title, set()).add(name)

    # lexicon for membership checks
    lex: Dict[str, Set[str]] = {}
    for s in elem_name.values():
        lex.setdefault(_norm(s), set()).add(s)

    return occ_to_skills, lex

# ---------------------------
# Public API
# ---------------------------

def load_taxonomy() -> Dict[str, Dict[str, Set[str]]]:
    """
    Loads + caches a merged taxonomy from ESCO and O*NET, if present.

    Returns a dict:
    {
      "occ_to_skills": { occupation_title -> {skill,...} },
      "skill_terms":   { normalized_skill_string -> {surface_forms...} }
    }
    """
    _ensure_dirs()
    # cache
    try:
        with open(CACHE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        pass

    merged_occ: Dict[str, Set[str]] = {}
    merged_lex: Dict[str, Set[str]] = {}

    esco_dir = os.path.join(DATA_ROOT, "esco")
    onet_dir = os.path.join(DATA_ROOT, "onet")

    if os.path.isdir(esco_dir):
        o2s, lex = _load_esco(esco_dir)
        for k, v in o2s.items():
            merged_occ.setdefault(k, set()).update(v)
        for k, v in lex.items():
            merged_lex.setdefault(k, set()).update(v)

    if os.path.isdir(onet_dir):
        o2s, lex = _load_onet(onet_dir)
        for k, v in o2s.items():
            merged_occ.setdefault(k, set()).update(v)
        for k, v in lex.items():
            merged_lex.setdefault(k, set()).update(v)

    obj = {
        "occ_to_skills": {k: sorted(v) for k, v in merged_occ.items()},
        "skill_terms":   {k: sorted(v) for k, v in merged_lex.items()},
    }
    with open(CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    return obj

def skills_from_titles(titles: List[str], taxonomy: Dict[str, Dict[str, List[str]]], top_k: int = 24) -> List[str]:
    """
    Back-off: if a user gives target titles, we retrieve skills by fuzzy matching
    their titles to taxonomy occupation titles, then union the skill sets.
    """
    titles = [t for t in titles if t]
    if not titles or not taxonomy:
        return []

    occ_to_sk = taxonomy.get("occ_to_skills", {})
    if not occ_to_sk:
        return []

    # Simple fuzzy over normalized titles
    occ_titles = list(occ_to_sk.keys())
    out: List[str] = []
    seen: Set[str] = set()

    for user_t in titles:
        cand = difflib.get_close_matches(user_t, occ_titles, n=8, cutoff=0.55)
        for ct in cand:
            for s in occ_to_sk.get(ct, []):
                ns = _norm(s)
                if ns not in seen:
                    out.append(s); seen.add(ns)

    return out[:top_k]

def augment_allowed_vocab(user_allowed: Set[str],
                          target_titles: List[str]) -> Set[str]:
    """
    Union of:
      - explicit user/profile skills (user_allowed)
      - inferred skills from titles via ESCO/O*NET taxonomy
    """
    try:
        tax = load_taxonomy()
    except Exception:
        tax = {}

    inferred = set(skills_from_titles(target_titles or [], tax, top_k=48))
    # Normalize but preserve original tokens
    base = {s.strip().lower() for s in (user_allowed or set()) if s}
    # add normalized inferred
    base.update(s.strip().lower() for s in inferred if s)
    return base
