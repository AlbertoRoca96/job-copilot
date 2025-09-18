// Classic table renderer + scrollable Explain modal (+ Posted column + cache-busted resumes)
(async function () {
  const statusEl = document.getElementById('status');
  const table = document.getElementById('jobs');
  const tbody = table ? table.querySelector('tbody') : null;

  function showStatus(msg) { if (statusEl) statusEl.textContent = msg; }
  function hideStatus() { if (statusEl) statusEl.classList.add('hidden'); }
  function showTable() { if (table) table.classList.remove('hidden'); }

  // Fetch shortlist
  let jobs = [];
  try {
    const res = await fetch('data/scores.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    jobs = await res.json();
  } catch (e) {
    showStatus('Failed to load scores.json');
    console.error(e);
    return;
  }

  // Sort by score desc
  jobs.sort((a, b) => (b.score || 0) - (a.score || 0));

  // If header exists and has no "Posted" column, try to insert one
  try {
    const theadRow = table?.querySelector('thead tr');
    if (theadRow && theadRow.children.length === 7) {
      const th = document.createElement('th');
      th.textContent = 'Posted';
      // Insert after "Location" (index 3)
      theadRow.insertBefore(th, theadRow.children[4]);
    }
  } catch {}

  // Render rows
  if (tbody) {
    jobs.forEach(j => {
      const tr = document.createElement('tr');

      const tdScore = document.createElement('td');
      tdScore.textContent = (j.score ?? 0).toFixed(3);
      tr.appendChild(tdScore);

      const tdTitle = document.createElement('td');
      const aJD = document.createElement('a');
      aJD.href = j.url || '#';
      aJD.target = '_blank';
      aJD.rel = 'noopener';
      aJD.textContent = j.title || '(no title)';
      tdTitle.appendChild(aJD);
      tr.appendChild(tdTitle);

      const tdCompany = document.createElement('td');
      tdCompany.textContent = j.company || '';
      tr.appendChild(tdCompany);

      const tdLoc = document.createElement('td');
      tdLoc.textContent = (j.location || '').trim();
      tr.appendChild(tdLoc);

      // NEW: Posted date column (YYYY-MM-DD if available)
      const tdPosted = document.createElement('td');
      tdPosted.textContent = j.posted_at ? String(j.posted_at).slice(0, 10) : '—';
      tr.appendChild(tdPosted);

      const tdCover = document.createElement('td');
      if (j.cover_path) {
        const a = document.createElement('a');
        a.href = j.cover_path;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'Open';
        tdCover.appendChild(a);
      } else {
        tdCover.textContent = '—';
      }
      tr.appendChild(tdCover);

      const tdResume = document.createElement('td');
      if (j.resume_docx) {
        const hash = j.resume_docx_hash ? `?v=${j.resume_docx_hash}` : `?t=${Date.now()}`;
        const a = document.createElement('a');
        a.href = j.resume_docx + hash;
        a.textContent = 'DOCX';
        tdResume.appendChild(a);
      } else {
        tdResume.textContent = '—';
      }
      tr.appendChild(tdResume);

      const tdExplain = document.createElement('td');
      if (j.changes_path) {
        const btn = document.createElement('button');
        btn.className = 'btn';
        btn.textContent = 'Explain';
        btn.addEventListener('click', () => openExplain(j));
        tdExplain.appendChild(btn);
      } else {
        tdExplain.textContent = '—';
      }
      tr.appendChild(tdExplain);

      tbody.appendChild(tr);
    });
  }

  hideStatus();
  showTable();

  // -------- Explain modal ----------
  const modal = document.getElementById('explainModal');
  const closeBtn = document.getElementById('closeExplain');
  const titleEl = document.getElementById('explainTitle');
  const keywordsEl = document.getElementById('explainKeywords');
  const changesEl = document.getElementById('explainChanges');

  async function openExplain(job) {
    titleEl.textContent = `${job.title || ''} @ ${job.company || ''}`;

    // ATS keywords
    keywordsEl.innerHTML = '';
    const kws = Array.isArray(job.ats_keywords) ? job.ats_keywords : (job.keywords || []);
    if (kws && kws.length) {
      kws.slice(0, 24).forEach(k => {
        const span = document.createElement('span');
        span.className = 'pill';
        span.textContent = k;
        keywordsEl.appendChild(span);
      });
    }

    // Diff cards
    changesEl.innerHTML = '';
    try {
      const res = await fetch(job.changes_path, { cache: 'no-cache' });
      if (res.ok) {
        const data = await res.json();
        const changes = Array.isArray(data.changes) ? data.changes : [];
        changes.forEach(ch => {
          const row = document.createElement('div');
          row.className = 'diffrow';

          const left = document.createElement('div');
          left.className = 'diffcol';
          left.innerHTML = `<strong>${ch.section || ''} — before</strong>\n\n${ch.before || ''}`;

          const right = document.createElement('div');
          right.className = 'diffcol';
          right.innerHTML = `<strong>${ch.section || ''} — after</strong>\n\n${ch.after || ''}`;

          const reason = document.createElement('div');
          reason.className = 'muted';
          reason.style.fontSize = '12px';
          reason.style.marginTop = '4px';
          reason.textContent = `Reason: ${ch.reason || ''}`;

          changesEl.appendChild(row);
          row.appendChild(left);
          row.appendChild(right);
          changesEl.appendChild(reason);
        });
      }
    } catch (e) {
      console.error(e);
    }

    // Open modal
    modal.style.display = 'block';
    document.body.classList.add('modal-open');
  }

  function closeExplain() {
    modal.style.display = 'none';
    document.body.classList.remove('modal-open');
  }

  closeBtn?.addEventListener('click', closeExplain);
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) closeExplain();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display === 'block') closeExplain();
  });
})();
