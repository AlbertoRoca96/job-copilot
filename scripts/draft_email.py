import os, sys, json, argparse, re, yaml
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
PROFILE_YAML   = os.path.join(os.path.dirname(__file__), '..', 'src', 'core', 'profile.yaml')
PORTFOLIO_YAML = os.path.join(os.path.dirname(__file__), '..', 'src', 'core', 'portfolio.yaml')
TMPL_DIR       = os.path.join(os.path.dirname(__file__), '..', 'src', 'tailor', 'templates')

# -------------------- helpers --------------------
WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]{1,}")

def tokens(text: str):
    return set(WORD_RE.findall((text or "").lower()))

def safe_name(s: str) -> str:
    return ''.join(c for c in (s or '') if c.isalnum() or c in ('-', '_')).strip()

# synonym map to match job phrasing truthfully to your known skills/tags
SYNONYMS = {
    "js": "javascript",
    "node": "node.js",
    "reactjs": "react",
    "ts": "typescript",
    "ml": "machine learning",
    "cv": "computer vision",
    "postgres": "postgresql",
    "gh actions": "github actions",
    "gh-actions": "github actions",
    "ci/cd": "ci",
    "k8s": "kubernetes",  # only allowed if you list it; default not in allowed vocab
    "llm": "machine learning",
    "rest": "rest api",
    "ops": "operations",
    "etl": "data pipeline",
}

def normalize_keyword(w: str):
    w = w.strip().lower()
    return SYNONYMS.get(w, w)

def allowed_vocab(profile: dict, portfolio: dict):
    skills = {s.lower() for s in profile.get("skills", [])}

    # collect all tags from portfolio bullets
    tagset = set()
    for section in ("projects", "work_experience", "workshops"):
        for item in portfolio.get(section, []) or []:
            for b in item.get("bullets", []) or []:
                for t in b.get("tags", []) or []:
                    tagset.add(str(t).lower())

    # also allow your target_titles as nouns (helps titles like “software engineer”)
    titles = {t.lower() for t in profile.get("target_titles", [])}

    # map synonyms of what you already know to improve matching
    expanded = set()
    for w in (skills | tagset | titles):
        expanded.add(normalize_keyword(w))
    return expanded | skills | tagset | titles

def harvest_job_keywords(job: dict, allowed: set, top_n=14):
    # take job title + description tokens; map via normalize; filter to allowed vocab only
    jtoks = tokens(job.get("title","")) | tokens(job.get("description",""))
    counts = {}
    for w in jtoks:
        nw = normalize_keyword(w)
        if nw in allowed:
            counts[nw] = counts.get(nw, 0) + 1

    # sort by freq desc, then alphabetically to stabilize
    ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return [w for (w, _) in ordered[:top_n]]

def flatten_portfolio_bullets(portfolio):
    # yields (section, ctx, text, tags_set)
    for p in portfolio.get("projects", []) or []:
        ctx = p.get("name","")
        link = p.get("link")
        if link: ctx = f"{ctx} ({link})"
        for b in p.get("bullets", []) or []:
            yield ("Projects", ctx, b.get("text",""), {normalize_keyword(t) for t in (b.get("tags",[]) or [])})
    for w in portfolio.get("work_experience", []) or []:
        ctx = f"{w.get('role','')} — {w.get('org','')} ({w.get('dates','')})"
        for b in w.get("bullets", []) or []:
            yield ("Experience", ctx, b.get("text",""), {normalize_keyword(t) for t in (b.get("tags",[]) or [])})
    for ws in portfolio.get("workshops", []) or []:
        ctx = f"{ws.get('title','')} ({ws.get('date','')})"
        for b in ws.get("bullets", []) or []:
            yield ("Workshops", ctx, b.get("text",""), {normalize_keyword(t) for t in (b.get("tags",[]) or [])})

def score_bullet(job_tokens: set, text: str, tags: set):
    # heavy weight tags (truth we already have), plus overlap with job tokens
    t_hits = len(tags & job_tokens)
    w_hits = len(tokens(text) & job_tokens)
    return 3*t_hits + w_hits

def pick_relevant_bullets(job, portfolio, top=8, per_section_cap=3):
    job_tokens_norm = {normalize_keyword(w) for w in (tokens(job.get("title","")) | tokens(job.get("description","")))}
    scored = []
    for section, ctx, text, tags in flatten_portfolio_bullets(portfolio):
        s = score_bullet(job_tokens_norm, text, tags)
        if s > 0:
            scored.append((s, section, ctx, text))
    scored.sort(key=lambda x: (-x[0], x[1]))

    chosen, used = [], {}
    for s, section, ctx, text in scored:
        if len(chosen) >= top: break
        if used.get(section, 0) >= per_section_cap: continue
        chosen.append((section, ctx, text))
        used[section] = used.get(section, 0) + 1
    return chosen

# -------------------- rendering --------------------
def render_tailored_resume_md(job: dict, profile: dict, portfolio: dict, bullets, ats_keywords):
    lines = []
    # header
    lines += [f"# {profile.get('name','')}",
              f"{profile.get('email','')}  |  {profile.get('github','')}  |  {profile.get('phone','')}",
              ""]
    # summary
    lines += [f"## Tailored Summary — {job.get('company','').title()} · {job.get('title','')}",
              "- Location: Remote (US) — based in Virginia",
              ""]
    # ATS keywords (whitelisted)
    if ats_keywords:
        lines += ["## Keyword Alignment (ATS-safe)",
                  ", ".join(ats_keywords),
                  ""]
    # selected bullets
    if bullets:
        lines += ["## Selected Achievements (relevant)", ""]
        for section, ctx, text in bullets:
            lines += [f"- **{section} · {ctx}** — {text}"]
        lines += [""]
    # education
    edu = portfolio.get('education', {})
    if edu:
        lines += ["## Education",
                  f"{edu.get('degree','')} — {edu.get('school','')} ({edu.get('dates','')})"]
        if edu.get('gpa'): lines += [f"GPA: {edu.get('gpa')}"]
        for x in edu.get('extras', []): lines += [f"- {x}"]
        lines += [""]
    lines += ["---", "_Auto-tailored; review before sending._"]
    return "\n".join(lines)

