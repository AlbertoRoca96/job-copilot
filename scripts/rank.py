import os, sys, json, yaml
from datetime import datetime, timedelta

# --- Make src/ importable when run from Actions or locally ---
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from src.core.scoring import score_job, tokenize, contains_any

DATA = os.path.join(os.path.dirname(__file__), '..', 'data', 'jobs.jsonl')
OUTL = os.path.join(os.path.dirname(__file__), '..', 'data', 'scores.jsonl')
OUTJ = os.path.join(os.path.dirname(__file__), '..', 'docs', 'data', 'scores.json')
PROFILE = os.path.join(os.path.dirname(__file__), '..', 'src', 'core', 'profile.yaml')

def compute_parts(job, profile):
    # replicate the parts used in scoring for visibility
    title = job.get('title','')
    desc  = job.get('description','')
    loc   = job.get('location','')
    tokens = tokenize(title) | tokenize(desc)

    skills = set(map(str.lower, profile.get('skills', [])))
    skill_overlap = len(skills & tokens) / max(1, len(skills))

    target_titles = set(map(str.lower, profile.get('target_titles', [])))
    title_tokens = tokenize(title)
    title_similarity = len(target_titles & title_tokens) / max(1, len(target_titles))

    loc_boost = 0.0
    if contains_any(loc, {"virginia","va","east coast","eastern time","et","est"}):
        loc_boost = 0.1

    return round(skill_overlap, 4), round(title_similarity, 4), round(loc_boost, 4)

def _within_recency(job, profile) -> bool:
    """Return True if job passes the recency gate defined in profile.search_policy."""
    pol = (profile or {}).get("search_policy", {}) or {}
    days = int(pol.get("recency_days", 0) or 0)
    require = bool(pol.get("require_posted_date", False))

    if days <= 0:
        return True  # no recency filter requested

    posted = (job or {}).get("posted_at")
    if not posted:
        return not require  # keep when date missing unless require_posted_date=true

    # Expect posted as YYYY-MM-DD
    try:
        pdate = datetime.strptime(str(posted)[:10], "%Y-%m-%d").date()
    except Exception:
        return not require

    cutoff = (datetime.utcnow().date() - timedelta(days=days))
    return pdate >= cutoff

def main():
    if not os.path.exists(DATA):
        print('No jobs.jsonl found; run scripts/crawl.py first.')
        return
    with open(PROFILE, 'r') as f:
        profile = yaml.safe_load(f) or {}

    # Load all jobs
    raw = []
    with open(DATA) as f:
        for line in f:
            try:
                raw.append(json.loads(line))
            except Exception:
                continue

    # Apply recency filter (if configured)
    filtered = [j for j in raw if _within_recency(j, profile)]
    dropped = len(raw) - len(filtered)
    if dropped > 0:
        print(f"Recency filter dropped {dropped} / {len(raw)} jobs per profile.search_policy")

    out = []
    for j in filtered:
        # compute parts just for transparency
        so, ts, lb = compute_parts(j, profile)
        j['skill_overlap'] = so
        j['title_similarity'] = ts
        j['loc_boost'] = lb
        # compute final score using the normal function
        j['score'] = score_job(j, profile)
        out.append(j)

    out.sort(key=lambda x: x['score'], reverse=True)

    with open(OUTL, 'w') as f:
        for j in out:
            f.write(json.dumps(j) + '\n')

    os.makedirs(os.path.join(os.path.dirname(__file__), '..', 'docs', 'data'), exist_ok=True)
    with open(OUTJ, 'w') as f:
        json.dump(out, f, indent=2)

    print(f"Ranked {len(out)} jobs -> {OUTJ}")

if __name__ == '__main__':
    main()
