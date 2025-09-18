import os, sys, json, argparse
# --- Make src/ importable when run from Actions or locally ---
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from src.tailor.render import render_cover

DATA = os.path.join(os.path.dirname(__file__), '..', 'data', 'scores.jsonl')
OUTDIR_MD = os.path.join(os.path.dirname(__file__), '..', 'docs', 'outbox')
PROFILE = os.path.join(os.path.dirname(__file__), '..', 'src', 'core', 'profile.yaml')
TMPL_DIR = os.path.join(os.path.dirname(__file__), '..', 'src', 'tailor', 'templates')

def main(top: int):
    if not os.path.exists(DATA):
        print('No scores.jsonl found; run scripts/rank.py first.')
        return
    os.makedirs(OUTDIR_MD, exist_ok=True)
    jobs = []
    with open(DATA) as f:
        for line in f:
            jobs.append(json.loads(line))
    jobs.sort(key=lambda x: x.get('score', 0), reverse=True)
    for j in jobs[:top]:
        safe_company = ''.join(c for c in j['company'] if c.isalnum() or c in ('-', '_')).strip()
        safe_title = ''.join(c for c in j['title'] if c.isalnum() or c in ('-', '_')).strip()
        fname = f"{safe_company}_{safe_title}.md"[:150]
        body = render_cover(j, PROFILE, TMPL_DIR)
        with open(os.path.join(OUTDIR_MD, fname), 'w') as f:
            f.write(body)
    print(f"Drafted {min(top, len(jobs))} cover letters -> {OUTDIR_MD}")

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--top', type=int, default=5)
    args = ap.parse_args()
    main(args.top)
