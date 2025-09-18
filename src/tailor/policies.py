# src/tailor/policies.py
import os, yaml

_DEFAULTS = [
    {
        "id": "ml_modeling",
        "jd_cues": {"model","training","evaluation","deploy","inference"},
        "bullet_cues": {"model","vision","resnet","pytorch","classification","inference"},
        "requires_any": {"python","pytorch"},
        "clause": "shipped ML models with Python/PyTorch and iterative evaluation loops",
    },
    {
        "id": "search_ranking_rag",
        "jd_cues": {"search","retrieval","ranking","rag"},
        "bullet_cues": {"search","retrieve","index","dataset","vector","embedding"},
        "requires_any": {"python"},
        "clause": "experimented with retrieval/ranking and dataset curation for relevance",
    },
    {
        "id": "data_pipelines",
        "jd_cues": {"pipeline","dataset","data","annotation"},
        "bullet_cues": {"pipeline","cron","github","actions","scrape","supabase","sql","postgres"},
        "requires_any": {"github actions","sql","postgresql"},
        "clause": "built reliable data/annotation pipelines (GitHub Actions + SQL/Postgres)",
    },
    {
        "id": "mlops_infra",
        "jd_cues": {"mlops","observability","ci","monitor","deployment"},
        "bullet_cues": {"github","actions","ci","cron","monitor","deploy"},
        "requires_any": {"github actions"},
        "clause": "added CI/monitoring hooks for model/data jobs",
    },
    {
        "id": "product_collab",
        "jd_cues": {"product","features","impact","cross-functional","collaborate"},
        "bullet_cues": {"app","pwa","react","ui","prototype","space"},
        "requires_any": {"react","react native"},
        "clause": "partnered on user-facing features with quick prototypes (React/React Native)",
    },
]

def _norm_set(xs):
    return set(str(x).strip().lower() for x in xs)

def load_policies():
    """Load YAML if present; else use safe defaults. Normalize to lowercase sets."""
    here = os.path.dirname(__file__)
    yml = os.path.join(here, "policies.yaml")
    items = []
    if os.path.exists(yml):
        with open(yml, "r") as f:
            raw = yaml.safe_load(f) or []
        for p in raw:
            items.append({
                "id": str(p.get("id","")).strip() or "policy",
                "jd_cues": _norm_set(p.get("jd_cues", [])),
                "bullet_cues": _norm_set(p.get("bullet_cues", [])),
                "requires_any": _norm_set(p.get("requires_any", [])),
                "clause": str(p.get("clause","")).strip(),
            })
    else:
        for p in _DEFAULTS:
            items.append({
                "id": p["id"],
                "jd_cues": _norm_set(p["jd_cues"]),
                "bullet_cues": _norm_set(p["bullet_cues"]),
                "requires_any": _norm_set(p["requires_any"]),
                "clause": p["clause"],
            })
    # filter empty clauses
    return [p for p in items if p["clause"]]
