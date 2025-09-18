import os, sys, yaml, json
# --- Make src/ importable when run from Actions or locally ---
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from src.ingest.greenhouse import crawl_greenhouse
from src.ingest.lever import crawl_lever

DATA_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'jobs.jsonl')

def write_jsonl(path, items):
    with open(path, 'w') as f:
        for it in items:
            f.write(json.dumps(it) + '\n')

def main():
    here = os.path.dirname(__file__)
    targets_file = os.path.join(here, '..', 'targets.yaml')
    with open(targets_file, 'r') as f:
        targets = yaml.safe_load(f)

    all_jobs = []
    for t in targets:
        tp, slug = t['type'], t['slug']
        inc = [s.lower() for s in t.get('include_keywords', [])]
        exc = [s.lower() for s in t.get('exclude_keywords', [])]
        if tp == 'greenhouse':
            items = crawl_greenhouse(slug)
        elif tp == 'lever':
            items = crawl_lever(slug)
        else:
            continue

        for j in items:
            title_l = j['title'].lower()
            if inc and not any(k in title_l for k in inc):
                continue
            if exc and any(k in title_l for k in exc):
                continue
            all_jobs.append(j)

    os.makedirs(os.path.join(here, '..', 'data'), exist_ok=True)
    write_jsonl(DATA_PATH, all_jobs)
    print(f"Wrote {len(all_jobs)} jobs -> {DATA_PATH}")

if __name__ == '__main__':
    main()
