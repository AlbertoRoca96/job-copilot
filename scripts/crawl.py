import os, sys, json, traceback, argparse, requests
from typing import List, Dict

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from src.ingest.greenhouse import crawl_greenhouse
from src.ingest.lever import crawl_lever
from src.core.scoring import tokens_from_terms

ROOT = os.path.dirname(__file__)
DATA_DIR = os.path.join(ROOT, '..', 'data')
OUT_JSONL = os.path.join(DATA_DIR, 'jobs.jsonl')

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SRK = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

def _dedup_on_url(items: List[Dict]) -> List[Dict]:
    seen = set(); out = []
    for j in items:
        u = (j.get('url') or '').strip().lower()
        if not u or u in seen: continue
        seen.add(u); out.append(j)
    return out

def _get_profile(user_id: str) -> dict:
    url = f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{user_id}&select=*"
    r = requests.get(url, headers={"apikey": SRK, "Authorization": f"Bearer {SRK}"}, timeout=30)
    r.raise_for_status()
    arr = r.json()
    return (arr[0] if arr else {}) or {}

def _get_boards() -> List[Dict]:
    url = f"{SUPABASE_URL}/rest/v1/boards?enabled=eq.true&select=source,slug"
    r = requests.get(url, headers={"apikey": SRK, "Authorization": f"Bearer {SRK}"}, timeout=30)
    r.raise_for_status()
    return r.json() or []

def _build_filters(profile: dict):
    inc = set(tokens_from_terms(profile.get('target_titles'))) | set(tokens_from_terms(profile.get('skills')))
    if not inc: inc = {"software", "engineer"}  # fallback
    exc = {"senior","staff","principal","lead","manager","director"}  # default exclusions
    return inc, exc

def _keep_factory(inc: set, exc: set):
    def _keep(j: Dict) -> bool:
        title = str(j.get('title') or '').lower()
        desc  = str(j.get('description') or '').lower()
        blob  = f"{title} {desc}"
        if inc and not any(k in blob for k in inc): return False
        if exc and any(k in blob for k in exc):     return False
        return True
    return _keep

def main(user_id: str):
    os.makedirs(DATA_DIR, exist_ok=True)

    profile = _get_profile(user_id)
    inc, exc = _build_filters(profile)
    keep = _keep_factory(inc, exc)

    boards = _get_boards()
    if not boards:
        print("No boards in Supabase table 'boards'."); return

    all_jobs: List[Dict] = []
    failures = 0
    for b in boards:
        src = (b.get('source') or '').strip().lower()
        slug = (b.get('slug') or '').strip().lower()
        if not src or not slug: continue

        print(f'-- Crawling {src}:{slug} --')
        try:
            if src == 'greenhouse':
                jobs = crawl_greenhouse(slug)
            elif src == 'lever':
                jobs = crawl_lever(slug)
            else:
                print(f'  !! Unknown source {src} (skipping)'); continue

            kept = [j for j in jobs if keep(j)]
            print(f'  found={len(jobs)} kept={len(kept)}')
            all_jobs.extend(kept)
        except Exception as e:
            failures += 1
            print(f'  !! Failed {src}:{slug}: {e.__class__.__name__}: {e}')
            traceback.print_exc(limit=1)

    all_jobs = _dedup_on_url(all_jobs)
    with open(OUT_JSONL, 'w') as f:
        for j in all_jobs:
            f.write(json.dumps(j) + '\n')

    print(f'Crawled {len(all_jobs)} jobs across {len(boards)} boards (failures: {failures}) -> {OUT_JSONL}')

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--user', required=True)
    args = ap.parse_args()
    main(args.user)
