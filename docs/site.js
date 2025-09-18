function safe(s) {
  return (s || '').replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 150);
}

async function exists(path) {
  try {
    const res = await fetch(path, { method: 'HEAD', cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

(async function(){
  const status = document.getElementById('status');
  const table = document.getElementById('jobs');
  const tbody = table.querySelector('tbody');

  try {
    const res = await fetch('./data/scores.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('No scores yet. Run the crawl-and-rank workflow.');
    const data = await res.json();

    tbody.innerHTML = '';
    for (const j of data) {
      const tr = document.createElement('tr');

      // Cover link (prefer explicit, else guess)
      const coverGuess = 'outbox/' + (j.cover_file || (safe(j.company) + '_' + safe(j.title) + '.md'));
      const coverLink = (j.cover_path || (await exists(coverGuess) ? coverGuess : null));

      // Resume link (prefer explicit DOCX, else guess)
      const resumeDocx = j.resume_docx || ('resumes/' + safe(j.company) + '_' + safe(j.title) + '.docx');
      const resumeMd   = j.resume_md   || ('resumes/' + safe(j.company) + '_' + safe(j.title) + '.md');
      let resumeLinkHtml = '<em>—</em>';
      if (await exists(resumeDocx)) {
        resumeLinkHtml = `<a href="${resumeDocx}" download>docx</a>`;
      } else if (await exists(resumeMd)) {
        resumeLinkHtml = `<a href="${resumeMd}" target="_blank" rel="noopener">md</a>`;
      }

      tr.innerHTML = `
        <td>${(j.score ?? 0).toFixed(3)}</td>
        <td><a href="${j.url}" target="_blank" rel="noopener">${j.title}</a></td>
        <td>${j.company}</td>
        <td>${j.location || ''}</td>
        <td>${coverLink ? `<a href="${coverLink}" target="_blank" rel="noopener">cover</a>` : '<em>—</em>'}</td>
        <td>${resumeLinkHtml}</td>
      `;
      tbody.appendChild(tr);
    }

    status.textContent = `${data.length} jobs loaded.`;
    table.classList.remove('hidden');
  } catch (e) {
    status.textContent = e.message || 'Failed to load data.';
  }
})();
