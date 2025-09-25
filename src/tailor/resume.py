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
MAX_JD_CHARS = 100_000
MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

# canonical casing map
CANON = {
    "ap style": "AP style", "cms": "CMS", "pos": "POS",
    "crm": "CRM", "microsoft office": "Microsoft Office",
    "word": "Word", "excel": "Excel", "powerpoint": "PowerPoint",
    "outlook": "Outlook", "adobe": "Adobe", "photoshop": "Photoshop",
    "illustrator": "Illustrator", "indesign": "InDesign",
    "sql": "SQL", "supabase": "Supabase", "github actions": "GitHub Actions",
    "python": "Python", "javascript": "JavaScript"
}
WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]{1,}")

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

# ----------------------- utils -----------------------
def normalize_ws(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip()

def canon(s: str) -> str:
    out = s or ""
    for k in sorted(CANON, key=len, reverse=True):
        out = re.sub(rf"\b{re.escape(k)}\b", CANON[k], out, flags=re.IGNORECASE)
    return out

def tokens(s: str) -> Set[str]:
    return set(WORD_RE.findall((s or "").lower()))

def slugify(s: str) -> str:
    s = (s or "").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "job"

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

# ------------ JD fetch (with LinkedIn fallbacks to description/meta) ------------
def _extract_linkedin_text(html: str, soup: BeautifulSoup) -> Optional[str]:
    # try JSON-LD description
    for tag in soup.find_all("script", {"type": "application/ld+json"}):
        try:
            obj = json.loads(tag.string or "")
            if isinstance(obj, dict):
                desc = obj.get("description")
                if isinstance(desc, str) and len(desc) > 60:
                    return normalize_ws(BeautifulSoup(desc, "html.parser").get_text(" ", strip=True))
        except Exception:
            continue
    # meta description
    meta = soup.find("meta", {"name": "description"}) or soup.find("meta", {"property": "og:description"})
    if meta and meta.get("content"):
        return normalize_ws(meta["content"])
    return None

def fetch_jd_plaintext(url: str) -> str:
    resp = requests.get(url, headers={"User-Agent": UA}, timeout=TIMEOUT)
    resp.raise_for_status()
    html = resp.text
    soup = BeautifulSoup(html, "html.parser")
    # strip obvious cruft
    for tag in soup(["script", "style", "noscript", "svg", "img"]):
        tag.decompose()
    for sel in ["header", "footer", "nav"]:
        for tag in soup.select(sel):
            tag.decompose()
    text = soup.get_text(separator=" ", strip=True)
    text = normalize_ws(text)
    # LinkedIn login walls: fall back to description if body text looks useless
    if ("linkedin.com" in url) and (len(text) < 400):
        alt = _extract_linkedin_text(html, soup)
        if alt: text = alt
    return text[:MAX_JD_CHARS]

# ----------------------- LLM (Chat Completions + tool calling) -----------------------
def call_llm_weaves(resume_text: str, jd_text: str, job_title: str = "", company: str = "") -> Dict[str, Any]:
    """
    Return:
      { "skills_additions": [str], "weaves": [ {section, cue, phrase} ] }
    """
    if not OPENAI_API_KEY:
        logging.warning("OPENAI_API_KEY not set; returning empty LLM suggestions.")
        return {"skills_additions": [], "weaves": []}

    from openai import OpenAI
    client = OpenAI(api_key=OPENAI_API_KEY)

    tool = {
        "type": "function",
        "function": {
            "name": "TailorPlan",
            "description": "Return ATS-safe additions for Skills list, and short inline weave phrases per section.",
            "parameters": {
                "type": "object",
                "properties": {
                    "skills_additions": {"type": "array", "items": {"type": "string"}},
                    "weaves": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "section": {"type": "string", "enum": ["Work Experience", "Projects"]},
                                "cue": {"type": "string"},
                                "phrase": {"type": "string", "maxLength": 120}
                            },
                            "required": ["section", "cue", "phrase"],
                            "additionalProperties": False
                        }
                    }
                },
                "required": ["skills_additions", "weaves"],
                "additionalProperties": False
            }
        }
    }

    sys_prompt = (
        "You inject ATS-relevant keywords into an existing resume without fabricating achievements. "
        "Prefer weaving short prepositional phrases (e.g., 'to AP style and CMS guidelines', 'via POS and inventory checks') "
        "into bullets that already talk about the task. Keep phrases <= 18 words. Avoid buzzword stuffing."
    )

    user_prompt = f"""Job title: {job_title or 'N/A'}
Company: {company or 'N/A'}

=== Job Description (plain text) ===
{jd_text}

=== Resume (plain text) ===
{resume_text}

Return JSON with:
- skills_additions: short terms for the Skills list that appear in the JD (or synonyms), truthful w.r.t. resume.
- weaves: small phrases to inject inline into existing bullets; include a minimal 'cue' substring to locate the bullet.
"""

    try:
        resp = client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": user_prompt},
            ],
            tools=[tool],
            tool_choice={"type": "function", "function": {"name": "TailorPlan"}},
            temperature=0.2,
        )
        msg = resp.choices[0].message
        if getattr(msg, "tool_calls", None):
            args = msg.tool_calls[0].function.arguments
            return json.loads(args)
        if msg.content:
            return json.loads(msg.content)
    except Exception as e:
        logging.error("LLM tool-call failed: %s", e)

    return {"skills_additions": [], "weaves": []}

