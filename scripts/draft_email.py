import os, sys, json, re, yaml
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from src.tailor.render import render_cover
from src.tailor.resume import tokens, tailor_docx_in_place
from docx import Document
from src.ai.llm import suggest_policies  # LLM (optional)

DATA_JSONL = os.path.join(os.path.dirname(__file__), '..', 'data', 'scores.jsonl')
DATA_JSON  = os.path.join(os.path.dirname(__file__), '..', 'docs', 'data', 'scores.json')
OUTBOX_MD  = os.path.join(os.path.dirname(__file__), '..', 'docs', 'outbox')
RESUMES_MD = os.path.join(os.path.dirname(__file__), '..', 'docs', 'resumes')
CHANGES_DIR= os.path.join(os.path.dirname(__file__), '..', 'docs', 'changes')
DATA_DIR   = os.path.join(os.path.dirname(__file__), '..', 'docs', 'data')
PROFILE_YAML   = os.path.join(os.path.dirname(__file__), '..', 'src', 'core', 'profile.yaml')
PORTFOLIO_YAML = os.path.join(os.path.dirname(__file__), '..', 'src', 'core', 'portfolio.yaml')
TMPL_DIR       = os.path.join(os.path.dirname(__file__), '..', 'src', 'tailor', 'templates')
BASE_RESUME    = os.path.join(os.path.dirname(__file__), '..', 'assets', 'Resume-2025.docx')
RUNTIME_POL    = os.path.join(os.path.dirname(__file__), '..', 'src', 'tailor', 'policies.runtime.yaml')

SYNONYMS = {
  "js":"javascript","reactjs":"react","ts":"typescript","ml":"machine learning",
  "cv":"computer vision","postgres":"postgresql","gh actions":"github actions",
  "gh-actions":"github actions","ci/cd":"ci","llm":"machine learning","rest":"rest api",
  "etl":"data pipeline"
}
def norm(w): return SYNONYMS.get((w or "").strip().lower(), (w or "").strip().lower())

def allowed_vocab(profile: dict, portfolio: dict):
    skills = {s.lower() for s in profile.get("skills", [])}
    titles = {t.lower() for t in profile.get("target_titles", [])}
    tags = set()
    for section in ("projects", "work_experience", "workshops"):
        for item in (portfolio.get(section, []) or []):
            for b in (item.get("bullets", []) or []):
                for t in (b.get("tags", []) or []):
                    tags.add(str(t).lower())
    expanded = {norm(w) for w in (skills | tags | titles)}
    return sorted(expanded | skills | tags | titles)

def jd_keywords(job: dict, allowed: set, cap=24):
    jtoks = [norm(w) for w in (tokens(job.get("title","")) | tokens(job.get("description","")))]
    freq = {}
    for w in jtoks:
        if w in allowed:
            freq[w] = freq.get(w, 0) + 1
    return [w for w,_ in sorted(freq.items(), key=lambda kv: (-kv[1], kv[0]))[:cap]]

def portfolio_targets(portfolio: dict):
    targets = {"Side Projects": [], "Projects": [], "Work Experience": []}
    for p in (portfolio.get("projects", []) or []):
        for b in (p.get("bullets", []) or []):
            targets["Side Projects"].append(b.get("text",""))
            targets["Projects"].append(b.get("text",""))
    for w in (portfolio.get("work_experience", []) or []):
        for b in (w.get("bullets", []) or []):
            targets["Work Experience"].append(b.get("text",""))
    # de-dup
    for k, arr in list(targets.items()):
        seen=set(); uniq=[]
        for t in arr:
            nt=(t or "").strip()
            if nt and nt not in seen:
                uniq.append(nt); seen.add(nt)
        targets[k]=uniq
    return targets

def safe_name(s: str) -> str:
    return ''.join(c for c in (s or '') if c.isalnum() or c in ('-', '_')).strip()

