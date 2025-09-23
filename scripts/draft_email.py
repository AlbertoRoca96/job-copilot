# scripts/draft_email.py
import os, sys, json, re, yaml, hashlib
from typing import Tuple
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from src.tailor.render import render_cover
from src.tailor.resume import tailor_docx_in_place
from docx import Document

from src.ai.llm import craft_tailored_snippets, suggest_policies

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

def write_jd_artifacts(slug: str, jd_text: str, out_dir: str):
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"{slug}.jd.txt")
    with open(path, "w") as f: f.write(jd_text)
    sha = hashlib.sha1(jd_text.encode("utf-8")).hexdigest()[:10]
    print(f"JD[{slug}]: {len(jd_text)} chars (sha1 {sha}) -> docs/changes/{slug}.jd.txt")

def load_profile_for_user(user_id: str) -> dict:
    if not (SUPABASE_URL and SRK and user_id):
        return {}
    url = f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{user_id}&select=*"
    r = requests.get(url, headers={"apikey": SRK, "Authorization": f"Bearer {SRK}"}, timeout=30)
    r.raise_for_status()
    arr = r.json()
    return (arr[0] if arr else {}) or {}

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

def _insert_targeted_summary_paragraph(doc: Document, sentence: str) -> dict | None:
    """
    Insert a Summary heading + targeted sentence AFTER the first paragraph (preserves name),
    or after an existing 'Summary' heading if present. Return a UI-ready change object.
    """
    if not sentence:
        return None

    import re as _re

    # Look for an existing Summary heading
    idx_summary = None
    for i, p in enumerate(doc.paragraphs):
        if _re.search(r"\b(professional\s+summary|summary)\b", (p.text or "").lower()):
            idx_summary = i
            break

    if idx_summary is not None:
        # Insert right after the Summary heading
        insert_at = min(idx_summary + 1, len(doc.paragraphs))
        tail = doc.add_paragraph(sentence)
        original = doc.paragraphs[insert_at].text if insert_at < len(doc.paragraphs) else ""
        # swap to land it at insert_at
        doc.paragraphs[insert_at].text, tail.text = tail.text, doc.paragraphs[insert_at].text
        return {
            "anchor_section": "Summary",
            "original_paragraph_text": original,
            "modified_paragraph_text": doc.paragraphs[insert_at].text,
            "inserted_sentence": sentence
        }

    # No Summary heading: create a new heading paragraph + sentence, placed after the first paragraph (name)
    name_idx = 0
    # Add the heading and the sentence at the end, then bubble them up by swapping
    heading = doc.add_paragraph("Summary")
    para = doc.add_paragraph(sentence)

    # Move heading to index 1 (after name) by swapping
    if len(doc.paragraphs) >= 2:
        doc.paragraphs[1].text, heading.text = heading.text, doc.paragraphs[1].text
        # Move the sentence to index 2
        if len(doc.paragraphs) >= 3:
            doc.paragraphs[2].text, para.text = para.text, doc.paragraphs[2].text
            original = ""  # new paragraph
            return {
                "anchor_section": "Summary",
                "original_paragraph_text": original,
                "modified_paragraph_text": doc.paragraphs[2].text,
                "inserted_sentence": sentence
            }
    # Fallback: if document was tiny, just return the new sentence change
    return {
        "anchor_section": "Summary",
        "original_paragraph_text": "",
        "modified_paragraph_text": sentence,
        "inserted_sentence": sentence
    }

