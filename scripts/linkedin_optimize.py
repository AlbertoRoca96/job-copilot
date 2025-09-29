# scripts/linkedin_optimize.py
"""
LinkedIn Optimizer: analyze a LinkedIn PDF export, detect section gaps, and
prioritize edits using your existing scoring tokens/logic.

Outputs:
  docs/outbox/linkedin_report.json
  docs/outbox/linkedin_report.md

Usage:
  python scripts/linkedin_optimize.py --pdf ~/Downloads/linkedin.pdf --user <supabase_user_uuid>

If you don't want to hit Supabase for profile:
  python scripts/linkedin_optimize.py --pdf linkedin.pdf --profile path/to/profile.json
"""

import os, sys, re, json, argparse, requests
from datetime import datetime
from typing import Dict, List, Tuple

# repo-relative imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
try:
    from src.core.scoring import tokenize as py_tokenize, tokens_from_terms as py_tokens_from_terms
except Exception:
    # light fallback if src not importable
    def _canon(s: str) -> str:
        s = s.lower()
        s = s.replace('/', ' ')
        return s
    def py_tokenize(text: str):
        text = (text or "").lower().replace("/", " ")
        toks = set(re.findall(r"[a-z][a-z0-9+.-]{1,}", text))
        extra = set()
        for t in toks:
            extra.add(t)
            if "-" in t:
                extra.update(t.split("-"))
                extra.add(t.replace("-", ""))
        return toks | extra
    def py_tokens_from_terms(terms):
        out = set()
        if not terms: return out
        if not isinstance(terms, (list, tuple, set)): terms = [terms]
        for t in terms:
            out |= py_tokenize(str(t))
        return out

try:
    from pdfminer.high_level import extract_text  # type: ignore
except Exception as e:
    raise SystemExit("Install pdfminer.six: pip install pdfminer.six")  # doc: https://github.com/pdfminer/pdfminer.six

SUPABASE_URL = os.environ.get("SUPABASE_URL","").rstrip("/")
SRK          = os.environ.get("SUPABASE_SERVICE_ROLE_KEY","")

OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'docs', 'outbox')
os.makedirs(OUT_DIR, exist_ok=True)

SECTION_HEADS = [
    "about", "experience", "work experience", "education", "skills",
    "licenses & certifications", "certifications", "projects",
    "volunteer experience", "publications", "honors & awards"
]

def load_profile(user_id: str | None, profile_path: str | None) -> Dict:
    if profile_path:
        with open(profile_path) as f: return json.load(f)
    if user_id and SUPABASE_URL and SRK:
        url = f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{user_id}&select=*"
        r = requests.get(url, headers={"apikey": SRK, "Authorization": f"Bearer {SRK}"}, timeout=30)
        r.raise_for_status()
        arr = r.json() or []
        if arr: return arr[0]
    return {}

def split_sections(text: str) -> Dict[str, str]:
    """Very simple LinkedIn-PDF section splitter using headings."""
    lines = [l.strip() for l in text.splitlines()]
    sections: Dict[str, List[str]] = {}
    cur = "_top"
    sections[cur] = []
    for l in lines:
        ll = l.strip().lower()
        if ll in SECTION_HEADS or re.match(r"^(skills|experience|education|about)$", ll):
            cur = ll
            if cur not in sections: sections[cur] = []
            continue
        sections.setdefault(cur, []).append(l)
    return {k: "\n".join(v).strip() for k,v in sections.items() if v}

def quantify_ratio(s: str) -> float:
    """Return fraction of lines that contain a number (rough quant signals)."""
    lines = [l for l in s.splitlines() if l.strip()]
    if not lines: return 0.0
    hits = sum(1 for l in lines if re.search(r"\b\d+([.,]\d+)?\b", l))
    return round(hits / max(1, len(lines)), 3)

def find_missing_keywords(section_text: str, want_tokens: set[str]) -> List[str]:
    seen = py_tokenize(section_text or "")
    missing = [t for t in want_tokens if t not in seen]
    # keep stable order by alpha for determinism
    return sorted(list(set(missing)))

