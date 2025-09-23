# scripts/draft_email.py
import os, sys, json, re, yaml, hashlib, requests
from bs4 import BeautifulSoup
from docx import Document

# local imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from src.tailor.render import render_cover
from src.tailor.resume import tailor_docx_in_place
from src.ai.llm import suggest_policies  # optional

# Paths (we still write to docs/* locally so the workflow can upload them)
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
BANLIST_JSON   = os.path.join(DATA_DIR, 'banlist.json')

SYNONYMS = {
  "js":"javascript","reactjs":"react","ts":"typescript","ml":"machine learning",
  "cv":"computer vision","postgres":"postgresql","gh actions":"github actions",
  "gh-actions":"github actions","ci/cd":"ci","llm":"machine learning","rest":"rest api",
  "etl":"data pipeline"
}
STOPWORDS = {
    "engineer","engineering","software","developer","develop","team","teams","experience","years","year",
    "the","and","for","with","to","of","in","on","as","by","or","an","a","at","from","using",
    "we","you","our","your","will","work","role","responsibilities","requirements","preferred","must",
    "strong","plus","bonus","including","include","etc","ability","skills","excellent","communication",
}

def norm(w): return SYNONYMS.get((w or "").strip().lower(), (w or "").strip().lower())
def tokens(text: str):
    WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9+./-]{1,}")
    return set(WORD_RE.findall((text or "").lower()))

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

def _count_phrase(text: str, phrase: str) -> int:
    if not phrase: return 0
    pat = re.compile(rf"\b{re.escape(phrase)}\b", flags=re.IGNORECASE)
    return len(pat.findall(text or ""))

def extract_jd_terms(job: dict, allowed: set, cap=24):
    title = (job.get("title") or "").lower()
    desc  = (job.get("description") or "").lower()
    url   = job.get("url", "") or ""

    allowed_norm = {norm(a) for a in allowed}
    phrases = [a for a in allowed_norm if " " in a]
    unigrams = [a for a in allowed_norm if a and " " not in a]

    scores = {}

    # phrases heavier
    for ph in phrases:
        if any(x in STOPWORDS for x in ph.split()): continue
        c = _count_phrase(desc, ph)
        if c:
            scores[ph] = scores.get(ph, 0) + 3.0 * c
            if ph in title: scores[ph] += 2.0

    # unigrams moderate
    words = list(tokens(desc))
    for w in words:
        w = norm(w)
        if w in unigrams and w not in STOPWORDS:
            scores[w] = scores.get(w, 0) + 1.0
            if w in title: scores[w] += 1.5

    # tiny URL hint
    lower_url = url.lower()
    for k in list(scores.keys()):
        if k in lower_url: scores[k] += 0.5

    ranked = [k for k,_ in sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))]
    return ranked[:cap]

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
            if txt: targets["Work Experience"].append(txt)
    for k, arr in list(targets.items()):
        seen, uniq = set(), []
        for t in arr:
            nt=(t or "").strip()
            if nt and nt not in seen:
                uniq.append(nt); seen.add(nt)
        targets[k]=uniq
    return targets

def safe_name(s: str) -> str:
    return ''.join(c for c in (s or '') if c.isalnum() or c in ('-', '_')).strip()

# -------- JD live fetch helpers --------
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
# --------------------------------------

