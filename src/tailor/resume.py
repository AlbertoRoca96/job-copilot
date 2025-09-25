#!/usr/bin/env python3
import os, sys, re, json, time, argparse, hashlib, pathlib, logging
from typing import List, Dict, Any, Optional, Tuple, Set
import requests
from bs4 import BeautifulSoup
from docx import Document
from docx.text.paragraph import Paragraph
from docx.text.run import Run

# ----------------------- config -----------------------
UA = "job-copilot/1.0 (+https://github.com/AlbertoRoca96/job-copilot)"
TIMEOUT = (10, 20)  # connect, read
MAX_JD_CHARS = 120_000
MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

# canonical casing map
CANON = {
    # editorial / comms / general office
    "ap style": "AP style", "cms": "CMS", "pos": "POS",
    "crm": "CRM", "microsoft office": "Microsoft Office",
    "word": "Word", "excel": "Excel", "powerpoint": "PowerPoint",
    "outlook": "Outlook", "adobe": "Adobe", "photoshop": "Photoshop",
    "illustrator": "Illustrator", "indesign": "InDesign",
    "social media": "Social media", "content calendar": "Content calendar",
    "copyediting": "Copyediting", "fact checking": "Fact-checking",
    "proofreading": "Proofreading",
    # tech common
    "sql": "SQL", "supabase": "Supabase", "github actions": "GitHub Actions",
    "python": "Python", "javascript": "JavaScript"
}
WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]{1,}")

STOP = {
    "the","a","an","and","or","to","of","for","in","on","at","by","with","from",
    "is","are","was","were","be","been","as","that","this","these","those","it",
    "you","your","we","our","their","they","he","she","them","i","not"
}

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

# ----------------------- utils -----------------------
def normalize_ws(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip()

def canon(s: str) -> str:
    out = s or ""
    for k in sorted(CANON, key=len, reverse=True):
        out = re.sub(rf"\b{re.escape(k)}\b", CANON[k], out, flags=re.IGNORECASE)
    return out

def tokens(s: str) -> List[str]:
    return WORD_RE.findall((s or "").lower())

def token_set(s: str) -> Set[str]:
    return set(tokens(s))

def slugify(s: str) -> str:
    s = (s or "").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "job"

# ----------------------- shortlist / links -----------------------
def read_links(path: str) -> List[Dict[str, Any]]:
    p = pathlib.Path(path)
    if not p.exists():
        raise FileNotFoundError(path)
    text = p.read_text(encoding="utf-8", errors="ignore")
    # try JSON first
    try:
        data = json.loads(text)
        out = []
        if isinstance(data, list):
            for item in data:
                if isinstance(item, str):
                    out.append({"url": item})
                elif isinstance(item, dict):
                    url = item.get("url") or item.get("link") or item.get("jd_url")
                    if url: out.append({"url": url, **{k:v for k,v in item.items() if k not in ("url","link","jd_url")}})
        elif isinstance(data, dict):
            arr = data.get("jobs") or data.get("items") or data.get("links") or []
            for item in arr:
                if isinstance(item, str):
                    out.append({"url": item})
                elif isinstance(item, dict):
                    url = item.get("url") or item.get("link") or item.get("jd_url")
                    if url: out.append({"url": url, **{k:v for k,v in item.items() if k not in ("url","link","jd_url")}})
        if out: return out
    except Exception:
        pass
    # else treat as newline-delimited list
    out = []
    for line in text.splitlines():
        line = line.strip()
        if line and re.match(r"^https?://", line):
            out.append({"url": line})
    return out

# ----------------------- JD fetch -----------------------
def fetch_jd_plaintext(url: str) -> str:
    """
    Fetch HTML and collapse to readable text. Also harvest <meta name="description"> and og:description
    because some sites (e.g., LinkedIn) return thin/blocked pages to unauth'd clients.
    """
    resp = requests.get(url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.8",
    }, timeout=TIMEOUT, allow_redirects=True)
    resp.raise_for_status()
    html = resp.text
    soup = BeautifulSoup(html, "html.parser")

    # strip obvious cruft
    for tag in soup(["script", "style", "noscript", "svg", "img"]):
        tag.decompose()
    for sel in ["header", "footer", "nav"]:
        for tag in soup.select(sel):
            tag.decompose()

    meta_bits = []
    for m in soup.find_all("meta", attrs={"name": "description"}):
        c = (m.get("content") or "").strip()
        if c: meta_bits.append(c)
    for m in soup.find_all("meta", attrs={"property": "og:description"}):
        c = (m.get("content") or "").strip()
        if c: meta_bits.append(c)

    text = soup.get_text(separator=" ", strip=True)
    blob = " ".join([text] + meta_bits)
    blob = normalize_ws(blob)
    return blob[:MAX_JD_CHARS]