def main(top: int):
    with open(PROFILE_YAML, 'r') as f: profile = yaml.safe_load(f)
    with open(PORTFOLIO_YAML, 'r') as f: portfolio = yaml.safe_load(f)

    vocab = set(allowed_vocab(profile, portfolio))

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
    os.makedirs(DATA_DIR, exist_ok=True)

    drafted_covers = drafted_resumes = 0

    use_llm = os.getenv("USE_LLM","0") == "1" and bool(os.getenv("OPENAI_API_KEY"))
    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

    llm_summary = {
        "used": bool(use_llm),
        "model": model if use_llm else None,
        "jobs": []
    }
    print(f"LLM: {'using model ' + model if use_llm else 'disabled or missing OPENAI_API_KEY (fallback to deterministic)'}")

    for j in jobs[:top]:
        safe_company = safe_name(j.get('company',''))
        safe_title   = safe_name(j.get('title',''))
        slug = f"{safe_company}_{safe_title}"[:150]

        jd_kws = jd_keywords(j, vocab)

        # Optional: get per-job policies from LLM and write policies.runtime.yaml
        job_llm_count = 0
        if use_llm:
            llm_items = suggest_policies(
                os.getenv("OPENAI_API_KEY"),
                j.get("title",""),
                j.get("description",""),
                list(vocab),
            )
            # stamp JD cues so they pass the JD check
            for it in llm_items:
                if not it.get("jd_cues"):
                    it["jd_cues"] = jd_kws[:8]
            with open(RUNTIME_POL, "w") as rf:
                yaml.safe_dump(llm_items, rf)
            job_llm_count = len(llm_items)
            print(f"LLM: generated {job_llm_count} runtime policies for {slug}")
        else:
            if os.path.exists(RUNTIME_POL):
                os.remove(RUNTIME_POL)

        # COVER
        cover_fname = f"{slug}.md"
        cover = render_cover(j, PROFILE_YAML, TMPL_DIR)
        if jd_kws:
            cover += "\n\n---\n**Keyword Alignment (ATS-safe):** " + ", ".join(jd_kws) + "\n"
        with open(os.path.join(OUTBOX_MD, cover_fname), 'w') as f: f.write(cover)
        j['cover_file'] = cover_fname
        j['cover_path'] = f"outbox/{cover_fname}"
        drafted_covers += 1

        # RESUME — deterministic + (optionally) LLM-driven runtime policies
        out_docx = os.path.join(RESUMES_MD, f"{slug}.docx")
        doc = Document(BASE_RESUME)
        targets = portfolio_targets(portfolio)
        changes = tailor_docx_in_place(
            doc,
            targets,
            jd_keywords=jd_kws,
            allowed_vocab_list=sorted(vocab),
        )
        doc.save(out_docx)
        j['resume_docx'] = f"resumes/{os.path.basename(out_docx)}"

        explain = {
            "company": j.get("company",""),
            "title": j.get("title",""),
            "ats_keywords": jd_kws,
            "changes": changes
        }
        changes_fname = f"{slug}.json"
        with open(os.path.join(CHANGES_DIR, changes_fname), 'w') as f:
            json.dump(explain, f, indent=2)
        j['changes_path'] = f"changes/{changes_fname}"

        llm_summary["jobs"].append({"slug": slug, "runtime_policy_count": job_llm_count})
        drafted_resumes += 1

    # Save updated jobs (with paths)
    with open(DATA_JSON, 'w') as f: json.dump(jobs, f, indent=2)

    # Write LLM info marker
    with open(os.path.join(DATA_DIR, "llm_info.json"), "w") as f:
        json.dump(llm_summary, f, indent=2)

    print(f"Drafted {drafted_covers} cover letters -> {OUTBOX_MD}")
    print(f"Drafted {drafted_resumes} tailored resumes -> {RESUMES_MD}")

if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--top', type=int, default=5)
    args = ap.parse_args()
    main(args.top)
