import os, sys, json, argparse, re, yaml, math
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
PORTFOLIO_YAML = os.path.join(os.path.dirname(__file__), '..', 'src', 'core', 'portfolio.yaml')
TMPL_DIR   = os.path.join(os.path.dirname(__file__), '..', 'src', 'tailor', 'templates')

# ---------- helpers ----------
def safe_name(s: str) -> str:
    return ''.join(c for c in (s or '') if c.isalnum() or c in ('-', '_')).strip()

def tokenize(text: str):
    return set(re.findall(r"[A-Za-z][A-Za-z0-9+.-]{1,}", (text or '').lower()))

def score_bullet(bullet_text: str, bullet_tags, job_tokens):
    # score by tag intersection + token overlap
    tags = set((bullet_tags or []))
    tscore = len(tags & job_tokens)  # tag hits
    w_overlap = len(tokenize(bullet_text) & job_tokens)
    return 3*tscore + w_overlap  # tag matches weigh more

def flatten_bullets(portfolio):
    """Yield (section, context, bullet_text, tags) from projects/workshops/work_experience."""
    # projects
    for p in portfolio.get('projects', []):
        ctx = p.get('name', '')
        link = p.get('link')
        ctx_full = f"{ctx}" + (f" ({link})" if link else "")
        for b in p.get('bullets', []):
            yield ("Projects", ctx_full, b.get('text',''), set(map(str.lower, b.get('tags',[]))))
    # work
    for w in portfolio.get('work_experience', []):
        ctx = f"{w.get('role','')} — {w.get('org','')} ({w.get('dates','')})"
        for b in w.get('bullets', []):
            yield ("Experience", ctx, b.get('text',''), set(map(str.lower, b.get('tags',[]))))
    # workshops
    for ws in portfolio.get('workshops', []):
        ctx = f"{ws.get('title','')} ({ws.get('date','')})"
        for b in ws.get('bullets', []):
            yield ("Workshops", ctx, b.get('text',''), set(map(str.lower, b.get('tags',[]))))

def pick_relevant_bullets(job, portfolio, max_total=8, per_section_cap=3):
    job_tokens = tokenize(job.get('title','')) | tokenize(job.get('description',''))
    scored = []
    for section, ctx, text, tags in flatten_bullets(portfolio):
        scored.append((score_bullet(text, tags, job_tokens), section, ctx, text))
    # sort by score desc, then stable by section
    scored.sort(key=lambda x: x[0], reverse=True)

    chosen = []
    per_section_count = {}
    for sc, section, ctx, text in scored:
        if sc == 0:  # skip unrelated
            continue
        if len(chosen) >= max_total:
            break
        if per_section_count.get(section, 0) >= per_section_cap:
            continue
        chosen.append((section, ctx, text))
        per_section_count[section] = per_section_count.get(section, 0) + 1
    return chosen

def render_tailored_resume_md(job: dict, profile: dict, portfolio: dict, bullets):
    lines = []
    # header
    lines += [f"# {profile.get('name','')}",
              f"{profile.get('email','')}  |  {profile.get('github','')}  |  {profile.get('phone','')}",
              ""]
    # summary
    lines += [f"## Tailored Summary — {job.get('company','').title()} · {job.get('title','')}",
              "- Location: Remote (US) — based in Virginia",
              ""]
    # selected bullets
    if bullets:
        lines += ["## Selected Achievements (most relevant)", ""]
        for section, ctx, text in bullets:
            lines += [f"- **{section} · {ctx}** — {text}"]
        lines += [""]
    # skills teaser
    lines += ["## Skills (selected)",
              ", ".join(sorted(list(tokenize(job.get('description',''))) & set(map(str.lower, profile.get('skills', []))))[:14]) or ", ".join(profile.get('skills', [])[:14]),
              ""]
    # education
    edu = portfolio.get('education', {})
    if edu:
        lines += ["## Education",
                  f"{edu.get('degree','')} — {edu.get('school','')} ({edu.get('dates','')})"]
        if edu.get('gpa'): lines += [f"GPA: {edu.get('gpa')}"]
        for x in edu.get('extras', []): lines += [f"- {x}"]
        lines += [""]
    # footer note
    lines += ["---", "_Auto-tailored resume generated for this posting; please review before sending._"]
    return "\n".join(lines)

def render_tailored_resume_docx(path: str, job: dict, profile: dict, portfolio: dict, bullets):
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
    doc.add_paragraph().add_run(f"Tailored Summary — {job.get('company','').title()} · {job.get('title','')}").bold = True
    doc.add_paragraph("• Location: Remote (US) — based in Virginia")

    # Selected achievements
    if bullets:
        doc.add_paragraph()
        doc.add_paragraph().add_run("Selected Achievements (most relevant)").bold = True
        for section, ctx, text in bullets:
            doc.add_paragraph(f"{section} · {ctx} — {text}", style=None).style = doc.styles['List Bullet']

    # Education
    edu = portfolio.get('education', {})
    if edu:
        doc.add_paragraph()
        doc.add_paragraph().add_run("Education").bold = True
        edu_line = f"{edu.get('degree','')} — {edu.get('school','')} ({edu.get('dates','')})"
        doc.add_paragraph(edu_line)
        if edu.get('gpa'):
            doc.add_paragraph(f"GPA: {edu.get('gpa')}")
        for x in edu.get('extras', []):
            doc.add_paragraph(x)

    doc.save(path)

# ---------- main ----------
def main(top: int):
    # Load profile + portfolio
    with open(PROFILE_YAML, 'r') as f:
        profile = yaml.safe_load(f)
    with open(PORTFOLIO_YAML, 'r') as f:
        portfolio = yaml.safe_load(f)

    # Load jobs
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

    for j in jobs[:top]:
        safe_company = safe_name(j.get('company',''))
        safe_title   = safe_name(j.get('title',''))

        # COVER
        cover_fname = f"{safe_company}_{safe_title}.md"[:150]
        cover_body = render_cover(j, PROFILE_YAML, TMPL_DIR)
        with open(os.path.join(OUTBOX_MD, cover_fname), 'w') as f:
            f.write(cover_body)
        j['cover_file'] = cover_fname
        j['cover_path'] = f"outbox/{cover_fname}"
        drafted_covers += 1

        # PORTFOLIO bullets
        chosen_bullets = pick_relevant_bullets(j, portfolio, max_total=8, per_section_cap=3)

        # RESUME (MD)
        res_md_fname = f"{safe_company}_{safe_title}.md"[:150]
        md_text = render_tailored_resume_md(j, profile, portfolio, chosen_bullets)
        with open(os.path.join(RESUMES_MD, res_md_fname), 'w') as f:
            f.write(md_text)

        # RESUME (DOCX)
        res_docx_fname = f"{safe_company}_{safe_title}.docx"[:150]
        render_tailored_resume_docx(os.path.join(RESUMES_MD, res_docx_fname), j, profile, portfolio, chosen_bullets)

        j['resume_md'] = f"resumes/{res_md_fname}"
        j['resume_docx'] = f"resumes/{res_docx_fname}"
        drafted_resumes += 1

    # Write back to dashboard JSON
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