def main(top: int):
    # Profile YAML is written by the workflow step (live from DB)
    with open(PROFILE_YAML, 'r', encoding='utf-8') as f:
        profile = yaml.safe_load(f) or {}

    if os.path.exists(PORTFOLIO_YAML):
        with open(PORTFOLIO_YAML, 'r', encoding='utf-8') as f:
            portfolio = yaml.safe_load(f) or {}
    else:
        portfolio = {"projects": [], "work_experience": [], "workshops": []}

    allowed = set(allowed_vocab(profile, portfolio))

    # Shortlist from docs/data/scores.json
    jobs = []
    if os.path.exists(DATA_JSON):
        with open(DATA_JSON, encoding='utf-8') as f:
            jobs = json.load(f)
    else:
        print('No scores.json; run shortlist first.'); return

    jobs.sort(key=lambda x: x.get('score', 0), reverse=True)

    os.makedirs(OUTBOX_MD, exist_ok=True)
    os.makedirs(RESUMES_MD, exist_ok=True)
    os.makedirs(CHANGES_DIR, exist_ok=True)
    os.makedirs(DATA_DIR, exist_ok=True)

    # global banlist across runs
    try:
        with open(BANLIST_JSON, 'r', encoding='utf-8') as bf: banlist = json.load(bf)
        if not isinstance(banlist, list): banlist = []
    except Exception:
        banlist = []
    banset = {x.strip().lower() for x in banlist}

    drafted_covers = drafted_resumes = 0

    use_llm = os.getenv("USE_LLM","0") == "1" and bool(os.getenv("OPENAI_API_KEY"))
    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

    llm_summary = {"used": bool(use_llm), "model": model if use_llm else None, "jobs": []}
    print(f"LLM: {'using ' + model if use_llm else 'disabled'}")

    def jd_sha(s: str) -> str:
        return hashlib.sha1((s or "").encode("utf-8")).hexdigest()[:8]

    for j in jobs[:top]:
        safe_company = safe_name(j.get('company',''))
        safe_title   = safe_name(j.get('title',''))
        slug = f"{safe_company}_{safe_title}"[:150]

        jd_text = pick_jd_text(j) or (j.get("description") or "")
        tmp_job = dict(j); tmp_job["description"] = jd_text
        jd_kws = extract_jd_terms(tmp_job, allowed, cap=24)

        # write JD snapshot (helps debugging)
        sha = jd_sha(jd_text)
        with open(os.path.join(CHANGES_DIR, f"{slug}.jd.txt"), "w", encoding="utf-8") as f:
            f.write(jd_text[:20000])

        # Optional LLM policy suggestions
        job_llm_count = 0
        if use_llm:
            items = suggest_policies(
                os.getenv("OPENAI_API_KEY"),
                j.get("title",""),
                jd_text,
                list(allowed),
                jd_kws,
                list(banset),
            )
            cleaned = []
            for it in items:
                clause = (it.get("clause") or "").strip().lower()
                if not clause or clause in banset: continue
                if not it.get("jd_cues"):
                    it["jd_cues"] = jd_kws[:8]
                cleaned.append(it)
                banset.add(clause)
            with open(RUNTIME_POL, "w", encoding="utf-8") as rf:
                yaml.safe_dump(cleaned, rf, sort_keys=False, allow_unicode=True)
            job_llm_count = len(cleaned)

        # COVER
        cover = render_cover(j, PROFILE_YAML, TMPL_DIR)
        if jd_kws:
            cover += "\n\n---\n**Keyword Alignment (ATS-safe):** " + ", ".join(jd_kws) + "\n"
        cover_fname = f"{slug}.md"
        with open(os.path.join(OUTBOX_MD, cover_fname), 'w', encoding='utf-8') as f:
            f.write(cover)
        j['cover_path'] = f"outbox/{cover_fname}"

        # RESUME
        out_docx_name = f"{slug}_{sha}.docx"
        doc = Document(BASE_RESUME)
        try:
            cp = doc.core_properties
            cp.comments = f"job-copilot:{slug}:{sha}"
            cp.subject = j.get("title","")
            cp.keywords = ", ".join(jd_kws[:12])
        except Exception:
            pass

        targets = portfolio_targets(portfolio)
        changes = tailor_docx_in_place(
            doc,
            targets,
            jd_keywords=jd_kws,
            allowed_vocab_list=sorted(allowed),
        )
        out_docx = os.path.join(RESUMES_MD, out_docx_name)
        doc.save(out_docx)
        j['resume_docx'] = f"resumes/{out_docx_name}"
        j['resume_docx_hash'] = sha

        explain = {
            "company": j.get("company",""),
            "title": j.get("title",""),
            "ats_keywords": jd_kws,
            "changes": changes,
            "jd_hash": sha
        }
        with open(os.path.join(CHANGES_DIR, f"{slug}.json"), 'w', encoding='utf-8') as f:
            json.dump(explain, f, indent=2)

        llm_summary["jobs"].append({"slug": slug, "runtime_policy_count": job_llm_count})
        drafted_covers += 1; drafted_resumes += 1

    # persist banlist + llm summary (for debugging)
    with open(BANLIST_JSON, 'w', encoding='utf-8') as bf:
        json.dump(sorted(list(banset)), bf, indent=2)
    with open(os.path.join(DATA_DIR, "llm_info.json"), "w", encoding='utf-8') as f:
        json.dump(llm_summary, f, indent=2)

    print(f"Drafted {drafted_covers} cover letters -> {OUTBOX_MD}")
    print(f"Drafted {drafted_resumes} tailored resumes -> {RESUMES_MD}")

if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--top', type=int, default=5)
    args = ap.parse_args()
    main(args.top)