# ----------------------- local keyword miner (fallback) -----------------------
PHRASES = [
    # editorial / media
    "ap style", "cms", "content calendar", "social media", "copyediting",
    "fact checking", "proofreading", "editorial calendar", "pitching",
    "seo", "analytics", "style guide",
    # admin / ops
    "calendar management", "travel arrangements", "expense reports",
    "meeting notes", "inbox management", "crm", "data entry",
    # retail / cx
    "pos", "inventory", "front of house", "customer service",
    # tools
    "microsoft office", "excel", "powerpoint", "outlook", "adobe",
    "photoshop", "illustrator", "indesign"
]

def mine_plan_from_text(resume_text: str, jd_text: str) -> Dict[str, Any]:
    """
    Deterministic plan when the LLM returns little or JD is thin.
    - skills_additions: top phrases present in JD but not obviously present in resume skills.
    - weaves: short prepositional phrases targeted at Work Experience.
    """
    jd_low = (jd_text or "").lower()
    res_low = (resume_text or "").lower()

    hits = []
    for ph in PHRASES:
        if ph in jd_low:
            hits.append(ph)

    # dedupe, respect order
    seen, ordered = set(), []
    for h in hits:
        if h not in seen:
            ordered.append(h)
            seen.add(h)

    # skills_additions (prefer phrases not already present)
    skills_additions = [canon(h) for h in ordered if h not in res_low][:6]

    # build 2–4 weaves
    weave_pool = []
    if "ap style" in jd_low or "cms" in jd_low:
        weave_pool.append("to AP style and CMS guidelines")
    if "social media" in jd_low:
        weave_pool.append("via social media scheduling and analytics")
    if "crm" in jd_low:
        weave_pool.append("using CRM tracking and follow-ups")
    if "excel" in jd_low or "spreadsheet" in jd_low:
        weave_pool.append("using Excel for tracking and reporting")
    if "pos" in jd_low or "inventory" in jd_low:
        weave_pool.append("via POS and inventory checks")

    weaves = []
    for phrase in weave_pool[:4]:
        weaves.append({"section": "Work Experience", "cue": "", "phrase": phrase})

    return {"skills_additions": skills_additions, "weaves": weaves}

# ----------------------- LLM (chat completions JSON mode) -----------------------
def call_llm_weaves(resume_text: str, jd_text: str, job_title: str = "", company: str = "") -> Dict[str, Any]:
    """
    Ask the model for structured suggestions:
      - skills_additions: list[str]
      - weaves: list[{cue, phrase, section}] where phrase is <= 18 words, factual & ATS-relevant

    If the model is unavailable or returns empty, fall back to the deterministic miner above.
    """
    if not OPENAI_API_KEY:
        logging.warning("OPENAI_API_KEY not set; using deterministic fallback plan.")
        return mine_plan_from_text(resume_text, jd_text)

    try:
        from openai import OpenAI
        client = OpenAI(api_key=OPENAI_API_KEY)

        sys_prompt = (
            "You inject ATS-relevant keywords into an existing resume without fabricating achievements. "
            "Prefer weaving short prepositional phrases (e.g., 'to AP style and CMS guidelines', "
            "'via POS and inventory checks') into bullets that already talk about the task. "
            "Keep phrases <= 18 words. Avoid buzzword stuffing. Output JSON only."
        )

        user_prompt = f"""Job title: {job_title or 'N/A'}
Company: {company or 'N/A'}

=== Job Description (plain text) ===
{jd_text}

=== Resume (plain text) ===
{resume_text}

Return JSON with exactly this shape:
{{
  "skills_additions": ["AP style", "CMS", "Excel"],
  "weaves": [
    {{"section":"Work Experience","cue":"edited","phrase":"to AP style and CMS guidelines"}},
    {{"section":"Projects","cue":"wrote","phrase":"with SEO keyword research and analytics"}}
  ]
}}"""

        resp = client.chat.completions.create(
            model=MODEL,
            messages=[{"role": "system", "content": sys_prompt},
                      {"role": "user", "content": user_prompt}],
            response_format={"type": "json_object"},
            temperature=0.2,
        )
        content = resp.choices[0].message.content or "{}"
        plan = json.loads(content)
    except Exception as e:
        logging.warning("LLM call failed (%s). Falling back to deterministic miner.", e)
        plan = {}

    # robust fallback / sanitation
    if not isinstance(plan, dict):
        plan = {}
    skills_additions = plan.get("skills_additions") or []
    weaves = plan.get("weaves") or []
    if (not skills_additions) and (not weaves):
        plan = mine_plan_from_text(resume_text, jd_text)
    else:
        # sanitize casing and lengths
        skills_additions = [canon(x) for x in skills_additions if isinstance(x, str) and x.strip()]
        cleaned_weaves = []
        for w in weaves:
            if not isinstance(w, dict): continue
            phrase = canon((w.get("phrase") or "").strip())
            if not phrase or len(phrase.split()) > 18: continue
            section = (w.get("section") or "Work Experience").strip()
            cue = (w.get("cue") or "").strip()
            cleaned_weaves.append({"section": section, "cue": cue, "phrase": phrase})
        plan = {"skills_additions": skills_additions[:8], "weaves": cleaned_weaves[:6]}

    return plan

