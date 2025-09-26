#!/usr/bin/env python3
import os, sys, re, json, time, argparse, hashlib, pathlib, logging
from typing import List, Dict, Any, Optional, Tuple, Set

import requests
from bs4 import BeautifulSoup
from docx import Document
from docx.text.paragraph import Paragraph
from docx.text.run import Run
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

# ----------------------- config -----------------------
UA = "job-copilot/1.0 (+https://github.com/AlbertoRoca96/job-copilot)"
TIMEOUT = (10, 20)  # connect, read
MAX_JD_CHARS = 120_000
MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

# ----------------------- utils -----------------------
CANON = {
    "ap style": "AP style", "cms": "CMS", "pos": "POS", "crm": "CRM",
    "microsoft office": "Microsoft Office", "word": "Word", "excel": "Excel",
    "powerpoint": "PowerPoint", "outlook": "Outlook", "adobe": "Adobe",
    "photoshop": "Photoshop", "illustrator": "Illustrator", "indesign": "InDesign",
    "social media": "Social media", "content calendar": "Content calendar",
    "copyediting": "Copyediting", "fact checking": "Fact-checking",
    "proofreading": "Proofreading", "sql": "SQL", "supabase": "Supabase",
    "github actions": "GitHub Actions", "python": "Python", "javascript": "JavaScript"
}
WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]{1,}")

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
                    if url:
                        out.append({"url": url, **{k:v for k,v in item.items() if k not in ("url","link","jd_url")}})
        elif isinstance(data, dict):
            arr = data.get("jobs") or data.get("items") or data.get("links") or []
            for item in arr:
                if isinstance(item, str):
                    out.append({"url": item})
                elif isinstance(item, dict):
                    url = item.get("url") or item.get("link") or item.get("jd_url")
                    if url:
                        out.append({"url": url, **{k:v for k,v in item.items() if k not in ("url","link","jd_url")}})
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
    """Fetch HTML and collapse to readable text (+ meta descriptions for gated sites)."""
    resp = requests.get(url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.8",
    }, timeout=TIMEOUT, allow_redirects=True)
    resp.raise_for_status()
    html = resp.text
    soup = BeautifulSoup(html, "html.parser")

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
    blob = normalize_ws(" ".join([text] + meta_bits))
    return blob[:MAX_JD_CHARS]

# ----------------------- local keyword miner (fallback) -----------------------
PHRASES = [
    "ap style","cms","content calendar","social media","copyediting","fact checking",
    "proofreading","editorial calendar","pitching","seo","analytics","style guide",
    "calendar management","travel arrangements","expense reports","meeting notes",
    "inbox management","crm","data entry","pos","inventory","front of house",
    "customer service","microsoft office","excel","powerpoint","outlook","adobe",
    "photoshop","illustrator","indesign"
]

def mined_plan(resume_text: str, jd_text: str) -> Dict[str, Any]:
    jd_low = (jd_text or "").lower()
    res_low = (resume_text or "").lower()
    hits = [ph for ph in PHRASES if ph in jd_low]
    # dedupe keep-order
    seen, ordered = set(), []
    for h in hits:
        if h not in seen:
            ordered.append(h); seen.add(h)
    skills_additions = [canon(h) for h in ordered if h not in res_low][:6]

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
    weaves = [{"section":"Work Experience","cue":"","phrase":p} for p in weave_pool[:4]]
    return {"skills_additions": skills_additions, "weaves": weaves}

# ----------------------- LLM (chat completions JSON mode) -----------------------
def call_llm_weaves(resume_text: str, jd_text: str, job_title: str = "", company: str = "") -> Dict[str, Any]:
    if not OPENAI_API_KEY:
        logging.warning("OPENAI_API_KEY not set; using deterministic fallback plan.")
        return mined_plan(resume_text, jd_text)
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

    if not isinstance(plan, dict): plan = {}
    skills_additions = [canon(x) for x in (plan.get("skills_additions") or []) if isinstance(x, str) and x.strip()]
    cleaned_weaves = []
    for w in (plan.get("weaves") or []):
        if not isinstance(w, dict): continue
        phrase = canon((w.get("phrase") or "").strip())
        if not phrase or len(phrase.split()) > 18: continue
        section = (w.get("section") or "Work Experience").strip()
        cue = (w.get("cue") or "").strip()
        cleaned_weaves.append({"section": section, "cue": cue, "phrase": phrase})
    if not skills_additions and not cleaned_weaves:
        return mined_plan(resume_text, jd_text)
    return {"skills_additions": skills_additions[:8], "weaves": cleaned_weaves[:6]}

