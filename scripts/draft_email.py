import os, sys, json, re, yaml, hashlib, urllib.parse
from typing import Set, List, Dict, Optional, Tuple
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from docx import Document
from bs4 import BeautifulSoup
import requests
from jinja2 import Environment, FileSystemLoader, select_autoescape

# Our local helpers
from src.skills.taxonomy import augment_allowed_vocab
from src.ai.llm import craft_cover_letter
# keep resume tailoring exactly as before if available
try:
    from src.tailor.resume import tailor_docx_in_place
except Exception:
    tailor_docx_in_place = None  # resume tailoring may be handled by other script

# ---------- paths ----------
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
DATA_JSONL = os.path.join(ROOT, 'data', 'scores.jsonl')
DATA_JSON  = os.path.join(ROOT, 'docs', 'data', 'scores.json')
OUTBOX_MD  = os.path.join(ROOT, 'docs', 'outbox')
RESUMES_MD = os.path.join(ROOT, 'docs', 'resumes')
CHANGES_DIR= os.path.join(ROOT, 'docs', 'changes')
DATA_DIR   = os.path.join(ROOT, 'docs', 'data')

PROFILE_YAML   = os.path.join(ROOT, 'src', 'core', 'profile.yaml')
PORTFOLIO_YAML = os.path.join(ROOT, 'src', 'core', 'portfolio.yaml')
TMPL_DIR       = os.path.join(ROOT, 'src', 'tailor', 'templates')
COVER_TMPL     = 'cover_letter.md.j2'

CURRENT_RESUME = os.path.join(ROOT, 'assets', 'current.docx')
FALLBACK_RESUME= os.path.join(ROOT, 'assets', 'Resume-2025.docx')

BANLIST_JSON   = os.path.join(DATA_DIR, 'banlist.json')

SUPABASE_URL = os.environ.get("SUPABASE_URL","").rstrip("/")
SRK = os.environ.get("SUPABASE_SERVICE_ROLE_KEY","")

# Feature toggles (safe defaults)
INLINE_ONLY = os.getenv("TAILOR_INLINE_ONLY","1") == "1"
USE_LLM     = os.getenv("USE_LLM","1") == "1" and bool(os.getenv("OPENAI_API_KEY"))
OPENAI_MODEL= os.getenv("OPENAI_MODEL","gpt-4o-mini")

# Cover-letter specific toggles (optional to set)
COVER_TONE       = os.getenv("COVER_TONE","professional")
COVER_PARAGRAPHS = int(os.getenv("COVER_PARAGRAPHS","4"))
COVER_MAX_WORDS  = int(os.getenv("COVER_MAX_WORDS","400"))
COVER_CONTACT    = os.getenv("COVER_CONTACT","").strip()

# ---------- keyword normalization ----------
SYNONYMS = {
  "js":"javascript","reactjs":"react","ts":"typescript","ml":"machine learning",
  "cv":"computer vision","postgres":"postgresql","gh actions":"github actions",
  "gh-actions":"github actions","ci/cd":"ci","llm":"machine learning","rest":"rest api",
  "etl":"data pipeline"
}
def norm(w: str) -> str:
    return SYNONYMS.get((w or "").strip().lower(), (w or "").strip().lower())

def tokens(text: str) -> Set[str]:
    WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9+./-]{1,}")
    return set(WORD_RE.findall((text or "").lower()))

STOPWORDS = {
    "engineer","engineering","software","developer","develop","team","teams","experience","years","year",
    "the","and","for","with","to","of","in","on","as","by","or","an","a","at","from","using",
    "we","you","our","your","will","work","role","responsibilities","requirements","preferred","must",
    "strong","plus","bonus","including","include","etc","ability","skills","excellent","communication",
}

# ---------- profile/portfolio -> allowed vocab ----------
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

# ---------- JD processing ----------
_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
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
    # Prefer the cached description (crawler), but if short, try the live page
    desc = (job_obj.get("description") or "").strip()
    if len(desc) >= 800:
        return desc
    live = fetch_jd_plaintext(job_obj.get("url",""))
    return live if len(live) > len(desc) else desc

# ---------- company context (About / Values / Products) ----------
def _abs_url(base_url: str, href: str) -> str:
    try:
        return urllib.parse.urljoin(base_url, href)
    except Exception:
        return href

