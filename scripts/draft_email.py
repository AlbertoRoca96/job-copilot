# scripts/draft_email.py
import os, sys, json, re, yaml, hashlib
from typing import Tuple
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from src.tailor.render import render_cover
from src.tailor.resume import tailor_docx_in_place
from docx import Document

import requests
from bs4 import BeautifulSoup

from src.skills.taxonomy import augment_allowed_vocab  # NEW

DATA_JSONL = os.path.join(os.path.dirname(__file__), '..', 'data', 'scores.jsonl')
DATA_JSON  = os.path.join(os.path.dirname(__file__), '..', 'docs', 'data', 'scores.json')
OUTBOX_MD  = os.path.join(os.path.dirname(__file__), '..', 'docs', 'outbox')
RESUMES_MD = os.path.join(os.path.dirname(__file__), '..', 'docs', 'resumes')
CHANGES_DIR= os.path.join(os.path.dirname(__file__), '..', 'docs', 'changes')
DATA_DIR   = os.path.join(os.path.dirname(__file__), '..', 'docs', 'data')

PROFILE_YAML   = os.path.join(os.path.dirname(__file__), '..', 'src', 'core', 'profile.yaml')
PORTFOLIO_YAML = os.path.join(os.path.dirname(__file__), '..', 'src', 'core', 'portfolio.yaml')
TMPL_DIR       = os.path.join(os.path.dirname(__file__), '..', 'src', 'tailor', 'templates')

# IMPORTANT: prefer the user's uploaded resume fetched by scripts/fetch_user_assets.py
CURRENT_RESUME = os.path.join(os.path.dirname(__file__), '..', 'assets', 'current.docx')
FALLBACK_RESUME= os.path.join(os.path.dirname(__file__), '..', 'assets', 'Resume-2025.docx')

BANLIST_JSON   = os.path.join(DATA_DIR, 'banlist.json')

SUPABASE_URL = os.environ.get("SUPABASE_URL","").rstrip("/")
SRK = os.environ.get("SUPABASE_SERVICE_ROLE_KEY","")

SYNONYMS = {
  "js":"javascript","reactjs":"react","ts":"typescript","ml":"machine learning",
  "cv":"computer vision","postgres":"postgresql","gh actions":"github actions",
  "gh-actions":"github actions","ci/cd":"ci","llm":"machine learning","rest":"rest api",
  "etl":"data pipeline"
}
def norm(w): return SYNONYMS.get((w or "").strip().lower(), (w or "").strip().lower())

def tokens(text: str):
    WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9+./-]{1,}")
    return set(WORD_RE.findall((text or "").lower()))

STOPWORDS = {
    "engineer","engineering","software","developer","develop","team","teams","experience","years","year",
    "the","and","for","with","to","of","in","on","as","by","or","an","a","at","from","using",
    "we","you","our","your","will","work","role","responsibilities","requirements","preferred","must",
    "strong","plus","bonus","including","include","etc","ability","skills","excellent","communication",
}

def _allowed_vocab_from_profile(profile: dict, portfolio: dict) -> Set[str]:
    """Original profile->allowed vocabulary (lowercased)."""
    skills = {str(s).lower() for s in (profile.get("skills") or [])}
    titles = {str(t).lower() for t in (profile.get("target_titles") or [])}
    tags = set()
    for section in ("projects", "work_experience", "workshops"):
        for item in (portfolio.get(section, []) or []):
            for b in (item.get("bullets", []) or []):
                for t in (b.get("tags", []) or []):
                    tags.add(str(t).lower())
    expanded = {norm(w) for w in (skills | tags | titles)}
    return set(expanded | skills | tags | titles)

def allowed_vocab(profile: dict, portfolio: dict) -> Set[str]:
    """
    NEW: Augment profile/portfolio skills with ESCO/O*NET title→skills back-off,
    so non-tech roles get solid domain keywords too.
    """
    base = _allowed_vocab_from_profile(profile, portfolio)
    titles = list(profile.get("target_titles") or [])
    augmented = augment_allowed_vocab(base, titles)
    return sorted(set(augmented))

def _count_phrase(text: str, phrase: str) -> int:
    if not phrase:
        return 0
    pat = re.compile(rf"\b{re.escape(phrase)}\b", flags=re.IGNORECASE)
    return len(pat.findall(text or ""))