# ----------------------- paragraph plumbing (BODY + TABLES) -----------------------
def iter_all_paragraphs(doc: Document):
    """Yield (scope, idx_tuple, paragraph) across body and all tables."""
    for i, p in enumerate(doc.paragraphs):
        yield ("body", (i,), p)
    for ti, table in enumerate(doc.tables):
        for ri, row in enumerate(table.rows):
            for ci, cell in enumerate(row.cells):
                for pi, p in enumerate(cell.paragraphs):
                    yield (f"table[{ti}].r{ri}c{ci}", (ti, ri, ci, pi), p)

def paragraph_has_numbering(p: Paragraph) -> bool:
    """True if Word numbering/bullets are applied (w:numPr)."""
    try:
        pPr = p._p.pPr  # python-docx low-level XML access
        return (pPr is not None) and (pPr.numPr is not None)
    except Exception:
        return False

def paragraph_is_bullet(p: Paragraph) -> bool:
    # 1) true Word bullets/numbering
    if paragraph_has_numbering(p):
        return True
    # 2) style hints
    try:
        name = (getattr(p.style, "name", "") or "").lower()
    except Exception:
        name = ""
    if any(k in name for k in ("list", "bullet", "number")):
        return True
    # 3) visible glyphs (fallback)
    t = normalize_ws(p.text)
    return t.startswith(("•", "-", "–", "—", "·"))

# ----------------------- run/style helpers -----------------------
def dominant_run(p: Paragraph) -> Optional[Run]:
    best, best_len = None, -1
    for r in p.runs:
        txt = (r.text or "")
        style_name = (getattr(r.style, "name", "") or "").lower()
        if not txt.strip():
            continue
        if "hyperlink" in style_name:
            continue
        L = len(txt.strip())
        if L > best_len:
            best, best_len = r, L
    if best is None:
        for r in reversed(p.runs):
            if (r.text or "").strip():
                return r
    return best

def copy_format(src: Run, dst: Run):
    try:
        dst.font.name = src.font.name
        dst.font.size = src.font.size
        dst.font.bold = src.font.bold
        dst.font.italic = src.font.italic
        dst.font.underline = src.font.underline
        try: dst.style = src.style
        except Exception: pass
    except Exception:
        pass

def set_text_preserve_style(p: Paragraph, text: str):
    base = dominant_run(p)
    p.text = text  # replaces runs with one run (paragraph style preserved)
    if base and p.runs:
        copy_format(base, p.runs[0])

def first_sentence_split(text: str) -> int:
    m = re.search(r'([.!?])(\s|$)', text)
    return (m.start(1)+1) if m else len(text)

def weave_into_paragraph(p: Paragraph, phrase: str) -> Tuple[bool, str, str, str]:
    phrase = canon((phrase or "").strip().rstrip("."))
    if not phrase:
        return (False, p.text, p.text, "")
    txt = "".join(r.text for r in p.runs) if p.runs else p.text
    before = txt
    insert_at = first_sentence_split(txt)
    glue = " " if insert_at and insert_at <= len(txt) and txt[insert_at-1].isalnum() else ""
    inserted = f"{glue} using {phrase}"
    new_text = txt[:insert_at] + inserted + txt[insert_at:]
    set_text_preserve_style(p, new_text)
    return (True, before, p.text, inserted.strip())

# ----------------------- (optional) section finder (used in fallback only) -----------------------
def find_section_ranges(doc: Document, titles: List[str]) -> Dict[str, Tuple[int,int]]:
    wants = [normalize_ws(t).lower() for t in titles]
    hits: Dict[str,int] = {}
    for i,p in enumerate(doc.paragraphs):
        if normalize_ws(p.text).lower() in wants:
            hits[normalize_ws(p.text).lower()] = i
    ranges: Dict[str,Tuple[int,int]] = {}
    for k,start in sorted(hits.items(), key=lambda kv: kv[1]):
        later = [v for _,v in sorted(hits.items(), key=lambda kv: kv[1]) if v>start]
        end = later[0] if later else len(doc.paragraphs)
        ranges[k]=(start,end)
    return ranges

