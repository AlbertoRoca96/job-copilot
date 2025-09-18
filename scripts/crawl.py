# scripts/crawl.py
import os, sys, json, yaml, traceback
from typing import List, Dict

# Make src/ importable
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from src.ingest.greenhouse import crawl_greenhouse
from src.ingest.lever import crawl_lever

ROOT = os.path.dirname(__file__)
DATA_DIR = os.path.join(ROOT, '..', 'data')
OUT_JSONL = os.path.join(DATA_DIR, 'jobs.jsonl')
TARGETS = os.path.join(ROOT, '..', 'targets.yaml')

def _load_targets() -> List[Dict]:
    if not os.path.exists(TARGETS):
        print(f'No targets.yaml at {TARGETS}')
        return []
    with open(TARGETS, 'r') as f:
        data = yaml.safe_load(f) or []
    # normalize to list
    if isinstance(data, dict):
        data = data.get('targets', [])
    return data or []

def _dedup_on_url(items: List[Dict]) -> List[Dict]:
    seen = set()
    out = []
    for j in items:
        u = (j.get('url') or '').strip()
        if not u or u in seen:
            continue
        seen.add(u)
        out.append(j)
    return out

def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    targets = _load_targets()
    if not targets:
        print('No targets provided.')
        return

    all_jobs: List[Dict] = []
    failures = 0

    for t in targets:
        ttype = (t.get('type') or '').strip().lower()
        slug  = (t.get('slug') or '').strip().lower()
        if not ttype or not slug:
            continue

        print(f'-- Crawling {ttype}:{slug} --')
        try:
            if ttype == 'greenhouse':
                jobs = crawl_greenhouse(slug)
            elif ttype == 'lever':
                jobs = crawl_lever(slug)
            else:
                print(f'  !! Unknown type "{ttype}" (skipping)')
                continue

            # Optional include/exclude keyword filtering on title/desc
            inc = [s.lower() for s in (t.get('include_keywords') or [])]
            exc = [s.lower() for s in (t.get('exclude_keywords') or [])]

            def _keep(j):
                title = (j.get('title') or '').lower()
                desc  = (j.get('description') or '').lower()
                blob  = f"{title} {desc}"
                if inc and not any(k in blob for k in inc):
                    return False
                if exc and any(k in blob for k in exc):
                    return False
                return True

            kept = [j for j in jobs if _keep(j)]
            print(f'  found={len(jobs)} kept={len(kept)}')
            all_jobs.extend(kept)

        except Exception as e:
            failures += 1
            print(f'  !! Failed {ttype}:{slug}: {e.__class__.__name__}: {e}')
            traceback.print_exc(limit=1)

    all_jobs = _dedup_on_url(all_jobs)

    with open(OUT_JSONL, 'w') as f:
        for j in all_jobs:
            f.write(json.dumps(j) + '\n')

    print(f'Crawled {len(all_jobs)} jobs across {len(targets)} targets '
          f'(failures: {failures}) -> {OUT_JSONL}')

if __name__ == '__main__':
    main()