def extract_jd_terms(job: dict, allowed: set, cap=24):
    title = (job.get("title") or "").lower()
    desc  = (job.get("description") or "").lower()
    url   = job.get("url", "")

    allowed_norm = {norm(a) for a in allowed}
    phrases = [a for a in allowed_norm if " " in a]
    unigrams = [a for a in allowed_norm if a and " " not in a]

    scores = {}
    for ph in phrases:
        if any(x in STOPWORDS for x in ph.split()):
            continue
        c = _count_phrase(desc, ph)
        if c:
            scores[ph] = scores.get(ph, 0) + 3.0 * c
            if ph in title:
                scores[ph] += 2.0

    words = list(tokens(desc))
    for w in words:
        w = norm(w)
        if w in unigrams and w not in STOPWORDS:
            scores[w] = scores.get(w, 0) + 1.0
            if w in title:
                scores[w] += 1.5

    lower_url = url.lower()
    for k in list(scores.keys()):
        if k in lower_url:
            scores[k] += 0.5

    ranked = [k for k,_ in sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))]
    return ranked[:cap]

def safe_name(s: str) -> str:
    return ''.join(c for c in (s or '') if c.isalnum() or c in ('-', '_')).strip()

def fetch_jd_plaintext(job_url: str, timeout=20) -> str:
    if not job_url: return ""
    try:
        r = requests.get(job_url, timeout=timeout, headers={"User-Agent": "Mozilla/5.0 job-copilot-bot"})
        r.raise_for_status()
        soup = BeautifulSoup(r.text, "html.parser")
        main = soup.select_one(".content, .opening, .job, .application, article, main, #content") or soup
        for tag in main(["script","style","noscript","nav","header","footer","form"]): tag.decompose()
        return " ".join(main.get_text(separator=" ", strip=True).split())
    except Exception:
        return ""

def pick_jd_text(job_obj: dict) -> str:
    desc = (job_obj.get("description") or "").strip()
    if len(desc) >= 800: return desc
    live = fetch_jd_plaintext(job_obj.get("url",""))
    return live if len(live) > len(desc) else desc

def write_profile_yaml_from_dict(d: dict):
    y = {
        "full_name": d.get("full_name"),
        "email": d.get("email"),
        "phone": d.get("phone"),
        "skills": d.get("skills") or [],
        "target_titles": d.get("target_titles") or [],
        "locations": d.get("locations") or [],
    }
    os.makedirs(os.path.dirname(PROFILE_YAML), exist_ok=True)
    with open(PROFILE_YAML, "w") as f:
        yaml.safe_dump({k:v for k,v in y.items() if v is not None}, f)

def load_profile_for_user(user_id: str) -> dict:
    if not (SUPABASE_URL and SRK and user_id):
        return {}
    url = f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{user_id}&select=*"
    r = requests.get(url, headers={"apikey": SRK, "Authorization": f"Bearer {SRK}"}, timeout=30)
    r.raise_for_status()
    arr = r.json()
    return (arr[0] if arr else {}) or {}

def _dedup_by_url_keep_order(items):
    seen = set()
    out = []
    for j in items:
        u = (j.get("url") or "").strip().lower()
        key = u or f"no-url::{j.get('company','')}::{j.get('title','')}"
        if key in seen:
            continue
        seen.add(key)
        out.append(j)
    return out

def _select_base_resume() -> str:
    if os.path.isfile(CURRENT_RESUME):
        print(f"Using base resume: {CURRENT_RESUME}")
        return CURRENT_RESUME
    print(f"Using fallback resume: {FALLBACK_RESUME}")
    return FALLBACK_RESUME

