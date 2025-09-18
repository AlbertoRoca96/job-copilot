// docs/site.js
(async function () {
  const dataUrl = 'data/scores.json';
  const res = await fetch(dataUrl, { cache: 'no-cache' });
  const jobs = await res.json();

  const list = document.getElementById('jobs');
  if (!list) return;

  function el(tag, attrs = {}, text = '') {
    const e = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
    if (text) e.textContent = text;
    return e;
  }

  jobs.sort((a, b) => (b.score || 0) - (a.score || 0));

  for (const j of jobs) {
    const card = el('div', { class: 'card' });
    const h = el('h3', {}, `${j.title} @ ${j.company}`);
    card.appendChild(h);

    const p = el('p', { class: 'muted' }, (j.location || '').trim());
    card.appendChild(p);

    const links = el('div', { class: 'actions' });
    if (j.url) {
      const a = el('a', { href: j.url, target: '_blank', rel: 'noopener' }, 'JD');
      links.appendChild(a);
    }
    if (j.cover_path) {
      const a = el('a', { href: j.cover_path, target: '_blank', rel: 'noopener' }, 'Cover');
      links.appendChild(a);
    }
    if (j.resume_docx) {
      const hash = j.resume_docx_hash ? `?v=${j.resume_docx_hash}` : `?t=${Date.now()}`;
      const a = el('a', { href: j.resume_docx + hash }, 'Resume (DOCX)');
      links.appendChild(a);
    }
    if (j.changes_path) {
      const a = el('a', { href: j.changes_path, target: '_blank', rel: 'noopener' }, 'Explain');
      links.appendChild(a);
    }
    card.appendChild(links);

    if (Array.isArray(j.ats_keywords) && j.ats_keywords.length) {
      const tagwrap = el('div', { class: 'tags' });
      j.ats_keywords.slice(0, 16).forEach(k => {
        tagwrap.appendChild(el('span', { class: 'tag' }, k));
      });
      card.appendChild(tagwrap);
    }

    list.appendChild(card);
  }
})();