def fetch_company_context(job_url: str, company: str, timeout=18) -> Dict[str, str]:
    """
    Best-effort: pull homepage + 'About'/'Values' if discoverable.
    We keep this lightweight and robust (no JS).
    """
    out = {"about": "", "values": "", "products": ""}
    if not job_url:
        return out
    try:
        # homepage
        parts = urllib.parse.urlparse(job_url)
        base = f"{parts.scheme}://{parts.netloc}/"
        r = requests.get(base, timeout=timeout, headers=_HEADERS)
        if r.ok:
            soup = BeautifulSoup(r.text, "html.parser")
            desc = " ".join((soup.select_one('meta[name="description"]') or {}).get("content","").split())
            hero = " ".join((soup.title.string if soup.title else "").split())
            summary = " ".join((desc or hero or "")).strip()
            out["products"] = summary

            # try to find About/Values
            links = soup.find_all("a")
            about_href = values_href = None
            for a in links:
                txt = (a.get_text() or "").strip().lower()
                href = a.get("href") or ""
                if not href:
                    continue
                if (not about_href) and ("about" in txt or "/about" in href.lower()):
                    about_href = href
                if (not values_href) and ("value" in txt or "mission" in txt or "culture" in txt):
                    values_href = href

            def _read(url):
                try:
                    rr = requests.get(_abs_url(base, url), timeout=timeout, headers=_HEADERS)
                    if rr.ok:
                        ss = BeautifulSoup(rr.text, "html.parser")
                        main = ss.select_one("main, article, .content, #content") or ss
                        for t in main(["script","style","noscript","nav","header","footer","form"]):
                            t.decompose()
                        return " ".join(main.get_text(separator=" ", strip=True).split())[:2000]
                except Exception:
                    return ""
                return ""

            if about_href:
                out["about"] = _read(about_href)
            if values_href:
                out["values"] = _read(values_href)

    except Exception:
        pass
    return out