def analyze(pdf_path: str, profile: Dict) -> Dict:
    raw = extract_text(pdf_path)  # docs: extract_text(path) -> str
    sections = split_sections(raw)

    skills_want = py_tokens_from_terms(profile.get("skills"))
    titles_want = py_tokens_from_terms(profile.get("target_titles"))

    about = sections.get("about","")
    experience = sections.get("experience","") or sections.get("work experience","")
    education = sections.get("education","")
    skills_s  = sections.get("skills","")

    # coverage
    missing_in_about  = find_missing_keywords(about, skills_want)
    missing_in_exp    = find_missing_keywords(experience, skills_want)
    title_hits_in_headline = list(py_tokens_from_terms([profile.get("headline")]) & titles_want) if profile.get("headline") else []
    q_about = quantify_ratio(about)
    q_exp   = quantify_ratio(experience)

    suggestions: List[str] = []

    if missing_in_about[:8]:
        suggestions.append(
            f"Add these keywords to **About** where truthful: {', '.join(missing_in_about[:8])}."
        )
    if q_about < 0.2:
        suggestions.append("About section lacks metrics. Add 2–3 quantified outcomes (%, time saved, revenue).")
    if missing_in_exp[:8]:
        suggestions.append(
            f"Thread missing keywords into **Experience** bullets (truthful & specific): {', '.join(missing_in_exp[:8])}."
        )
    if q_exp < 0.35:
        suggestions.append("Experience bullets need more numbers. Aim for ~1 in 3 bullets to include a metric.")
    if not title_hits_in_headline and titles_want:
        suggestions.append("Align your headline to target titles (include one keyword you’re aiming for).")

    return {
        "meta": {
            "pdf_path": pdf_path,
            "generated_at": datetime.utcnow().isoformat() + "Z"
        },
        "coverage": {
            "missing_in_about": missing_in_about,
            "missing_in_experience": missing_in_exp,
            "title_hits_in_headline": title_hits_in_headline
        },
        "quantification": {
            "about_ratio_numeric_lines": q_about,
            "experience_ratio_numeric_lines": q_exp
        },
        "sections_detected": list(sections.keys()),
        "suggestions": suggestions
    }

def write_outputs(report: Dict):
    json_path = os.path.join(OUT_DIR, "linkedin_report.json")
    md_path   = os.path.join(OUT_DIR, "linkedin_report.md")
    with open(json_path, "w") as f:
        json.dump(report, f, indent=2)
    with open(md_path, "w") as f:
        s = report["suggestions"]
        cov = report["coverage"]
        quant = report["quantification"]
        f.write("# LinkedIn Optimization Report\n\n")
        f.write(f"_Generated: {report['meta']['generated_at']}_\n\n")
        f.write("## Top Suggestions\n")
        for i, line in enumerate(s, 1):
            f.write(f"{i}. {line}\n")
        f.write("\n## Coverage\n")
        f.write(f"- Missing in About (top): {', '.join(cov['missing_in_about'][:12]) or 'none'}\n")
        f.write(f"- Missing in Experience (top): {', '.join(cov['missing_in_experience'][:12]) or 'none'}\n")
        f.write(f"- Title hits in headline: {', '.join(cov['title_hits_in_headline']) or 'none'}\n")
        f.write("\n## Quantification (numeric lines ratio)\n")
        f.write(f"- About: {quant['about_ratio_numeric_lines']}\n")
        f.write(f"- Experience: {quant['experience_ratio_numeric_lines']}\n")
    print(f"Wrote {json_path} and {md_path}")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True, help="Path to LinkedIn PDF export")
    ap.add_argument("--user", help="Supabase user id (fetch profile via REST)")
    ap.add_argument("--profile", help="Optional path to local profile.json")
    args = ap.parse_args()

    profile = load_profile(args.user, args.profile)
    report = analyze(args.pdf, profile)
    write_outputs(report)

if __name__ == "__main__":
    main()