# ----------------------- .docx editing -----------------------
def paragraph_is_bullet(p: Paragraph) -> bool:
    try:
        name = (getattr(p.style, "name", "") or "").lower()
    except Exception:
        name = ""
    if "list" in name or "bullet" in name or "number" in name:
        return True
    t = normalize_ws(p.text)
    return t.startswith(("•", "-", "–", "·"))

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
    p.text = text
    if base and p.runs:
        copy_format(base, p.runs[0])

def first_sentence_split(text: str) -> int:
    m = re.search(r'([.!?])(\s|$)', text)
    return (m.start(1)+1) if m else len(text)

def weave_into_paragraph(p: Paragraph, phrase: str) -> bool:
    phrase = canon((phrase or "").strip().rstrip("."))
    if not phrase: return False
    txt = "".join(r.text for r in p.runs) if p.runs else p.text
    insert_at = first_sentence_split(txt)
    glue = " " if insert_at and insert_at <= len(txt) and txt[insert_at-1].isalnum() else ""
    new_text = txt[:insert_at] + f"{glue} using {phrase}" + txt[insert_at:]
    set_text_preserve_style(p, new_text)
    return True

def inject_skills(doc: Document, additions: List[str]) -> bool:
    if not additions: return False
    additions = [canon(a) for a in additions if a]
    ranges = find_section_ranges(doc, ["Technical Skills", "Skills", "Core Skills"])
    if not ranges: return False
    key = next(iter([k for k in ("technical skills","skills","core skills") if k in ranges]), None)
    if not key: return False
    s, e = ranges[key]
    for i in range(s, e):
        p = doc.paragraphs[i]
        t = normalize_ws(p.text)
        if not t or paragraph_is_bullet(p) or ("," not in t and ";" not in t):
            continue
        present = tokens(t)
        new = [a for a in additions if a.lower() not in present]
        if not new: return False
        m = re.search(r"\(([^)]+)\)", t)
        if m:
            inside = m.group(1).strip()
            sep = ", " if inside and not inside.endswith(",") else ""
            after = t[:m.start(1)] + inside + f"{sep}{', '.join(new)}" + t[m.end(1):]
        else:
            t2 = t[:-1] if t.endswith(".") else t
            sep = ", " if ("," in t2 or ";" in t2) and not t2.endswith(",") else (", " if ("," in t2 or ";" in t2) else ": ")
            after = t2 + f"{sep}{', '.join(new)}"
        set_text_preserve_style(p, after)
        return True
    return False

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

