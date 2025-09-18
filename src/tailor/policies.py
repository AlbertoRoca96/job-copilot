# src/tailor/policies.py
import os, yaml

HERE = os.path.dirname(__file__)
BASE_YML = os.path.join(HERE, "policies.yaml")
RUNTIME_YML = os.path.join(HERE, "policies.runtime.yaml")

def _norm_set(xs):
    return set(str(x).strip().lower() for x in (xs or []))

def _read_yaml(path):
    try:
        if os.path.exists(path):
            with open(path, "r") as f:
                return yaml.safe_load(f) or []
    except Exception:
        pass
    return []

def _coerce(p):
    return {
        "id": str(p.get("id","")).strip() or "policy",
        "jd_cues": _norm_set(p.get("jd_cues", [])),
        "bullet_cues": _norm_set(p.get("bullet_cues", [])),
        "requires_any": _norm_set(p.get("requires_any", [])),
        "clause": str(p.get("clause","")).strip(),
        # tag whether this came from LLM so we can boost it later if needed
        "_source": p.get("_source", "base"),
    }

def load_policies():
    """
    Merge runtime (LLM) policies first, then base file.
    Deduplicate by lowercase clause; keep the first occurrence (LLM wins).
    Return a list of normalized dicts.
    """
    base = [_coerce(p | {"_source": "base"}) for p in _read_yaml(BASE_YML)]
    runtime = [_coerce(p | {"_source": "runtime"}) for p in _read_yaml(RUNTIME_YML)]

    merged = []
    seen_clauses = set()
    # runtime first (preferred), then base
    for src in (runtime, base):
        for p in src:
            clause = p["clause"].lower()
            if not clause or clause in seen_clauses:
                continue
            seen_clauses.add(clause)
            merged.append(p)
    # tiny log for debugging in CI
    print(f"policies: loaded {len(runtime)} runtime + {len(base)} base -> {len(merged)} active")
    return merged
