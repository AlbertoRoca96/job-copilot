# scripts/rank.py (FULL REWRITE)
import os, sys, json, requests, argparse
from datetime import datetime, timedelta

# Make src importable
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from src.core.scoring import (
    score_job, tokenize, contains_any, tokens_from_terms
)

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

def get_jobs(user_id: str) -> list[dict]:
    """
    Prefer DB 'jobs'; fall back to data/jobs.jsonl if any issue.
    """
    try:
        url = f"{SUPABASE_URL}/rest/v1/jobs?user_id=eq.{user_id}&select=*"
        r = requests.get(url, headers={"apikey": SRK, "Authorization": f"Bearer {SRK}"}, timeout=60)
        r.raise_for_status()
        arr = r.json() or []
        if arr: return arr
    except Exception:
        pass

    # fallback
    p = os.path.join(os.path.dirname(__file__), '..', 'data', 'jobs.jsonl')
    out = []
    if os.path.exists(p):
        with open(p) as f:
            for line in f:
                try: out.append(json.loads(line))
                except Exception: pass
    return out

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

def _title_gate(job, profile) -> bool:
    tts = tokens_from_terms((profile or {}).get('target_titles'))
    if not tts:
        return True
    return bool(tts & tokenize(job.get('title','') or ''))

def main(user_id: str):
    profile = get_profile(user_id)
    raw = get_jobs(user_id)

    # filter
    filtered = [j for j in raw if _within_recency(j, profile) and _title_gate(j, profile)]

    out = []
    for j in filtered:
        so = ts = lb = 0.0
        try:
            # decompose parts using the same logic your UI may want to show
            title = j.get('title','') or ''
            desc  = j.get('description','') or ''
            loc   = j.get('location','') or ''

            job_tokens = tokenize(title) | tokenize(desc)

            skill_tokens = tokens_from_terms(profile.get('skills'))
            target_title_tokens = tokens_from_terms(profile.get('target_titles'))

            so = round(len(skill_tokens & job_tokens) / max(1, len(skill_tokens)), 4)
            ts = round(len(target_title_tokens & tokenize(title)) / max(1, len(target_title_tokens)), 4)

            loc_boost = 0.0
            loc_terms = tokens_from_terms(profile.get('locations'))
            if loc_terms and (loc_terms & tokenize(f"{loc} {desc}")):
                loc_boost = 0.1
            elif contains_any(loc, {"virginia","va","east coast","eastern time","et","est"}):
                loc_boost = 0.1
            lb = round(loc_boost, 4)

            j['skill_overlap']   = so
            j['title_similarity'] = ts
            j['loc_boost']       = lb
            j['score']           = score_job(j, profile)
        except Exception:
            j['score'] = 0.0

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
