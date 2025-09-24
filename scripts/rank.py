# scripts/rank.py
import os, sys, json, requests, argparse
from datetime import datetime, timedelta

# Make src importable
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

# Import the updated helpers
from src.core.scoring import (
    score_job,
    tokenize,
    contains_any,
    tokens_from_terms,   # NEW
)

DATA_JOBS = os.path.join(os.path.dirname(__file__), '..', 'data', 'jobs.jsonl')
OUT_DIR   = os.path.join(os.path.dirname(__file__), '..', 'docs', 'data')
OUT_JSON  = os.path.join(OUT_DIR, 'scores.json')

SUPABASE_URL = os.environ.get("SUPABASE_URL","").rstrip("/")
SRK          = os.environ.get("SUPABASE_SERVICE_ROLE_KEY","")

def _as_list(v):
    if v is None: return []
    if isinstance(v, (list, tuple, set)): return list(v)
    return [v]

def _lower_set(v):
    return {str(x).lower() for x in _as_list(v) if x is not None}

def get_profile(user_id: str) -> dict:
    if not (SUPABASE_URL and SRK and user_id):
        return {}
    url = f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{user_id}&select=*"
    r = requests.get(url, headers={"apikey": SRK, "Authorization": f"Bearer {SRK}"}, timeout=30)
    r.raise_for_status()
    arr = r.json()
    return (arr[0] if arr else {}) or {}

def compute_parts(job, profile):
    title = job.get('title','') or ''
    desc  = job.get('description','') or ''
    loc   = job.get('location','') or ''

    job_tokens = tokenize(title) | tokenize(desc)

    # --- token-set versions of skills / titles ---
    skill_tokens = tokens_from_terms(profile.get('skills'))
    target_title_tokens = tokens_from_terms(profile.get('target_titles'))

    skill_overlap = len(skill_tokens & job_tokens) / max(1, len(skill_tokens))
    title_similarity = len(target_title_tokens & tokenize(title)) / max(1, len(target_title_tokens))

    # soft location boost (prefer user-provided locations, fallback heuristic)
    loc_boost = 0.0
    loc_terms = tokens_from_terms(profile.get('locations'))
    if loc_terms and (loc_terms & tokenize(f"{loc} {desc}")):
        loc_boost = 0.1
    elif contains_any(loc, {"virginia","va","east coast","eastern time","et","est"}):
        loc_boost = 0.1

    return round(skill_overlap, 4), round(title_similarity, 4), round(loc_boost, 4)

def _within_recency(job, profile) -> bool:
    pol = (profile or {}).get("search_policy", {}) or {}
    days = int(pol.get("recency_days", 0) or 0)
    require = bool(pol.get("require_posted_date", False))
    if days <= 0:
        return True
    posted = (job or {}).get("posted_at")
    if not posted:
        return not require
    try:
        pdate = datetime.strptime(str(posted)[:10], "%Y-%m-%d").date()
    except Exception:
        return not require
    cutoff = (datetime.utcnow().date() - timedelta(days=days))
    return pdate >= cutoff

def main(user_id: str):
    if not os.path.exists(DATA_JOBS):
        print('No jobs.jsonl found; run scripts/crawl.py first.')
        return
    profile = get_profile(user_id)

    raw = []
    with open(DATA_JOBS) as f:
        for line in f:
            try:
                raw.append(json.loads(line))
            except Exception:
                continue

    filtered = [j for j in raw if _within_recency(j, profile)]
    out = []
    for j in filtered:
        so, ts, lb = compute_parts(j, profile)
        j['skill_overlap'] = so
        j['title_similarity'] = ts
        j['loc_boost'] = lb
        j['score'] = score_job(j, profile)
        out.append(j)

    out.sort(key=lambda x: x.get('score', 0), reverse=True)
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT_JSON, 'w') as f:
        json.dump(out, f, indent=2)
    print(f"Ranked {len(out)} jobs -> {OUT_JSON}")

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--user', required=True, help='Supabase user id')
    args = ap.parse_args()
    main(args.user)