def main(top: int, user: str | None):
    # Load profile (from Supabase) so covers use fresh contact info
    prof = load_profile_for_user(user) if user else {}
    if prof:
        write_profile_yaml_from_dict(prof)

    # Ensure portfolio placeholder file exists
    if not os.path.exists(PORTFOLIO_YAML):
        os.makedirs(os.path.dirname(PORTFOLIO_YAML), exist_ok=True)
        with open(PORTFOLIO_YAML, "w") as f:
            yaml.safe_dump({"projects": [], "work_experience": [], "workshops": []}, f)

    with open(PROFILE_YAML, 'r') as f: profile = yaml.safe_load(f) or {}
    portfolio = {}
    if os.path.exists(PORTFOLIO_YAML):
        with open(PORTFOLIO_YAML, 'r') as f: portfolio = yaml.safe_load(f) or {}

    allowed = set(allowed_vocab(profile, portfolio))

    # shortlist as on the dashboard
    jobs = []
    if os.path.exists(DATA_JSON):
        with open(DATA_JSON) as f:
            jobs = json.load(f)
    elif os.path.exists(DATA_JSONL):
        with open(DATA_JSONL) as f:
            for line in f:
                jobs.append(json.loads(line))
    else:
        print('No scores found; run scripts/rank.py first.')
        return

    jobs = _dedup_by_url_keep_order(jobs)
    jobs = jobs[: max(1, min(20, int(top or 5)))]

    # dirs
    os.makedirs(OUTBOX_MD, exist_ok=True)
    os.makedirs(RESUMES_MD, exist_ok=True)
    os.makedirs(CHANGES_DIR, exist_ok=True)
    os.makedirs(DATA_DIR, exist_ok=True)

    # banlist
    try:
        with open(BANLIST_JSON, 'r') as bf: banlist = json.load(bf)
        if not isinstance(banlist, list): banlist = []
    except Exception:
        banlist = []
    banset = {x.strip().lower() for x in banlist}

    use_llm = os.getenv("USE_LLM","0") == "1" and bool(os.getenv("OPENAI_API_KEY"))
    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    print(f"LLM: {'enabled' if use_llm else 'disabled'}")
    if use_llm:
        print(f"LLM model: {model}")

    def jd_sha(s: str) -> str:
        return hashlib.sha1((s or "").encode("utf-8")).hexdigest()[:8]

    base_resume_path = _select_base_resume()

    drafted_covers = drafted_resumes = 0
    llm_summary = {"used": False, "model": None, "jobs": []}

    for j in jobs:
        safe_company = ''.join(c for c in (j.get('company','')) if c.isalnum() or c in ('-','_')).strip()
        safe_title   = ''.join(c for c in (j.get('title',''))   if c.isalnum() or c in ('-','_')).strip()
        slug = f"{safe_company}_{safe_title}"[:150]

        # choose best JD text
        jd_text = pick_jd_text(j) or (j.get("description") or "")
        tmp_job = dict(j); tmp_job["description"] = jd_text
        jd_kws = extract_jd_terms(tmp_job, allowed, cap=24)

        # keep JD raw for debugging
        with open(os.path.join(CHANGES_DIR, f"{slug}.jd.txt"), "w") as f:
            f.write(jd_text[:20000])
        jd_hash = jd_sha(jd_text)

        # COVER
        cover_fname = f"{slug}.md"
        cover = render_cover(j, PROFILE_YAML, TMPL_DIR, jd_keywords=jd_kws)  # pass kws
        with open(os.path.join(OUTBOX_MD, cover_fname), 'w') as f: f.write(cover)
        j['cover_path'] = f"outbox/{cover_fname}"

        # RESUME (tailor inside the doc)
        out_docx_name = f"{slug}_{jd_hash}.docx"
        out_docx = os.path.join(RESUMES_MD, out_docx_name)

        doc = Document(base_resume_path)

        # metadata (keywords only from JD)
        try:
            cp = doc.core_properties
            cp.comments = f"job-copilot:{slug}:{jd_hash}"
            cp.subject = j.get("title","")
            cp.keywords = ", ".join([k for k in jd_kws if k][:16])
        except Exception:
            pass

        granular_changes = tailor_docx_in_place(
            doc,
            jd_keywords=jd_kws,
            allowed_vocab_list=sorted(allowed),
        )

        doc.save(out_docx)
        j['resume_docx'] = f"resumes/{out_docx_name}"
        j['resume_docx_hash'] = jd_hash

        # Explain changes (bullet level only)
        explain = {
            "company": j.get("company",""),
            "title": j.get("title",""),
            "ats_keywords": jd_kws,
            "llm_keywords": [],
            "changes": list(granular_changes or []),
            "jd_hash": jd_hash
        }
        with open(os.path.join(CHANGES_DIR, f"{slug}.json"), 'w') as f:
            json.dump(explain, f, indent=2)
        j['changes_path'] = f"changes/{slug}.json"

        llm_summary["jobs"].append({"slug": slug, "injected": False, "changes": len(explain["changes"])})
        drafted_covers += 1; drafted_resumes += 1

    with open(DATA_JSON, 'w') as f: json.dump(jobs, f, indent=2)
    with open(os.path.join(DATA_DIR, "llm_info.json"), "w") as f: json.dump(llm_summary, f, indent=2)
    with open(BANLIST_JSON, 'w') as bf: json.dump(sorted(list(banset)), bf, indent=2)

    print(f"Drafted {drafted_covers} cover letters -> {OUTBOX_MD}")
    print(f"Drafted {drafted_resumes} tailored resumes -> {RESUMES_MD}")

if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--top', type=int, default=5)
    ap.add_argument('--user', type=str, default='')
    args = ap.parse_args()
    main(args.top, args.user or None)
