# src/tailor/render.py
import yaml
from jinja2 import Environment, FileSystemLoader, select_autoescape

def render_cover(job: dict, profile_path: str, templates_dir: str, jd_keywords=None):
    """
    Renders a concise, domain-agnostic cover letter.
    Passes JD keywords so the template can highlight 2–4 aligned skills
    without hardcoding any single profession.
    """
    env = Environment(
        loader=FileSystemLoader(templates_dir),
        autoescape=select_autoescape(disabled_extensions=('md',))
    )
    with open(profile_path, 'r') as f:
        profile = yaml.safe_load(f) or {}
    tmpl = env.get_template('cover_letter.md.j2')
    return tmpl.render(job=job, profile=profile, jd_keywords=(jd_keywords or []))
