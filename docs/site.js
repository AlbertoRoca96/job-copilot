// docs/site.js
(async function () {
  const loadingEl = document.getElementById('loading');
  const errorEl = document.getElementById('error');
  const list = document.getElementById('jobs');

  function doneLoading() {
    if (loadingEl) loadingEl.style.display = 'none';
  }
  function showError(msg) {
    console.error('[job-copilot] ', msg);
    if (errorEl) {
      errorEl.textContent = String(msg);
      errorEl.style.display = 'block';
    } else {
      alert(msg);
    }
  }
  function el(tag, attrs = {}, text = '') {
    const e = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => e.setAttribute(k, v));
    if (text) e.textContent = text;
    return e;
  }

  try {
    if (!list) {
      throw new Error('Missing #jobs container in index.html');
    }

    // Fetch with explicit no-cache; GitHub Pages can cache aggressively.
    const res = await fetch('data/scores.json', { cache: 'no-cache' });
    if (!res.ok) {
      throw new Error(`Failed to fetch data/scores.json (HTTP ${res.status})`);
    }
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json') && !contentType.includes('text/json')) {
      console.warn('scores.json content-type:', contentType);
    }

    const jobs = await res.json();
    if (!Array.isArray(jobs)) {
      throw new Error('scores.json is not an array. Did the workflow write the new format?');
    }

    // Sort and render
    jobs.sort((a, b) => (b.score || 0) - (a.score || 0));

    for (const j of jobs) {
      const card = el('div', { class: 'card' });

      const title = (j.title || '').trim();
      const company = (j.company || '').trim();
      const h = el('h3', {}, title && company ? `${title} @ ${company}` : (title || company || 'Untitled role'));
      card.appendChild(h);

      const loc = (j.location || '').trim();
      if (loc) card.appendChild(el('p', { class: 'muted' }, loc));

      const links = el('div', { class: 'actions' });

      if (j.url) {
        links.appendChild(el('a', { href: j.url, target: '_blank', rel: 'noopener' }, 'JD'));
      }
      if (j.cover_path) {
        links.appendChild(el('a', { href: j.cover_path, target: '_blank', rel: 'noopener' }, 'Cover'));
      }
      if (j.resume_docx) {
        const hash = j.resume_docx_hash ? `?v=${j.resume_docx_hash}` : `?t=${Date.now()}`;
        links.appendChild(el('a', { href: j.resume_docx + hash }, 'Resume (DOCX)'));
      }
      if (j.changes_path) {
        links.appendChild(el('a', { href: j.changes_path, target: '_blank', rel: 'noopener' }, 'Explain'));
      }
      card.appendChild(links);

      const kws = Array.isArray(j.ats_keywords) ? j.ats_keywords : [];
      if (kws.length) {
        const tagwrap = el('div', { class: 'tags' });
        kws.slice(0, 18).forEach(k => tagwrap.appendChild(el('span', { class: 'tag' }, k)));
        card.appendChild(tagwrap);
      }

      list.appendChild(card);
    }

    if (!jobs.length) {
      list.appendChild(el('div', { class: 'notice' }, 'No jobs found. Run the workflows (crawl → rank → draft-covers) to populate this list.'));
    }
  } catch (err) {
    showError(err.message || err);
  } finally {
    doneLoading();
  }
})();