# ----------------------- skill list injection -----------------------
def inject_skills(doc: Document, additions: List[str]) -> Optional[Dict[str,str]]:
    if not additions:
        return None
    additions = [canon(a) for a in additions if a]
    ranges = find_section_ranges(doc, ["Technical Skills", "Skills", "Core Skills"])
    if not ranges:
        return None

    key = next(iter([k for k in ("technical skills","skills","core skills") if k in ranges]), None)
    if not key:
        return None
    s, e = ranges[key]
    for i in range(s, e):
        p = doc.paragraphs[i]
        t = normalize_ws(p.text)
        if not t or paragraph_is_bullet(p):
            continue
        if "," not in t and ";" not in t:
            continue
        present = token_set(t)
        new = [a for a in additions if a.lower() not in present]
        if not new:
            return None
        m = re.search(r"\(([^)]+)\)", t)
        before = p.text
        if m:
            inside = m.group(1).strip()
            sep = ", " if inside and not inside.endswith(",") else ""
            after = t[:m.start(1)] + inside + f"{sep}{', '.join(new)}" + t[m.end(1):]
        else:
            t2 = t[:-1] if t.endswith(".") else t
            if ("," in t2 or ";" in t2):
                sep = ", " if not t2.endswith(",") else ""
                after = t2 + f"{sep}{', '.join(new)}"
            else:
                after = t2 + f": {', '.join(new)}"
        set_text_preserve_style(p, after)
        return {
            "section": "Skills/Technical Skills",
            "before": before,
            "after": p.text,
            "inserted": None,
            "reason": "Reordered/enriched inline skills list."
        }
    return None

# ----------------------- weave application (BODY + TABLES) -----------------------
def apply_weaves(doc: Document, weaves: List[Dict[str,str]]) -> List[Dict[str,str]]:
    changes: List[Dict[str,str]] = []
    if not weaves:
        return changes

    # Build candidate bullets from entire document
    bullets = []
    for scope, idx, p in iter_all_paragraphs(doc):
        if paragraph_is_bullet(p) and normalize_ws(p.text):
            bullets.append((scope, idx, p))

    # If no bullets detected, fall back to any non-trivial paragraph
    if not bullets:
        for scope, idx, p in iter_all_paragraphs(doc):
            if len(normalize_ws(p.text)) >= 25:
                bullets.append((scope, idx, p))

    used = set()

    for w in weaves:
        cue = (w.get("cue") or "").lower().strip()
        phrase = w.get("phrase") or ""
        if not phrase:
            continue

        best = None; best_ratio = -1.0
        for k, (scope, idx, p) in enumerate(bullets):
            if k in used:
                continue
            t = normalize_ws(p.text).lower()
            if not t:
                continue
            if cue and cue in t:
                best = (k, scope, idx, p)
                break
            if cue:
                import difflib
                r = difflib.SequenceMatcher(None, cue, t).ratio()
                if r > best_ratio:
                    best_ratio, best = r, (k, scope, idx, p)
            else:
                # no cue: take first available
                best = (k, scope, idx, p)
                break

        if best:
            k, scope, idx, p = best
            ok, before, after, inserted = weave_into_paragraph(p, phrase)
            if ok:
                used.add(k)
                changes.append({
                    "anchor_section": "Work Experience",   # generic since section-agnostic
                    "original_paragraph_text": before,
                    "modified_paragraph_text": after,
                    "inserted_sentence": inserted,
                    "reason": "Injected inline JD keyword phrase."
                })

    return changes

