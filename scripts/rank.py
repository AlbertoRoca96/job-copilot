import os, sys, json, yaml
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

def main():
    if not os.path.exists(DATA):
        print('No jobs.jsonl found; run scripts/crawl.py first.')
        return
    with open(PROFILE, 'r') as f:
        profile = yaml.safe_load(f)

    out = []
    with open(DATA) as f:
        for line in f:
            j = json.loads(line)
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
