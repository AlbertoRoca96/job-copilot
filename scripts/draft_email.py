import os, sys, json, re, yaml
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from src.tailor.render import render_cover
from src.tailor.resume import tokens, tailor_docx_in_place
from docx import Document

DATA_JSONL = os.path.join(os.path.dirname(__file__), '..', 'data', 'scores.jsonl')
DATA_JSON  = os.path.join(os.path.dirname(__file__), '..', 'docs', 'data', 'scores.json')
OUTBOX_MD  = os.path.join(os.path.dirname(__file__), '..', 'docs', 'outbox')
RESUMES_MD = os.path.join(os.path.dirname(__file__), '..', 'docs', 'resumes')
CHANGES_DIR= os.path.join(os.path.dirname(__file__), '..', 'docs', 'changes')
PROFILE_YAML   = os.path.join(os.path.dirname(__file__), '..', 'src', 'core', 'profile.yaml')
PORTFOLIO_YAML = os.path.join(os.path.dirname(__file__), '..', 'src', 'core', 'portfolio.yaml')
TMPL_DIR       = os.path.join(os.path.dirname(__file__), '..', 'src', 'tailor', 'templates')
BASE_RESUME    = os.path.join(os.path.dirname(__file__), '..', 'assets', 'Resume-2025.docx')

# synonym normalizer (truthful)
SYNONYMS = {
    "js": "javascript", "reactjs": "react", "ts": "typescript",
    "ml": "machine learning", "cv": "computer vision", "postgres": "postgresql",
    "gh actions": "github actions", "gh-actions": "github actions", "ci/cd": "ci",
    "llm": "machine learning", "rest": "rest api", "etl": "data pipeline",
}
def normalize_keyword(w: str):
    return SYNONYMS.get((w or "").strip().lower(), (w or "").strip().lower())

SOFT_CANON = {"communication","collaboration","teamwork","leadership","ownership","mentorship"}

def allowed_vocab(profile: dict, portfolio: dict):
    skills = {s.lower() for s in profile.get("skills", [])}
    titles = {t.lower() for t in profile.get("target_titles", [])}
    tags = set()
    for section in ("projects", "work_experience", "workshops"):
        for item in portfolio.get(section, []) or []:
            for b in item.get("bullets", []) or []:
                for t in b.get("tags", []) or []:
                    tags.add(str(t).lower())
    expanded = {normalize_keyword(w) for w in (skills | tags | titles)}
    return expanded | skills | tags | titles

def harvest_job_keywords(job: dict, allowed: set):
    # collect JD tokens
    jtoks_raw = tokens(job.get("title","")) | tokens(job.get("description",""))
    jtoks = [normalize_keyword(w) for w in jtoks_raw]
    # frequency, limited to what you claim
    freq = {}
    for w in jtoks:
        if w in allowed:
            freq[w] = freq.get(w, 0) + 1
    # split hard vs soft
    hard, soft = [], []
    for w, _ in sorted(freq.items(), key=lambda kv: (-kv[1], kv[0])):
        (soft if w in SOFT_CANON else hard).append(w)
    # cap lengths a bit
    return hard[:16], soft[:6]

def portfolio_targets(portfolio: dict):
    targets = {"Side Projects": [], "Projects": [], "Work Experience": []}
    for p in portfolio.get("projects", []) or []:
        for b in p.get("bullets", []) or []:
            targets["Side Projects"].append(b.get("text",""))
            targets["Projects"].append(b.get("text",""))
    for w in portfolio.get("work_experience", []) or []:
        for b in w.get("bullets", []) or []:
            targets["Work Experience"].append(b.get("text",""))
    for k, arr in list(targets.items()):
        seen = set(); uniq=[]
        for t in arr:
            nt = (t or "").strip()
            if nt and nt not in seen:
                uniq.append(nt); seen.add(nt)
        targets[k] = uniq
    return targets

def safe_name(s: str) -> str:
    return ''.join(c for c in (s or '') if c.isalnum() or c in ('-', '_')).strip()

def main(top: int):
    with open(PROFILE_YAML, 'r') as f: profile = yaml.safe_load(f)
    with open(PORTFOLIO_YAML, 'r') as f: portfolio = yaml.safe_load(f)
    vocab = allowed_vocab(profile, portfolio)

    jobs = []
    if os.path.exists(DATA_JSON):
        with open(DATA_JSON) as f: jobs = json.load(f)
    elif os.path.exists(DATA_JSONL):
        with open(DATA_JSONL) as f:
            for line in f: jobs.append(json.loads(line))
    else:
        print('No scores found; run scripts/rank.py first.'); return

    jobs.sort(key=lambda x: x.get('score', 0), reverse=True)

    os.makedirs(OUTBOX_MD, exist_ok=True)
    os.makedirs(RESUMES_MD, exist_ok=True)
    os.makedirs(CHANGES_DIR, exist_ok=True)

    drafted_covers = drafted_resumes = 0

    for j in jobs[:top]:
        safe_company = safe_name(j.get('company',''))
        safe_title   = safe_name(j.get('title',''))

        # JD keywords (split)
        hard_kws, soft_kws = harvest_job_keywords(j, vocab)

        # COVER (append ATS alignment)
        cover_fname = f"{safe_company}_{safe_title}.md"[:150]
        cover = render_cover(j, PROFILE_YAML, TMPL_DIR)
        if hard_kws or soft_kws:
            cover += "\n\n---\n**Keyword Alignment (ATS-safe):** "
            cover += ", ".join(hard_kws + soft_kws) + "\n"
        with open(os.path.join(OUTBOX_MD, cover_fname), 'w') as f: f.write(cover)
        j['cover_file'] = cover_fname
        j['cover_path'] = f"outbox/{cover_fname}"
        drafted_covers += 1

        # RESUME — open base, tailor in place with uniqueness + context
        out_docx = os.path.join(RESUMES_MD, f"{safe_company}_{safe_title}.docx"[:150])
        doc = Document(BASE_RESUME)
        targets = portfolio_targets(portfolio)
        changes = tailor_docx_in_place(doc, targets, jd_keywords_hard=hard_kws, jd_keywords_soft=soft_kws)
        doc.save(out_docx)
        j['resume_docx'] = f"resumes/{os.path.basename(out_docx)}"

        # write explain payload
        explain = {
            "company": j.get("company",""),
            "title": j.get("title",""),
            "ats_keywords": hard_kws + soft_kws,
            "changes": changes
        }
        changes_fname = f"{safe_company}_{safe_title}.json"[:150]
        with open(os.path.join(CHANGES_DIR, changes_fname), 'w') as f:
            json.dump(explain, f, indent=2)
        j['changes_path'] = f"changes/{changes_fname}"

        drafted_resumes += 1

    with open(DATA_JSON, 'w') as f: json.dump(jobs, f, indent=2)

    print(f"Drafted {drafted_covers} cover letters -> {OUTBOX_MD}")
    print(f"Drafted {drafted_resumes} tailored resumes -> {RESUMES_MD}")

if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--top', type=int, default=5)
    args = ap.parse_args()
    main(args.top)
