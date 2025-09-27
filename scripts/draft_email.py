#!/usr/bin/env python3
import os, sys, json, re, yaml, hashlib, pathlib
from typing import Set, List, Dict, Optional, Tuple
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from src.tailor.cover import generate_cover_letter, get_company_context, pick_company_themes
from src.tailor.resume import tailor_docx_in_place
from src.skills.taxonomy import augment_allowed_vocab
from docx import Document

import requests
from bs4 import BeautifulSoup

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))

# ---------- helpers ----------
def safe_slug(s: str) -> str:
    s = (s or "").strip()
    return "".join([c for c in s if c.isalnum() or c in ('-','_',' ')])[:150].strip().replace(" ", "_")

def norm(w: str) -> str:
    SYN = {
      "js":"javascript","reactjs":"react","ts":"typescript","ml":"machine learning",
      "cv":"computer vision","postgres":"postgresql","gh actions":"github actions",
      "gh-actions":"github actions","ci/cd":"ci","llm":"machine learning","rest":"rest api",
      "etl":"data pipeline"
    }
    w2 = (w or "").strip().lower()
    return SYN.get(w2, w2)

def tokens(text: str) -> Set[str]:
    WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9+./-]{1,}")
    return set(WORD_RE.findall((text or "").lower()))

STOPWORDS = {
    "engineer","engineering","software","developer","develop","team","teams","experience","years","year",
    "the","and","for","with","to","of","in","on","as","by","or","an","a","at","from","using",
    "we","you","our","your","will","work","role","responsibilities","requirements","preferred","must",
    "strong","plus","bonus","including","include","etc","ability","skills","excellent","communication",
}

# ---------- JD fetch ----------
_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
}
def fetch_jd_plaintext(job_url: str, timeout=20) -> str:
    if not job_url:
        return ""
    try:
        r = requests.get(job_url, timeout=timeout, headers=_HEADERS)
        r.raise_for_status()
        soup = BeautifulSoup(r.text, "html.parser")
        main = soup.select_one(".content, .opening, .job, .application, article, main, #content") or soup
        for tag in main(["script","style","noscript","nav","header","footer","form"]):
            tag.decompose()
        return " ".join(main.get_text(separator=" ", strip=True).split())
    except Exception:
        return ""

def pick_jd_text(job_obj: dict) -> str:
    desc = (job_obj.get("description") or "").strip()
    if len(desc) >= 800:
        return desc
    live = fetch_jd_plaintext(job_obj.get("url",""))
    return live if len(live) > len(desc) else desc

# ---------- Supabase profile ----------
SUPABASE_URL = os.environ.get("SUPABASE_URL","").rstrip("/")
SRK = os.environ.get("SUPABASE_SERVICE_ROLE_KEY","")

def load_profile_for_user(user_id: str) -> dict:
    if not (SUPABASE_URL and SRK and user_id):
        return {}
    url = f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{user_id}&select=*"
    r = requests.get(url, headers={"apikey": SRK, "Authorization": f"Bearer {SRK}"}, timeout=30)
    r.raise_for_status()
    arr = r.json()
    return (arr[0] if arr else {}) or {}

# ---------- allowed vocab ----------
def _allowed_vocab_from_profile(profile: dict, portfolio: dict) -> Set[str]:
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

def allowed_vocab(profile: dict, portfolio: dict) -> List[str]:
    base = _allowed_vocab_from_profile(profile, portfolio)
    titles = list(profile.get("target_titles") or [])
    return sorted(set(augment_allowed_vocab(base, titles)))

# ---------- keyword scoring ----------
def _count_phrase(text: str, phrase: str) -> int:
    if not phrase:
        return 0
    pat = re.compile(rf"\b{re.escape(phrase)}\b", flags=re.IGNORECASE)
    return len(pat.findall(text or ""))

