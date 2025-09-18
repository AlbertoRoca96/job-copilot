import os, sys, json, re, yaml, hashlib, textwrap
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from src.tailor.render import render_cover
from src.tailor.resume import tokens, tailor_docx_in_place
from docx import Document

# LLM (optional)
from src.ai.llm import suggest_policies

# JD fetching
import requests
from bs4 import BeautifulSoup

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
    skills = {s.lower() for s in (profile.get("skills") or [])}
    titles = {t.lower() for t in (profile.get("target_titles") or [])}
    tags = set()
    for section in ("projects", "work_experience", "workshops"):
        for item in (portfolio.get(section, []) or []):
            for b in (item.get("bullets", []) or []):
                for t in (b.get("tags", []) or []):
                    tags.add(str(t).lower())
    expanded = {norm(w) for w in (skills | tags | titles)}
    return sorted(expanded | skills | tags | titles)

def tokens(text: str):
    import re
    WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]{1,}")
    return set(WORD_RE.findall((text or "").lower()))

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
            txt = (b.get("text","") or "").strip()
            if txt: 
                targets["Side Projects"].append(txt)
                targets["Projects"].append(txt)
    for w in (portfolio.get("work_experience", []) or []):
        for b in (w.get("bullets", []) or []):
            txt = (b.get("text","") or "").strip()
            if txt:
                targets["Work Experience"].append(txt)
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

# -------- JD live fetch + artifact helpers --------

def fetch_jd_plaintext(job_url: str, timeout=20) -> str:
    if not job_url:
        return ""
    try:
        r = requests.get(job_url, timeout=timeout, headers={
            "User-Agent": "Mozilla/5.0 job-copilot-bot"
        })
        r.raise_for_status()
        soup = BeautifulSoup(r.text, "html.parser")
        main = soup.select_one(".content, .opening, .job, .application, article, main, #content")
        if not main:
            main = soup
        for tag in main(["script","style","noscript","nav","header","footer","form"]):
            tag.decompose()
        text = " ".join(main.get_text(separator=" ", strip=True).split())
        return text
    except Exception:
        return ""

def pick_jd_text(job_obj: dict) -> str:
    desc = (job_obj.get("description") or "").strip()
    if len(desc) >= 800:
        return desc
    live = fetch_jd_plaintext(job_obj.get("url",""))
    return live if len(live) > len(desc) else desc

def write_jd_artifacts(slug: str, jd_text: str, out_dir: str):
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"{slug}.jd.txt")
    with open(path, "w") as f:
        f.write(jd_text)
    sha = hashlib.sha1(jd_text.encode("utf-8")).hexdigest()[:10]
    print(f"JD[{slug}]: {len(jd_text)} chars (sha1 {sha}) -> docs/changes/{slug}.jd.txt")

# --------------------------------------------------

def main(top: int):
    with open(PROFILE_YAML, 'r') as f: profile = yaml.safe_load(f) or {}
    if os.path.exists(PORTFOLIO_YAML):
        with open(PORTFOLIO_YAML, 'r') as f: portfolio = yaml.safe_load(f) or {}
    else:
        portfolio = {"projects": [], "work_experience": [], "workshops": []}

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

    def jd_sha(s: str) -> str:
        return hashlib.sha1((s or "").encode("utf-8")).hexdigest()[:8]

    for j in jobs[:top]:
        safe_company = safe_name(j.get('company',''))
        safe_title   = safe_name(j.get('title',''))
        slug = f"{safe_company}_{safe_title}"[:150]

        # ---- Use real JD text (live fetch when needed) ----
        jd_text = pick_jd_text(j) or (j.get("description") or "")
        tmp_job = dict(j); tmp_job["description"] = jd_text
        jd_kws = jd_keywords(tmp_job, vocab)
        write_jd_artifacts(slug=slug, jd_text=jd_text[:20000], out_dir=CHANGES_DIR)
        jd_hash = jd_sha(jd_text)

        # Optional: get per-job policies from LLM
        job_llm_count = 0
        if use_llm:
            llm_items = suggest_policies(
                os.getenv("OPENAI_API_KEY"),
                j.get("title",""),
                jd_text,
                list(vocab),
            )
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

        # RESUME — hashed filename + metadata stamp
        out_docx_name = f"{slug}_{jd_hash}.docx"
        out_docx = os.path.join(RESUMES_MD, out_docx_name)
        doc = Document(BASE_RESUME)
        # Embed provenance into docx properties
        try:
            cp = doc.core_properties
            cp.comments = f"job-copilot:{slug}:{jd_hash}"
            cp.subject = j.get("title","")
            cp.keywords = ", ".join(jd_kws[:12])
        except Exception:
            pass
        targets = portfolio_targets(portfolio)
        changes = tailor_docx_in_place(
            doc,
            targets,
            jd_keywords=jd_kws,
            allowed_vocab_list=sorted(vocab),
        )
        doc.save(out_docx)
        j['resume_docx'] = f"resumes/{out_docx_name}"
        j['resume_docx_hash'] = jd_hash  # used for cache-busting on the dashboard

        explain = {
            "company": j.get("company",""),
            "title": j.get("title",""),
            "ats_keywords": jd_kws,
            "changes": changes,
            "jd_hash": jd_hash
        }
        changes_fname = f"{slug}.json"
        with open(os.path.join(CHANGES_DIR, changes_fname), 'w') as f:
            json.dump(explain, f, indent=2)
        j['changes_path'] = f"changes/{changes_fname}"

        llm_summary["jobs"].append({"slug": slug, "runtime_policy_count": job_llm_count})
        drafted_covers += 1; drafted_resumes += 1

    # Save updated jobs (with paths + hash)
    with open(DATA_JSON, 'w') as f: json.dump(jobs, f, indent=2)
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