def render_tailored_resume_docx(path: str, job: dict, profile: dict, portfolio: dict, bullets, ats_keywords):
    doc = Document()

    # Header
    p = doc.add_paragraph()
    r = p.add_run(profile.get('name',''))
    r.bold = True; r.font.size = Pt(18)
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    contact = "  |  ".join([x for x in [profile.get('email',''), profile.get('github',''), profile.get('phone','')] if x])
    p = doc.add_paragraph(contact); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    doc.add_paragraph()

    # Summary
    doc.add_paragraph().add_run(f"Tailored Summary — {job.get('company','').title()} · {job.get('title','')}").bold = True
    doc.add_paragraph("• Location: Remote (US) — based in Virginia")

    # ATS keywords
    if ats_keywords:
        doc.add_paragraph()
        doc.add_paragraph().add_run("Keyword Alignment (ATS-safe)").bold = True
        doc.add_paragraph(", ".join(ats_keywords))

    # Bullets
    if bullets:
        doc.add_paragraph()
        doc.add_paragraph().add_run("Selected Achievements (relevant)").bold = True
        for section, ctx, text in bullets:
            para = doc.add_paragraph(f"{section} · {ctx} — {text}")
            para.style = doc.styles['List Bullet']

    # Education
    edu = portfolio.get('education', {})
    if edu:
        doc.add_paragraph()
        doc.add_paragraph().add_run("Education").bold = True
        doc.add_paragraph(f"{edu.get('degree','')} — {edu.get('school','')} ({edu.get('dates','')})")
        if edu.get('gpa'): doc.add_paragraph(f"GPA: {edu.get('gpa')}")
        for x in edu.get('extras', []): doc.add_paragraph(x)

    doc.save(path)

# -------------------- main --------------------
def main(top: int):
    # Load profile + portfolio
    with open(PROFILE_YAML, 'r') as f: profile = yaml.safe_load(f)
    with open(PORTFOLIO_YAML, 'r') as f: portfolio = yaml.safe_load(f)

    # Allowed vocab = only what you claim (skills + tags + titles), normalized
    vocab = allowed_vocab(profile, portfolio)

    # Load jobs
    jobs = []
    if os.path.exists(DATA_JSON):
        with open(DATA_JSON) as f: jobs = json.load(f)
    elif os.path.exists(DATA_JSONL):
        with open(DATA_JSONL) as f:
            for line in f: jobs.append(json.loads(line))
    else:
        print('No scores found; run scripts/rank.py first.'); return

    jobs.sort(key=lambda x: x.get('score', 0), reverse=True)

    os.makedirs(OUTBOX_MD, exist_ok=True)
    os.makedirs(RESUMES_MD, exist_ok=True)

    drafted_covers = drafted_resumes = 0

    for j in jobs[:top]:
        safe_company = safe_name(j.get('company',''))
        safe_title   = safe_name(j.get('title',''))

        # 1) pick ATS-safe keywords from job (intersection with your vocab)
        ats_keywords = harvest_job_keywords(j, vocab, top_n=14)

        # 2) choose portfolio bullets most relevant to this job
        chosen_bullets = pick_relevant_bullets(j, portfolio, top=8, per_section_cap=3)

        # 3) COVER — render + append ATS keywords section
        cover_fname = f"{safe_company}_{safe_title}.md"[:150]
        cover_body = render_cover(j, PROFILE_YAML, TMPL_DIR)
        if ats_keywords:
            cover_body += "\n\n---\n**Keyword Alignment (ATS-safe):** " + ", ".join(ats_keywords) + "\n"
        with open(os.path.join(OUTBOX_MD, cover_fname), 'w') as f: f.write(cover_body)
        j['cover_file'] = cover_fname
        j['cover_path'] = f"outbox/{cover_fname}"
        drafted_covers += 1

        # 4) RESUME (MD + DOCX)
        res_md_fname = f"{safe_company}_{safe_title}.md"[:150]
        md_text = render_tailored_resume_md(j, profile, portfolio, chosen_bullets, ats_keywords)
        with open(os.path.join(RESUMES_MD, res_md_fname), 'w') as f: f.write(md_text)

        res_docx_fname = f"{safe_company}_{safe_title}.docx"[:150]
        render_tailored_resume_docx(os.path.join(RESUMES_MD, res_docx_fname), j, profile, portfolio, chosen_bullets, ats_keywords)

        j['resume_md'] = f"resumes/{res_md_fname}"
        j['resume_docx'] = f"resumes/{res_docx_fname}"
        drafted_resumes += 1

    # Write back for dashboard
    os.makedirs(os.path.dirname(DATA_JSON), exist_ok=True)
    with open(DATA_JSON, 'w') as f: json.dump(jobs, f, indent=2)

    print(f"Drafted {drafted_covers} cover letters -> {OUTBOX_MD}")
    print(f"Drafted {drafted_resumes} tailored resumes -> {RESUMES_MD}")

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--top', type=int, default=5)
    args = ap.parse_args()
    main(args.top)
