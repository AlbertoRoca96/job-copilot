import os, sys, json, argparse, re
# --- Make src/ importable when run from Actions or locally ---
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from src.tailor.render import render_cover
from docx import Document
from docx.shared import Pt
from docx.enum.text import WD_ALIGN_PARAGRAPH

DATA_JSONL = os.path.join(os.path.dirname(__file__), '..', 'data', 'scores.jsonl')
DATA_JSON  = os.path.join(os.path.dirname(__file__), '..', 'docs', 'data', 'scores.json')
OUTBOX_MD  = os.path.join(os.path.dirname(__file__), '..', 'docs', 'outbox')
RESUMES_MD = os.path.join(os.path.dirname(__file__), '..', 'docs', 'resumes')
PROFILE_YAML = os.path.join(os.path.dirname(__file__), '..', 'src', 'core', 'profile.yaml')
TMPL_DIR   = os.path.join(os.path.dirname(__file__), '..', 'src', 'tailor', 'templates')
BASE_RESUME_DOCX = os.path.join(os.path.dirname(__file__), '..', 'assets', 'Resume-2025.docx')

import yaml

def safe_name(s: str) -> str:
    return ''.join(c for c in (s or '') if c.isalnum() or c in ('-', '_')).strip()

def tokenize(text: str):
    return set(re.findall(r"[A-Za-z][A-Za-z0-9+.-]{1,}", (text or '').lower()))

def pick_keywords(job: dict, profile: dict, max_items=10):
    desc = job.get('description','')
    tokens = tokenize(desc) | tokenize(job.get('title',''))
    skills = [s.lower() for s in profile.get('skills', [])]
    matched = [s for s in skills if s in tokens]
    rest = [s for s in skills if s not in set(matched)]
    ordered = matched + rest
    return [k for k in ordered[:max_items]]

def render_tailored_resume_md(job: dict, profile: dict, picked_skills: list):
    lines = []
    lines += [f"# {profile.get('name','')}",
              f"{profile.get('email','')}  |  {profile.get('github','')}  |  {profile.get('phone','')}",
              ""]
    lines += [f"## Tailored Summary — {job.get('company','').title()} · {job.get('title','')}",
              "- Match highlights: " + ", ".join(picked_skills[:6]) if picked_skills else "- Match highlights: (keywords from posting)",
              "- Location: Remote (US) — based in Virginia",
              ""]
    lines += ["## Skills (prioritized for this role)",
              ", ".join(picked_skills),
              ""]
    lines += ["## Notes",
              "- This resume was auto-tailored from your base resume for this specific posting.",
              "- Review & tweak before sending.",
              ""]
    return "\n".join(lines)

def render_tailored_resume_docx(path: str, job: dict, profile: dict, picked_skills: list):
    # Build a docx from scratch with a clean header + tailored section, then append base resume text as a note.
    doc = Document()

    # Header: Name
    p = doc.add_paragraph()
    r = p.add_run(profile.get('name',''))
    r.bold = True
    r.font.size = Pt(18)
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER

    # Header: contact
    contact = "  |  ".join([x for x in [profile.get('email',''), profile.get('github',''), profile.get('phone','')] if x])
    p = doc.add_paragraph(contact)
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER

    doc.add_paragraph()  # spacer

    # Tailored Summary
    h = doc.add_paragraph()
    h.add_run(f"Tailored Summary — {job.get('company','').title()} · {job.get('title','')}").bold = True

    doc.add_paragraph("• Match highlights: " + (", ".join(picked_skills[:6]) if picked_skills else "(keywords from posting)"))
    doc.add_paragraph("• Location: Remote (US) — based in Virginia")

    # Skills
    doc.add_paragraph()
    doc.add_paragraph().add_run("Skills (prioritized for this role)").bold = True
    doc.add_paragraph(", ".join(picked_skills) or "(see base resume)")

    # Separator + base resume note
    doc.add_paragraph()
    doc.add_paragraph().add_run("Base Resume").bold = True
    doc.add_paragraph("This tailored version is generated from your base resume. Attach either this file or the original depending on the application form, and consider merging content manually for best formatting.")

    # Save
    doc.save(path)

def main(top: int):
    # Load profile
    with open(PROFILE_YAML, 'r') as f:
        profile = yaml.safe_load(f)

    # Load jobs (prefer dashboard JSON)
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

    jobs.sort(key=lambda x: x.get('score', 0), reverse=True)

    os.makedirs(OUTBOX_MD, exist_ok=True)
    os.makedirs(RESUMES_MD, exist_ok=True)

    drafted_covers = 0
    drafted_resumes = 0

    # Generate materials for top N
    for j in jobs[:top]:
        safe_company = safe_name(j.get('company',''))
        safe_title   = safe_name(j.get('title',''))

        # --- Cover note (MD) ---
        cover_fname = f"{safe_company}_{safe_title}.md"[:150]
        body = render_cover(j, PROFILE_YAML, TMPL_DIR)
        with open(os.path.join(OUTBOX_MD, cover_fname), 'w') as f:
            f.write(body)
        j['cover_file'] = cover_fname
        j['cover_path'] = f"outbox/{cover_fname}"
        drafted_covers += 1

        # --- Tailored resume (MD + DOCX) ---
        picked = pick_keywords(j, profile, max_items=14)
        res_md_fname = f"{safe_company}_{safe_title}.md"[:150]
        res_docx_fname = f"{safe_company}_{safe_title}.docx"[:150]

        # MD resume
        md_text = render_tailored_resume_md(j, profile, picked)
        with open(os.path.join(RESUMES_MD, res_md_fname), 'w') as f:
            f.write(md_text)

        # DOCX resume
        render_tailored_resume_docx(os.path.join(RESUMES_MD, res_docx_fname), j, profile, picked)

        j['resume_md'] = f"resumes/{res_md_fname}"
        j['resume_docx'] = f"resumes/{res_docx_fname}"
        drafted_resumes += 1

    # Write back updated scores for the dashboard
    os.makedirs(os.path.dirname(DATA_JSON), exist_ok=True)
    with open(DATA_JSON, 'w') as f:
        json.dump(jobs, f, indent=2)

    print(f"Drafted {drafted_covers} cover letters -> {OUTBOX_MD}")
    print(f"Drafted {drafted_resumes} tailored resumes -> {RESUMES_MD}")

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--top', type=int, default=5)
    args = ap.parse_args()
    main(args.top)
