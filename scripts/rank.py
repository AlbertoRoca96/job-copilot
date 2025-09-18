import os, json, yaml
from src.core.scoring import score_job

DATA = os.path.join(os.path.dirname(__file__), '..', 'data', 'jobs.jsonl')
OUTL = os.path.join(os.path.dirname(__file__), '..', 'data', 'scores.jsonl')
OUTJ = os.path.join(os.path.dirname(__file__), '..', 'docs', 'data', 'scores.json')  # for dashboard
PROFILE = os.path.join(os.path.dirname(__file__), '..', 'src', 'core', 'profile.yaml')

def main():
    if not os.path.exists(DATA):
        print('No jobs.jsonl found; run scripts/crawl.py first.')
        return
    with open(PROFILE, 'r') as f:
        profile = yaml.safe_load(f)

    jobs = []
    with open(DATA) as f:
        for line in f:
            j = json.loads(line)
            j['score'] = score_job(j, profile)
            jobs.append(j)

    jobs.sort(key=lambda x: x['score'], reverse=True)

    # jsonl (for history)
    with open(OUTL, 'w') as f:
        for j in jobs:
            f.write(json.dumps(j) + '\n')

    # json array (for dashboard)
    os.makedirs(os.path.join(os.path.dirname(__file__), '..', 'docs', 'data'), exist_ok=True)
    with open(OUTJ, 'w') as f:
        json.dump(jobs, f, indent=2)

    print(f"Ranked {len(jobs)} jobs -> {OUTJ}")

if __name__ == '__main__':
    main()
