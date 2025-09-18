function safe(s) {
  return (s || '').replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 150);
}
async function exists(path) {
  try { const r = await fetch(path, { method: 'HEAD', cache: 'no-store' }); return r.ok; }
  catch { return false; }
}
function el(tag, html) {
  const n = document.createElement(tag); if (html !== undefined) n.innerHTML = html; return n;
}

(function(){
  const status = document.getElementById('status');
  const table  = document.getElementById('jobs');
  const tbody  = table.querySelector('tbody');

  // Modal wiring
  const modal   = document.getElementById('explainModal');
  const mTitle  = document.getElementById('explainTitle');
  const mKeywords = document.getElementById('explainKeywords');
  const mChanges  = document.getElementById('explainChanges');
  const mClose  = document.getElementById('closeExplain');

  function openModal() {
    modal.style.display = 'block';
    document.body.classList.add('modal-open');
  }
  function closeModal() {
    modal.style.display = 'none';
    document.body.classList.remove('modal-open');
  }
  mClose.onclick = closeModal;
  modal.onclick = (e) => { if (e.target === modal) closeModal(); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal.style.display === 'block') closeModal(); });

  async function load() {
    const res = await fetch('./data/scores.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('No scores yet. Run the crawl-and-rank workflow.');
    const data = await res.json();

    tbody.innerHTML = '';
    for (const j of data) {
      const tr = document.createElement('tr');

      // Cover link
      const coverGuess = 'outbox/' + (j.cover_file || (safe(j.company) + '_' + safe(j.title) + '.md'));
      const coverLink = j.cover_path || (await exists(coverGuess) ? coverGuess : null);

      // Resume link
      const resumeDocx = j.resume_docx || ('resumes/' + safe(j.company) + '_' + safe(j.title) + '.docx');
      let resumeLinkHtml = '<em>—</em>';
      if (await exists(resumeDocx)) resumeLinkHtml = `<a href="${resumeDocx}" download>docx</a>`;

      // Explain button
      const explainPath = j.changes_path || ('changes/' + safe(j.company) + '_' + safe(j.title) + '.json');
      const explainBtn = `<button class="btn" data-explain="${explainPath}" data-title="${j.title} @ ${j.company}">Explain</button>`;

      tr.innerHTML = `
        <td>${(j.score ?? 0).toFixed(3)}</td>
        <td><a href="${j.url}" target="_blank" rel="noopener">${j.title}</a></td>
        <td>${j.company}</td>
        <td>${j.location || ''}</td>
        <td>${coverLink ? `<a href="${coverLink}" target="_blank" rel="noopener">cover</a>` : '<em>—</em>'}</td>
        <td>${resumeLinkHtml}</td>
        <td>${explainBtn}</td>
      `;
      tbody.appendChild(tr);
    }

    // Explain handlers
    tbody.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-explain]');
      if (!btn) return;
      const path = btn.getAttribute('data-explain');
      const title = btn.getAttribute('data-title');

      try {
        const r = await fetch(path, { cache: 'no-store' });
        if (!r.ok) throw new Error('No change log for this job yet.');
        const payload = await r.json();

        mTitle.textContent = title;
        const kw = (payload.ats_keywords || []).map(k => `<span class="pill">${k}</span>`).join(' ');
        mKeywords.innerHTML = `<h4>ATS keywords used</h4>${kw || '<em>None</em>'}`;

        const changes = payload.changes || [];
        mChanges.innerHTML = '<h4>Edits</h4>';
        if (!changes.length) {
          mChanges.innerHTML += '<p><em>No textual edits were needed. Resume already aligned.</em></p>';
        } else {
          for (const c of changes) {
            const row = el('div'); row.className = 'diffrow';
            const left  = el('div', `<strong>${c.section} — before</strong><div class="diffcol">${c.before}</div>`);
            const right = el('div', `<strong>${c.section} — after</strong><div class="diffcol">${c.after}</div><div style="margin-top:6px;font-size:12px;color:#666;">Reason: ${c.reason}</div>`);
            row.appendChild(left); row.appendChild(right);
            mChanges.appendChild(row);
          }
        }

        openModal();
      } catch (err) {
        mTitle.textContent = title;
        mKeywords.innerHTML = '';
        mChanges.innerHTML = `<p>${err.message || 'Failed to load explanation.'}</p>`;
        openModal();
      }
    });

    status.textContent = `${data.length} jobs loaded.`;
    table.classList.remove('hidden');
  }

  load().catch(e => { status.textContent = e.message || 'Failed to load data.'; });
})();