def apply_weaves(doc: Document, weaves: List[Dict[str,str]]) -> int:
    changed = 0
    if not weaves: return changed
    secs = find_section_ranges(doc, ["Work Experience","Professional Experience","Experience",
                                     "Projects","Project Experience","Side Projects"])
    def para_indices(keys: List[str]) -> List[int]:
        for k in keys:
            lk = k.lower()
            if lk in secs:
                s,e = secs[lk]
                return list(range(s,e))
        return []
    work_idxs = para_indices(["Work Experience","Professional Experience","Experience"])
    proj_idxs = para_indices(["Projects","Project Experience","Side Projects"])

    for w in weaves:
        section = (w.get("section") or "Work Experience")
        cue = (w.get("cue") or "").lower().strip()
        phrase = w.get("phrase") or ""
        idxs = work_idxs if section.startswith("Work") else proj_idxs
        best = None; best_ratio = 0.0
        for i in idxs:
            p = doc.paragraphs[i]
            if not paragraph_is_bullet(p): continue
            t = normalize_ws(p.text).lower()
            if not cue: best = i; break
            if cue in t:
                best = i; break
            import difflib
            r = difflib.SequenceMatcher(None, cue, t).ratio()
            if r > best_ratio:
                best_ratio, best = r, i
        if best is not None:
            if weave_into_paragraph(doc.paragraphs[best], phrase):
                changed += 1
    return changed

# ----------------------- pipeline -----------------------
def make_change_log_item(section: str, before: str, after: str, reason: str, inserted: Optional[str] = None):
    return {
        "anchor_section": section,
        "original_paragraph_text": before,
        "modified_paragraph_text": after,
        "inserted_sentence": inserted,
        "reason": reason
    }

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
        url = item.get("url") or item.get("link") or item.get("jd_url")
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

        doc = Document(resume_path)
        changes: List[Dict[str, Any]] = []

        if inject_skills(doc, plan.get("skills_additions") or []):
            changes.append(make_change_log_item("Skills/Technical Skills", "", "", "Reordered/enriched inline skills list."))

        weave_count = apply_weaves(doc, plan.get("weaves") or [])
        if weave_count == 0:
            candidates = plan.get("skills_additions") or []
            top_phrase = canon(candidates[0]) if candidates else ""
            secs = find_section_ranges(doc, ["Work Experience","Professional Experience","Experience"])
            chosen_key = next(iter([k for k in ("work experience","professional experience","experience") if k in secs]), None)
            if chosen_key:
                s,e = secs[chosen_key]
                bullets = [(i, len(doc.paragraphs[i].text)) for i in range(s,e) if paragraph_is_bullet(doc.paragraphs[i])]
                bullets = [b for b in bullets if b[1] < 220]
                bullets.sort(key=lambda x: x[1])
                for idx,_ in bullets[:2]:
                    p = doc.paragraphs[idx]
                    before = p.text
                    if top_phrase:
                        set_text_preserve_style(p, before.rstrip().rstrip(".") + f" Using {top_phrase}.")
                        changes.append(make_change_log_item("Work Experience", before, p.text,
                                                            "Fallback appender to ensure visible tailoring.",
                                                            inserted=f"Using {top_phrase}."))

        slug = slugify(job_title or url)[:80]
        jd_txt_path = out_changes / f"{slug}.jd.txt"
        jd_txt_path.write_text(jd_text, encoding="utf-8")

        h = hashlib.sha1((url + str(time.time())).encode()).hexdigest()[:8]
        out_docx = out_resumes / f"{slug}_{h}.docx"
        doc.save(out_docx.as_posix())

        changes_path = out_changes / f"{slug}_{h}.json"
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

    index_path = out_root / "drafts_index.json"
    index_path.write_text(json.dumps(index_items, ensure_ascii=False, indent=2), encoding="utf-8")
    logging.info("Wrote index: %s", index_path)

# ----------------------- CLI -----------------------
def main():
    ap = argparse.ArgumentParser(description="Tailor resume from JD links with LLM-assisted weaving.")
    ap.add_argument("--links", required=True, help="Path to JSON or .txt containing JD links.")
    ap.add_argument("--resume", required=True, help="Path to source .docx resume.")
    ap.add_argument("--out", required=True, help="Output prefix (e.g., outputs).")
    ap.add_argument("--user", default="user", help="User id folder under output prefix.")
    args = ap.parse_args()

    run_pipeline(args.links, args.resume, args.out, uid=args.user)

if __name__ == "__main__":
    main()
