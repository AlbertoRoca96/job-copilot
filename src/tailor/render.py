import yaml
from jinja2 import Environment, FileSystemLoader, select_autoescape

def render_cover(job: dict, profile_path: str, templates_dir: str):
    env = Environment(
        loader=FileSystemLoader(templates_dir),
        autoescape=select_autoescape(disabled_extensions=('md',))
    )
    with open(profile_path, 'r') as f:
        profile = yaml.safe_load(f)
    tmpl = env.get_template('cover_letter.md.j2')
    return tmpl.render(job=job, profile=profile)