# ----------------------- .docx helpers -----------------------
def paragraph_is_bullet(p: Paragraph) -> bool:
    # true Word bullets/numbering:
    try:
        pPr = p._p.pPr
        if (pPr is not None) and (pPr.numPr is not None):
            return True
    except Exception:
        pass
    # style hints:
    try:
        name = (getattr(p.style, "name", "") or "").lower()
    except Exception:
        name = ""
    if any(k in name for k in ("list","bullet","number")):
        return True
    # visible glyphs as last resort:
    t = normalize_ws(p.text)
    return t.startswith(("•","-","–","—","·"))

def dominant_run(p: Paragraph) -> Optional[Run]:
    best, best_len = None, -1
    for r in p.runs:
        txt = (r.text or "")
        style_name = (getattr(r.style, "name", "") or "").lower()
        if not txt.strip(): continue
        if "hyperlink" in style_name: continue
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
    p.text = text
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

# ----------------------- XML-level helpers (no namespaces arg) -----------------------
def el_text(p_el) -> str:
    # get all 'w:t' regardless of ns bindings via local-name()
    return "".join(t.text for t in p_el.xpath('.//*[local-name()="t"]') if t.text)

def el_is_bullet(p_el) -> bool:
    # paragraph is bullet/numbered if it has w:pPr/w:numPr
    return bool(p_el.xpath('./*[local-name()="pPr"]/*[local-name()="numPr"]'))

def el_append_run(p_el, text: str):
    r = OxmlElement('w:r')
    t = OxmlElement('w:t')
    t.set(qn('xml:space'), 'preserve')  # keep leading space
    t.text = text
    r.append(t)
    p_el.append(r)

def weave_into_el(p_el, phrase: str) -> Tuple[bool, str, str, str]:
    phrase = canon((phrase or "").strip().rstrip("."))
    before = el_text(p_el)
    if not phrase or not before.strip():
        return (False, before, before, "")
    to_add = f" Using {phrase}."
    if phrase.lower() in before.lower():
        return (False, before, before, "")
    el_append_run(p_el, to_add)
    after = el_text(p_el)
    return (True, before, after, to_add.strip())

def xml_all_paragraphs(doc: Document):
    # ALL paragraphs in the main document part, including tables & text boxes
    # local-name() avoids any namespaces arg (works with python-docx wrapper)
    return list(doc.element.xpath('.//*[local-name()="p"]'))

# ----------------------- skills: find + inject -----------------------
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
        before = p.text
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
            "reason": "Enriched inline skills list."
        }
    return None

