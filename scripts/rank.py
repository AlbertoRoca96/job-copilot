import os, sys, json, yaml, requests, argparse
from datetime import datetime, timedelta

# import scoring
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from src.core.scoring import score_job, tokenize, contains_any

DATA_JOBS = os.path.join(os.path.dirname(__file__), '..', 'data', 'jobs.jsonl')
OUT_DIR   = os.path.join(os.path.dirname(__file__), '..', 'run')
OUT_JSON  = os.path.join(OUT_DIR, 'scores.json')

SUPABASE_URL = os.environ.get("SUPABASE_URL","").rstrip("/")
SRK          = os.environ.get("SUPABASE_SERVICE_ROLE_KEY","")

def get_profile(user_id: str) -> dict:
    if not (SUPABASE_URL and SRK and user_id):
        return {}
    url = f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{user_id}&select=*"
    r = requests.get(url, headers={"apikey": SRK, "Authorization": f"Bearer {SRK}"}, timeout=30)
    r.raise_for_status()
    arr = r.json()
    return (arr[0] if arr else {}) or {}

def compute_parts(job, profile):
    title = job.get('title','')
    desc  = job.get('description','')
    loc   = job.get('location','')
    tokens = tokenize(title) | tokenize(desc)

    skills = set(map(str.lower, (profile.get('skills') or [])))
    skill_overlap = len(skills & tokens) / max(1, len(skills))

    target_titles = set(map(str.lower, (profile.get('target_titles') or [])))
    title_tokens = tokenize(title)
    title_similarity = len(target_titles & title_tokens) / max(1, len(target_titles))

    loc_boost = 0.0
    if contains_any(loc, {"virginia","va","east coast","eastern time","et","est"}):
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

    out.sort(key=lambda x: x['score'], reverse=True)
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT_JSON, 'w') as f:
        json.dump(out, f, indent=2)
    print(f"Ranked {len(out)} jobs -> {OUT_JSON}")

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--user', required=True, help='Supabase user id')
    args = ap.parse_args()
    main(args.user)