# ----------------------- pipeline -----------------------
def run_pipeline(links_file: str, resume_path: str, out_prefix: str, uid: str = "user") -> None:
    out_root = pathlib.Path(out_prefix).joinpath(uid)
    out_resumes = out_root / "resumes"
    out_changes = out_root / "changes"
    out_outbox = out_root / "outbox"
    for d in (out_resumes, out_changes, out_outbox):
        d.mkdir(parents=True, exist_ok=True)

    resume_doc = Document(resume_path)
    # include text from body + tables so LLM sees everything
    resume_plain = "\n".join([p.text for _,_,p in iter_all_paragraphs(resume_doc)])

    links = read_links(links_file)
    if not links:
        raise RuntimeError("No links found.")

    index_items = []
    for item in links:
        url = item.get("url")
        if not url:
            continue
        logging.info("Fetching JD: %s", url)
        try:
            jd_text = fetch_jd_plaintext(url)
        except Exception as e:
            logging.warning("Failed to fetch %s: %s", url, e)
            continue

        job_title = item.get("title") or item.get("job_title") or ""
        company   = item.get("company") or item.get("org") or ""
        slug = slugify(job_title or url)[:80]  # compute early so we can save plan
        plan = call_llm_weaves(resume_plain, jd_text, job_title, company)

        # Save the LLM/deterministic plan for debugging
        (out_changes / f"{slug}_plan.json").write_text(
            json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8"
        )

        # Apply to a fresh copy of the resume per job
        doc = Document(resume_path)
        changes: List[Dict[str, Any]] = []

        # Pass A: skills additions
        skills_change = inject_skills(doc, plan.get("skills_additions") or [])
        if skills_change:
            changes.append({
                "anchor_section": skills_change["section"],
                "original_paragraph_text": skills_change["before"],
                "modified_paragraph_text": skills_change["after"],
                "inserted_sentence": None,
                "reason": skills_change["reason"]
            })

        # Pass B: weave phrases into bullets (anywhere in doc, body + tables)
        weave_changes = apply_weaves(doc, plan.get("weaves") or [])
        for ch in weave_changes:
            changes.append({
                "anchor_section": ch["anchor_section"],
                "original_paragraph_text": ch["original_paragraph_text"],
                "modified_paragraph_text": ch["modified_paragraph_text"],
                "inserted_sentence": ch["inserted_sentence"],
                "reason": ch["reason"]
            })

        # Pass C: guaranteed fallback if still nothing injected into bullets
        if not weave_changes:
            cands = (plan.get("skills_additions") or []) + [w["phrase"] for w in (plan.get("weaves") or []) if w.get("phrase")]
            top_phrase = canon(cands[0]) if cands else ""
            # choose up to 2 short bullets anywhere
            bullets = []
            for scope, idx, p in iter_all_paragraphs(doc):
                if paragraph_is_bullet(p):
                    bullets.append((p, len(normalize_ws(p.text))))
            bullets = [b for b in bullets if b[1] < 220]
            bullets.sort(key=lambda x: x[1])
            for p, _ in bullets[:2]:
                before = p.text
                set_text_preserve_style(p, before.rstrip().rstrip(".") + (f" Using {top_phrase}." if top_phrase else ""))
                changes.append({
                    "anchor_section": "Work Experience",
                    "original_paragraph_text": before,
                    "modified_paragraph_text": p.text,
                    "inserted_sentence": f"Using {top_phrase}." if top_phrase else "",
                    "reason": "Fallback appender to ensure visible tailoring."
                })

        # Save JD text for inspection
        jd_txt_path = out_changes / f"{slug}.jd.txt"
        jd_txt_path.write_text(jd_text, encoding="utf-8")

        # Save resume
        h = hashlib.sha1((url + str(time.time())).encode()).hexdigest()[:8]
        out_docx = out_resumes / f"{slug}_{h}.docx"
        doc.save(out_docx.as_posix())

        # Write change log JSON (paragraph-level before/after)
        changes_path = out_changes / f"{slug}_{h}.json"
        changes_path.write_text(json.dumps(changes, ensure_ascii=False, indent=2), encoding="utf-8")

        index_items.append({
            "url": url,
            "title": job_title,
            "company": company,
            "resume_path": str(out_docx),
            "jd_text_path": str(jd_txt_path),
            "changes_path": str(changes_path),
            "plan_path": str(out_changes / f"{slug}_plan.json"),
            "ts": int(time.time())
        })

    # Write drafts index for UI
    index_path = out_root / "drafts_index.json"
    index_path.write_text(json.dumps(index_items, ensure_ascii=False, indent=2), encoding="utf-8")
    logging.info("Wrote index: %s", index_path)

# ----------------------- CLI -----------------------
def main():
    ap = argparse.ArgumentParser(description="Tailor resume from JD links with LLM-assisted weaving (+ deterministic fallback).")
    ap.add_argument("--links", required=True, help="Path to JSON or .txt containing JD links.")
    ap.add_argument("--resume", required=True, help="Path to source .docx resume.")
    ap.add_argument("--out", required=True, help="Output prefix (e.g., outputs).")
    ap.add_argument("--user", default="user", help="User id folder under output prefix.")
    args = ap.parse_args()

    run_pipeline(args.links, args.resume, args.out, uid=args.user)

if __name__ == "__main__":
    main()