# ----------------------- weaving (XML-first, body fallback) -----------------------
def apply_weaves_anywhere(doc: Document, weaves: List[Dict[str,str]], default_phrase: str) -> List[Dict[str,str]]:
    changes: List[Dict[str,str]] = []
    p_els = xml_all_paragraphs(doc)
    bullets = [(i, p_el) for i, p_el in enumerate(p_els) if el_is_bullet(p_el) and normalize_ws(el_text(p_el))]
    if not bullets:
        bullets = [(i, p_el) for i, p_el in enumerate(p_els) if len(normalize_ws(el_text(p_el))) >= 25]

    used = set()
    phrases = [w.get("phrase") for w in (weaves or []) if w.get("phrase")] or []
    if default_phrase and default_phrase not in phrases:
        phrases.append(default_phrase)

    inserted_any = False
    for phrase in phrases[:4]:
        best = None
        cue = ""
        for k, (idx, p_el) in enumerate(bullets):
            if k in used: continue
            t = normalize_ws(el_text(p_el)).lower()
            if not t: continue
            best = (k, idx, p_el); break
        if best:
            k, _, p_el = best
            ok, before, after, ins = weave_into_el(p_el, phrase)
            if ok:
                used.add(k); inserted_any = True
                changes.append({
                    "anchor_section": "Work Experience",
                    "original_paragraph_text": before,
                    "modified_paragraph_text": after,
                    "inserted_sentence": ins,
                    "reason": "Injected inline JD keyword phrase (XML)."
                })

    if not inserted_any and default_phrase:
        for p_el in p_els:
            before = normalize_ws(el_text(p_el))
            if before:
                ok, b2, a2, ins = weave_into_el(p_el, default_phrase)
                if ok:
                    changes.append({
                        "anchor_section": "Work Experience",
                        "original_paragraph_text": b2,
                        "modified_paragraph_text": a2,
                        "inserted_sentence": ins,
                        "reason": "Hard fallback to ensure visible tailoring."
                    })
                break
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
    resume_plain = "\n".join([p.text for p in resume_doc.paragraphs])

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
        plan = call_llm_weaves(resume_plain, jd_text, job_title, company)

        # Save the plan for debugging (we won't include this file in the index we write)
        slug_base = slugify(job_title or url)[:80]
        (out_changes / f"{slug_base}_plan.json").write_text(
            json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8"
        )

        # Apply to a fresh copy of the resume per job
        doc = Document(resume_path)
        changes: List[Dict[str, Any]] = []

        # Pass A: skills additions (body-only; harmless if skills are in shapes)
        skills_change = inject_skills(doc, plan.get("skills_additions") or [])
        if skills_change:
            changes.append({
                "anchor_section": skills_change["section"],
                "original_paragraph_text": skills_change["before"],
                "modified_paragraph_text": skills_change["after"],
                "inserted_sentence": None,
                "reason": skills_change["reason"]
            })

        # Pass B: XML-level weaving into bullets or any real paragraphs
        cands = (plan.get("skills_additions") or []) + [w["phrase"] for w in (plan.get("weaves") or []) if w.get("phrase")]
        default_phrase = canon(cands[0]) if cands else "per the job description requirements"
        weave_changes = apply_weaves_anywhere(doc, plan.get("weaves") or [], default_phrase)
        changes.extend(weave_changes)

        # Persist artifacts
        jd_txt_path = out_changes / f"{slug_base}.jd.txt"
        jd_txt_path.write_text(jd_text, encoding="utf-8")

        h = hashlib.sha1((url + str(time.time())).encode()).hexdigest()[:8]
        out_docx = out_resumes / f"{slug_base}_{h}.docx"
        doc.save(out_docx.as_posix())

        changes_path = out_changes / f"{slug_base}_{h}.json"
        changes_path.write_text(json.dumps(changes, ensure_ascii=False, indent=2), encoding="utf-8")

        index_items.append({
            "url": url,
            "title": job_title,
            "company": company,
            "resume_path": str(out_docx),
            "jd_text_path": str(jd_txt_path),
            "changes_path": str(changes_path),
            "ts": int(time.time())
        })

    # Write drafts index for UI (exclude *_plan.json here)
    index_path = out_root / "drafts_index.json"
    index_path.write_text(json.dumps({
        "outbox": [""],
        "resumes": [pathlib.Path(i["resume_path"]).name for i in index_items],
        "changes": [pathlib.Path(i["changes_path"]).name for i in index_items],
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    logging.info("Wrote index: %s", index_path)

# ----------------------- CLI -----------------------
def main():
    ap = argparse.ArgumentParser(description="Tailor resume from JD links with LLM-assisted weaving (XML-level) + deterministic fallback.")
    ap.add_argument("--links", required=True, help="Path to JSON or .txt containing JD links.")
    ap.add_argument("--resume", required=True, help="Path to source .docx resume.")
    ap.add_argument("--out", required=True, help="Output prefix (e.g., outputs).")
    ap.add_argument("--user", default="user", help="User id folder under output prefix.")
    args = ap.parse_args()
    run_pipeline(args.links, args.resume, args.out, uid=args.user)

if __name__ == "__main__":
    main()