def main(top: int, user: str | None):
    prof = load_profile_for_user(user) if user else {}
    if prof:
        write_profile_yaml_from_dict(prof)

    if not os.path.exists(PORTFOLIO_YAML):
        os.makedirs(os.path.dirname(PORTFOLIO_YAML), exist_ok=True)
        with open(PORTFOLIO_YAML, "w") as f:
            yaml.safe_dump({"projects": [], "work_experience": [], "workshops": []}, f)

    with open(PROFILE_YAML, 'r') as f: profile = yaml.safe_load(f) or {}
    portfolio = {}
    if os.path.exists(PORTFOLIO_YAML):
        with open(PORTFOLIO_YAML, 'r') as f: portfolio = yaml.safe_load(f) or {}

    allowed = set(allowed_vocab(profile, portfolio))

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

    os.makedirs(OUTBOX_MD, exist_ok=True)
    os.makedirs(RESUMES_MD, exist_ok=True)
    os.makedirs(CHANGES_DIR, exist_ok=True)
    os.makedirs(DATA_DIR, exist_ok=True)

    try:
        with open(BANLIST_JSON, 'r') as bf: banlist = json.load(bf)
        if not isinstance(banlist, list): banlist = []
    except Exception:
        banlist = []
    banset = {x.strip().lower() for x in banlist}

    use_llm = os.getenv("USE_LLM","0") == "1" and bool(os.getenv("OPENAI_API_KEY"))
    api_key = os.getenv("OPENAI_API_KEY") if use_llm else None
    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    print(f"LLM: {'using model ' + model if api_key else 'disabled (fallback)'}")

    def jd_sha(s: str) -> str:
        return hashlib.sha1((s or "").encode("utf-8")).hexdigest()[:8]

    drafted_covers = drafted_resumes = 0
    llm_summary = {"used": bool(api_key), "model": model if api_key else None, "jobs": []}

    for j in jobs:
        safe_company = ''.join(c for c in (j.get('company','') or '') if c.isalnum() or c in ('-','_')).strip()
        safe_title   = ''.join(c for c in (j.get('title','') or '')   if c.isalnum() or c in ('-','_')).strip()
        slug = f"{safe_company}_{safe_title}"[:150]

        jd_text = pick_jd_text(j) or (j.get("description") or "")
        tmp_job = dict(j); tmp_job["description"] = jd_text
        jd_kws = extract_jd_terms(tmp_job, allowed, cap=24)
        write_jd_artifacts(slug=slug, jd_text=jd_text[:20000], out_dir=CHANGES_DIR)
        jd_hash = jd_sha(jd_text)

        # ---- LLM: targeted summary + runtime bullet policies ----
        crafted = craft_tailored_snippets(
            api_key=api_key,
            model=model,
            job_title=j.get("title",""),
            jd_text=jd_text,
            profile=profile,
            allowed_vocab=sorted(list(allowed)),
            jd_keywords=jd_kws,
            banlist=sorted(list(banset)),
        )
        summary_sentence = (crafted.get("summary_sentence") or "").strip()
        extra_keywords = crafted.get("keywords") or []

        runtime_policies = []
        if api_key:
            runtime_policies = suggest_policies(
                api_key,
                j.get("title",""),
                jd_text,
                list(allowed),
                jd_kws,
                list(banset),
            ) or []
            # write runtime policy file consumed by load_policies()
            try:
                with open(RUNTIME_POL, "w") as rf:
                    yaml.safe_dump(runtime_policies, rf)
            except Exception:
                pass
            # extend banlist with newly used clauses
            for it in runtime_policies:
                clause = (it.get("clause") or "").strip().lower()
                if clause:
                    banset.add(clause)

        # ---- COVER ----
        cover_fname = f"{slug}.md"
        cover = render_cover(j, PROFILE_YAML, TMPL_DIR)
        if summary_sentence:
            cover += f"\n\n**Targeted Summary:** {summary_sentence}\n"
        if jd_kws:
            cover += "\n\n---\n**Keyword Alignment (ATS-safe):** " + ", ".join(jd_kws) + "\n"
        with open(os.path.join(OUTBOX_MD, cover_fname), 'w') as f: f.write(cover)
        j['cover_path'] = f"outbox/{cover_fname}"

        # ---- RESUME ----
        out_docx_name = f"{slug}_{jd_hash}.docx"
        out_docx = os.path.join(RESUMES_MD, out_docx_name)
        doc = Document(BASE_RESUME)

        summary_change = None
        if summary_sentence:
            try:
                summary_change = _insert_targeted_summary_paragraph(doc, summary_sentence)
            except Exception:
                summary_change = None

        try:
            cp = doc.core_properties
            cp.comments = f"job-copilot:{slug}:{jd_hash}"
            cp.subject = j.get("title","")
            kws = []
            for k in (jd_kws + extra_keywords):
                lk = (k or "").strip().lower()
                if lk and lk not in kws:
                    kws.append(lk)
            cp.keywords = ", ".join(kws[:16])
        except Exception:
            pass

        targets = {"projects": [], "work_experience": [], "workshops": []}
        granular_changes = tailor_docx_in_place(
            doc,
            targets,
            jd_keywords=jd_kws,
            allowed_vocab_list=sorted(allowed),
        )

        doc.save(out_docx)
        j['resume_docx'] = f"resumes/{out_docx_name}"
        j['resume_docx_hash'] = jd_hash

        # ---- UI JSON (granular diffs) ----
        changes_list = []
        if summary_change:
            changes_list.append(summary_change)
        for it in granular_changes or []:
            changes_list.append(it)

        explain = {
            "company": j.get("company",""),
            "title": j.get("title",""),
            "ats_keywords": jd_kws,
            "llm_keywords": extra_keywords[:12],
            "changes": changes_list,
            "jd_hash": jd_hash
        }
        changes_fname = f"{slug}.json"
        with open(os.path.join(CHANGES_DIR, changes_fname), 'w') as f:
            json.dump(explain, f, indent=2)
        j['changes_path'] = f"changes/{changes_fname}"

        llm_summary["jobs"].append({
            "slug": slug,
            "injected": bool(summary_sentence),
            "runtime_policy_count": len(runtime_policies),
            "changes": len(changes_list)
        })
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