def extract_jd_terms(job: dict, allowed: set, cap=24) -> List[str]:
    title = (job.get("title") or "").lower()
    desc  = (job.get("description") or "").lower()
    url   = job.get("url", "")

    allowed_norm = {norm(a) for a in allowed}
    phrases = [a for a in allowed_norm if " " in a]
    unigrams = [a for a in allowed_norm if a and " " not in a]

    scores: Dict[str, float] = {}

    for ph in phrases:
        if any(x in STOPWORDS for x in ph.split()):
            continue
        c = _count_phrase(desc, ph)
        if c:
            scores[ph] = scores.get(ph, 0.0) + 3.0 * c
            if ph in title:
                scores[ph] += 2.0

    for w in list(tokens(desc)):
        w = norm(w)
        if w in unigrams and w not in STOPWORDS:
            scores[w] = scores.get(w, 0.0) + 1.0
            if w in title:
                scores[w] += 1.5

    lower_url = (url or "").lower()
    for k in list(scores.keys()):
        if k in lower_url:
            scores[k] += 0.5

    ranked = [k for k,_ in sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))]
    return ranked[:cap]

# ---------- main ----------
def main(top: int, user: Optional[str]):
    if not user:
        print("Missing --user; required for per-user output folders.")
        sys.exit(1)

    # Resolve per-user paths
    BASE_USER_DIR = os.path.join(ROOT, "docs", user)
    OUTBOX_MD   = os.path.join(BASE_USER_DIR, "outbox")
    RESUMES_MD  = os.path.join(BASE_USER_DIR, "resumes")
    CHANGES_DIR = os.path.join(BASE_USER_DIR, "changes")
    DATA_DIR    = os.path.join(ROOT, "docs", "data")
    PROFILE_YAML   = os.path.join(ROOT, "src", "core", "profile.yaml")
    PORTFOLIO_YAML = os.path.join(ROOT, "src", "core", "portfolio.yaml")

    # Load profile fresh (parse_resume step updated it)
    prof = load_profile_for_user(user)
    if prof:
        y = {
            "full_name": prof.get("full_name"),
            "email": prof.get("email"),
            "phone": prof.get("phone"),
            "skills": prof.get("skills") or [],
            "target_titles": prof.get("target_titles") or [],
            "locations": prof.get("locations") or [],
            "github": prof.get("github"),
        }
        os.makedirs(os.path.dirname(PROFILE_YAML), exist_ok=True)
        with open(PROFILE_YAML, "w") as f:
            yaml.safe_dump({k:v for k,v in y.items() if v is not None}, f)

    # Ensure portfolio file exists
    if not os.path.exists(PORTFOLIO_YAML):
        os.makedirs(os.path.dirname(PORTFOLIO_YAML), exist_ok=True)
        with open(PORTFOLIO_YAML, "w") as f:
            yaml.safe_dump({"projects": [], "work_experience": [], "workshops": []}, f)

    with open(PROFILE_YAML, 'r') as f:
        profile = yaml.safe_load(f) or {}
    with open(PORTFOLIO_YAML, 'r') as f:
        portfolio = yaml.safe_load(f) or {}

    allowed = set(allowed_vocab(profile, portfolio))

    # shortlist (as on the dashboard)
    DATA_JSONL = os.path.join(ROOT, "data", "scores.jsonl")
    DATA_JSON  = os.path.join(ROOT, "docs", "data", "scores.json")

    jobs: List[dict] = []
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

    # Keep order & dedupe by URL
    seen = set(); deduped = []
    for j in jobs:
        key = (j.get("url") or "").strip().lower() or f"no-url::{j.get('company','')}::{j.get('title','')}"
        if key in seen: continue
        seen.add(key); deduped.append(j)
    jobs = deduped[: max(1, min(20, int(top or 5)))]

    # dirs
    os.makedirs(OUTBOX_MD, exist_ok=True)
    os.makedirs(RESUMES_MD, exist_ok=True)
    os.makedirs(CHANGES_DIR, exist_ok=True)
    os.makedirs(DATA_DIR, exist_ok=True)

    BANLIST_JSON = os.path.join(DATA_DIR, 'banlist.json')
    try:
        with open(BANLIST_JSON, 'r') as bf:
            banlist = json.load(bf)
            if not isinstance(banlist, list): banlist = []
    except Exception:
        banlist = []
    banset = {x.strip().lower() for x in banlist}

    use_llm = os.getenv("USE_LLM","0") == "1" and bool(os.getenv("OPENAI_API_KEY"))
    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    print(f"LLM: {'enabled' if use_llm else 'disabled'}")
    if use_llm: print(f"LLM model: {model}")

    def jd_sha(s: str) -> str:
        return hashlib.sha1((s or "").encode("utf-8")).hexdigest()[:8]

    # choose base resume
    CURRENT_RESUME = os.path.join(ROOT, "assets", "current.docx")
    FALLBACK_RESUME= os.path.join(ROOT, "assets", "Resume-2025.docx")
    base_resume_path = CURRENT_RESUME if os.path.isfile(CURRENT_RESUME) else FALLBACK_RESUME
    print(f"Using base resume: {base_resume_path}")

    drafted_covers = drafted_resumes = 0
    llm_summary = {"used": use_llm, "model": (model if use_llm else None), "jobs": []}

    for j in jobs:
        safe_company = safe_slug(j.get('company',''))
        safe_title   = safe_slug(j.get('title',''))
        slug = f"{safe_company}_{safe_title}"[:150]

        jd_text = pick_jd_text(j) or (j.get("description") or "")
        tmp_job = dict(j); tmp_job["description"] = jd_text
        jd_kws = extract_jd_terms(tmp_job, allowed, cap=24)

        # keep JD raw for UI
        jd_txt_path = os.path.join(CHANGES_DIR, f"{slug}.jd.txt")
        with open(jd_txt_path, "w") as f:
            f.write(jd_text[:20000])

        jd_hash = jd_sha(jd_text)

        # company themes for UI (and pass-through to generator)
        ctx = get_company_context(j)
        company_themes = pick_company_themes(ctx)

        # COVER (LLM-first; deterministic fallback)
        cover_fname = f"{slug}.md"
        cover_md = generate_cover_letter(
            job=j,
            profile=profile,
            jd_text=jd_text,
            jd_keywords=jd_kws,
            allowed_vocab=sorted(allowed),
            tone=os.getenv("COVER_TONE", "professional")
        )
        with open(os.path.join(OUTBOX_MD, cover_fname), 'w') as f:
            f.write(cover_md)
        j['cover_path'] = f"outbox/{cover_fname}"

        # RESUME (tailor inside the actual doc)
        out_docx_name = f"{slug}_{jd_hash}.docx"
        out_docx = os.path.join(RESUMES_MD, out_docx_name)

        doc = Document(base_resume_path)

        # metadata (ATS keywords = jd_kws)
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
            inline_only=(os.getenv("TAILOR_INLINE_ONLY","1") == "1"),
        )
        doc.save(out_docx)

        # Explain changes (UI-friendly; now includes cover meta + paths)
        explain = {
            "company": j.get("company",""),
            "title": j.get("title",""),
            "ats_keywords": jd_kws,
            "llm_keywords": [],
            "changes": list(granular_changes or []),
            "jd_hash": jd_hash,
            "paths": {
                "resume_docx": f"resumes/{out_docx_name}",
                "cover_md": f"outbox/{cover_fname}",
                "jd_text": f"changes/{slug}.jd.txt"
            },
            "cover_meta": {
                "company_themes": company_themes[:8],
                "tone": os.getenv("COVER_TONE", "professional")
            }
        }
        with open(os.path.join(CHANGES_DIR, f"{slug}.json"), 'w') as f:
            json.dump(explain, f, indent=2)

        llm_summary["jobs"].append({"slug": slug, "cover": True, "resume_injected": True, "changes": len(explain["changes"])})
        drafted_covers += 1; drafted_resumes += 1

    with open(os.path.join(ROOT, "docs", "data", "scores.json"), 'w') as f:
        json.dump(jobs, f, indent=2)
    with open(os.path.join(ROOT, "docs", "data", "llm_info.json"), "w") as f:
        json.dump(llm_summary, f, indent=2)
    with open(os.path.join(ROOT, "docs", "data", "banlist.json"), 'w') as bf:
        json.dump(sorted(list(banset)), bf, indent=2)

    print(f"Drafted {drafted_covers} cover letters -> {OUTBOX_MD}")
    print(f"Drafted {drafted_resumes} tailored resumes -> {RESUMES_MD}")

if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--top', type=int, default=5)
    ap.add_argument('--user', type=str, required=True)
    args = ap.parse_args()
    main(args.top, args.user)