# ---------- profile YAML helpers ----------
def write_profile_yaml_from_dict(d: dict):
    y = {
        "full_name": d.get("full_name"),
        "email": d.get("email"),
        "phone": d.get("phone"),
        "skills": d.get("skills") or [],
        "target_titles": d.get("target_titles") or [],
        "locations": d.get("locations") or [],
        "github": d.get("github"),
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

def _dedup_by_url_keep_order(items: List[dict]) -> List[dict]:
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

# ---------- JD term scoring ----------
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

# ---------- Jinja2 renderer ----------
def render_cover_markdown(job: dict, profile: dict, plan: dict) -> str:
    env = Environment(
        loader=FileSystemLoader(TMPL_DIR),
        autoescape=select_autoescape(["html", "xml"]),
        trim_blocks=True,
        lstrip_blocks=True,
    )
    tpl = env.get_template(COVER_TMPL)
    return tpl.render(job=job, profile=profile, plan=plan)

# ---------- main ----------
def main(top: int, user: Optional[str]):
    # Load profile from Supabase (parse_resume step updated it)
    prof = load_profile_for_user(user) if user else {}
    if prof:
        # Ensure profile.yaml exists for UI compatibility
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

    with open(PROFILE_YAML, 'r') as f:
        profile = yaml.safe_load(f) or {}

    # Ensure portfolio file exists (used to expand allowed vocab)
    if not os.path.exists(PORTFOLIO_YAML):
        os.makedirs(os.path.dirname(PORTFOLIO_YAML), exist_ok=True)
        with open(PORTFOLIO_YAML, "w") as f:
            yaml.safe_dump({"projects": [], "work_experience": [], "workshops": []}, f)

    portfolio = {}
    if os.path.exists(PORTFOLIO_YAML):
        with open(PORTFOLIO_YAML, 'r') as f:
            portfolio = yaml.safe_load(f) or {}

    allowed = set(allowed_vocab(profile, portfolio))

    # shortlist as on the dashboard
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

    jobs = _dedup_by_url_keep_order(jobs)
    jobs = jobs[: max(1, min(20, int(top or 5)))]

    # dirs
    os.makedirs(OUTBOX_MD, exist_ok=True)
    os.makedirs(RESUMES_MD, exist_ok=True)
    os.makedirs(CHANGES_DIR, exist_ok=True)
    os.makedirs(DATA_DIR, exist_ok=True)

    # banlist passthrough for future LLM policy tweaks (kept for compatibility)
    try:
        with open(BANLIST_JSON, 'r') as bf:
            banlist = json.load(bf)
            if not isinstance(banlist, list): 
                banlist = []
    except Exception:
        banlist = []
    # (We keep/refresh the banlist file to stabilize diffs.)
    with open(BANLIST_JSON, 'w') as bf:
        json.dump(sorted({x.strip().lower() for x in (banlist or []) if x}), bf, indent=2)

    drafted_covers = drafted_resumes = 0
    llm_summary = {"used": USE_LLM, "model": (OPENAI_MODEL if USE_LLM else None), "jobs": []}

    for j in jobs:
        safe_company = ''.join(c for c in (j.get('company','')) if c.isalnum() or c in ('-','_')).strip()
        safe_title   = ''.join(c for c in (j.get('title',''))   if c.isalnum() or c in ('-','_')).strip()
        slug = f"{safe_company}_{safe_title}"[:150]

        # JD text (prefer cached; fall back to live)
        jd_text = pick_jd_text(j) or (j.get("description") or "")
        tmp_job = dict(j); tmp_job["description"] = jd_text
        jd_kws = extract_jd_terms(tmp_job, allowed, cap=24)

        # company blurbs
        cctx = fetch_company_context(j.get("url",""), j.get("company",""))

        # Generate the cover-letter plan (LLM or fallback)
        plan = craft_cover_letter(
            api_key=(os.getenv("OPENAI_API_KEY") if USE_LLM else None),
            model=OPENAI_MODEL,
            job=j,
            jd_text=jd_text,
            profile=profile,
            jd_keywords=jd_kws,
            company_blurbs=cctx,
            tone=COVER_TONE,
            paragraphs=COVER_PARAGRAPHS,
            max_words=COVER_MAX_WORDS,
            contact_name=COVER_CONTACT,
        )

        # Render markdown cover using Jinja2
        cover_fname = f"{slug}.md"
        cover_md = render_cover_markdown(j, profile, plan)
        with open(os.path.join(OUTBOX_MD, cover_fname), 'w', encoding="utf-8") as f:
            f.write(cover_md)
        j['cover_path'] = f"outbox/{cover_fname}"

        # Save raw JD for debugging
        with open(os.path.join(CHANGES_DIR, f"{slug}.jd.txt"), "w", encoding="utf-8") as f:
            f.write(jd_text[:20000])

        # Resume tailoring remains available if the project still uses it here
        if tailor_docx_in_place is not None:
            base_resume_path = CURRENT_RESUME if os.path.isfile(CURRENT_RESUME) else FALLBACK_RESUME
            out_docx_name = f"{slug}_{hashlib.sha1((jd_text or '').encode()).hexdigest()[:8]}.docx"
            out_docx = os.path.join(RESUMES_MD, out_docx_name)
            doc = Document(base_resume_path)

            # (Optional) ATS metadata
            try:
                cp = doc.core_properties
                cp.comments = f"job-copilot:{slug}"
                cp.subject = j.get("title","")
                cp.keywords = ", ".join([k for k in jd_kws if k][:16])
            except Exception:
                pass

            granular_changes = tailor_docx_in_place(
                doc,
                jd_keywords=jd_kws,
                allowed_vocab_list=sorted(allowed),
                inline_only=INLINE_ONLY,
            )

            doc.save(out_docx)
            j['resume_docx'] = f"resumes/{out_docx_name}"
            j['resume_docx_hash'] = hashlib.sha1((jd_text or '').encode()).hexdigest()[:8]

            explain = {
                "company": j.get("company",""),
                "title": j.get("title",""),
                "ats_keywords": jd_kws,
                "llm_keywords": [],
                "changes": list(granular_changes or []),
            }
            with open(os.path.join(CHANGES_DIR, f"{slug}.json"), 'w', encoding="utf-8") as f:
                json.dump(explain, f, indent=2)
            j['changes_path'] = f"changes/{slug}.json"

        llm_summary["jobs"].append({"slug": slug, "cover_plan": True})
        drafted_covers += 1
        if tailor_docx_in_place is not None:
            drafted_resumes += 1

    with open(DATA_JSON, 'w', encoding="utf-8") as f:
        json.dump(jobs, f, indent=2)
    with open(os.path.join(DATA_DIR, "llm_info.json"), "w", encoding="utf-8") as f:
        json.dump(llm_summary, f, indent=2)

    print(f"Drafted {drafted_covers} cover letters -> {OUTBOX_MD}")
    if tailor_docx_in_place is not None:
        print(f"Drafted {drafted_resumes} tailored resumes -> {RESUMES_MD}")

if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--top', type=int, default=5)
    ap.add_argument('--user', type=str, default='')
    args = ap.parse_args()
    main(args.top, args.user or None)
