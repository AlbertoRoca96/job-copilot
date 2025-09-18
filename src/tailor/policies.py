# src/tailor/policies.py
import os, yaml

def _norm_set(xs):
    return set(str(x).strip().lower() for x in xs)

def _load_yaml(path):
    if not os.path.exists(path): return []
    with open(path, "r") as f:
        raw = yaml.safe_load(f) or []
    items = []
    for p in raw:
        items.append({
            "id": str(p.get("id","")).strip() or "policy",
            "jd_cues": _norm_set(p.get("jd_cues", [])),
            "bullet_cues": _norm_set(p.get("bullet_cues", [])),
            "requires_any": _norm_set(p.get("requires_any", [])),
            "clause": str(p.get("clause","")).strip(),
        })
    return items

_DEFAULTS = [
    {"id":"ml_modeling","jd_cues":{"model","training","evaluation","deploy","inference"},
     "bullet_cues":{"model","vision","resnet","pytorch","classification","inference"},
     "requires_any":{"python","pytorch"},
     "clause":"shipped ML models with Python/PyTorch and iterative evaluation loops"},
    {"id":"search_ranking_rag","jd_cues":{"search","retrieval","ranking","rag"},
     "bullet_cues":{"search","retrieve","index","dataset","vector","embedding"},
     "requires_any":{"python"},
     "clause":"experimented with retrieval/ranking and dataset curation for relevance"},
    {"id":"data_pipelines","jd_cues":{"pipeline","dataset","data","annotation"},
     "bullet_cues":{"pipeline","cron","github","actions","scrape","supabase","sql","postgres"},
     "requires_any":{"github actions","sql","postgresql"},
     "clause":"built reliable data/annotation pipelines (GitHub Actions + SQL/Postgres)"},
    {"id":"mlops_infra","jd_cues":{"mlops","observability","ci","monitor","deployment"},
     "bullet_cues":{"github","actions","ci","cron","monitor","deploy"},
     "requires_any":{"github actions"},
     "clause":"added CI/monitoring hooks for model/data jobs"},
    {"id":"product_collab","jd_cues":{"product","features","impact","cross-functional","collaborate"},
     "bullet_cues":{"app","pwa","react","ui","prototype","space"},
     "requires_any":{"react","react native"},
     "clause":"partnered on user-facing features with quick prototypes (React/React Native)"},
]

def load_policies():
    here = os.path.dirname(__file__)
    base = _load_yaml(os.path.join(here, "policies.yaml"))
    runtime = _load_yaml(os.path.join(here, "policies.runtime.yaml"))
    if not base:
        # normalize defaults
        base = []
        for p in _DEFAULTS:
            base.append({
                "id": p["id"],
                "jd_cues": _norm_set(p["jd_cues"]),
                "bullet_cues": _norm_set(p["bullet_cues"]),
                "requires_any": _norm_set(p["requires_any"]),
                "clause": p["clause"],
            })
    # merge (runtime last so it can add more)
    merged = [p for p in base if p.get("clause")]
    for p in runtime:
        if p.get("clause"):
            merged.append(p)
    return merged
