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
      } else { tdCover.textContent = '—'; }
      tr.appendChild(tdCover);

      const tdResume = document.createElement('td');
      if (j.resume_docx) {
        const hash = j.resume_docx_hash ? `?v=${j.resume_docx_hash}` : `?t=${Date.now()}`;
        const a = document.createElement('a');
        a.href = j.resume_docx + hash;
        a.textContent = 'DOCX';
        tdResume.appendChild(a);
      } else { tdResume.textContent = '—'; }
      tr.appendChild(tdResume);

      const tdExplain = document.createElement('td');
      if (j.changes_path) {
        const btn = document.createElement('button');
        btn.className = 'btn';
        btn.textContent = 'Explain';
        btn.addEventListener('click', () => openExplain(j));
        tdExplain.appendChild(btn);
      } else { tdExplain.textContent = '—'; }
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
    } catch (e) { console.error(e); }

    modal.style.display = 'block';
    document.body.classList.add('modal-open');
  }

  function closeExplain() { modal.style.display = 'none'; document.body.classList.remove('modal-open'); }
  closeBtn?.addEventListener('click', closeExplain);
  modal?.addEventListener('click', (e) => { if (e.target === modal) closeExplain(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal.style.display === 'block') closeExplain(); });
})();

// ---------- Supabase auth + upload + trigger (dashboard only) ----------
(async function () {
  await new Promise(r => window.addEventListener('load', r));
  if (!window.supabase) return;

  // TODO: replace with your actual values from Settings → API
  const SUPABASE_URL = 'https://imozfqawxpsasjdmgdkh.supabase.co';
  const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imltb3pmcWF3eHBzYXNqZG1nZGtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg1Njk3NTUsImV4cCI6MjA3NDE0NTc1NX0.fkGObZvEy-oUfLrPcwgTSJbc-n6O5aE31SGIBeXImtc';

  const supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

  const loginBtn = document.getElementById('login');
  const logoutBtn = document.getElementById('logout');
  const whoami = document.getElementById('whoami');
  const prof = document.getElementById('profile');
  const saveProfile = document.getElementById('saveProfile');
  const runTailor = document.getElementById('runTailor');
  const uploadResume = document.getElementById('uploadResume');

  async function refresh() {
    const { data: { user } } = await supa.auth.getUser();
    if (user) {
      whoami.textContent = `Signed in as ${user.email || user.id}`;
      loginBtn.style.display = 'none';
      logoutBtn.style.display = '';
      prof.style.display = '';
    } else {
      whoami.textContent = '';
      loginBtn.style.display = '';
      logoutBtn.style.display = 'none';
      prof.style.display = 'none';
    }
  }

  loginBtn.onclick = async () => { await supa.auth.signInWithOAuth({ provider: 'github' }); };
  logoutBtn.onclick = async () => { await supa.auth.signOut(); location.reload(); };
  await refresh();

  // Save profile
  saveProfile.onclick = async () => {
    const { data: { user } } = await supa.auth.getUser();
    if (!user) return;

    const payload = {
      id: user.id,
      full_name: document.getElementById('full_name').value || null,
      phone: document.getElementById('phone').value || null,
      skills: (document.getElementById('skills').value || '')
        .split(',').map(s => s.trim()).filter(Boolean)
    };

    // upsert via REST
    await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON,
        Authorization: `Bearer ${(await supa.auth.getSession()).data.session?.access_token || ''}`,
        Prefer: 'resolution=merge-duplicates'
      },
      body: JSON.stringify(payload)
    });
    alert('Profile saved.');
  };

  // Upload resume to private bucket: resumes/{uid}/current.docx
  uploadResume.onclick = async () => {
    const { data: { user } } = await supa.auth.getUser();
    if (!user) return;
    const f = document.getElementById('resume').files[0];
    if (!f) return alert('Choose a .docx');

    const path = `${user.id}/current.docx`;
    const { error } = await supa.storage.from('resumes').upload(path, f, { upsert: true });
    if (error) return alert('Upload error: ' + error.message);

    // record row
    await fetch(`${SUPABASE_URL}/rest/v1/resumes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON,
        Authorization: `Bearer ${(await supa.auth.getSession()).data.session?.access_token || ''}`
      },
      body: JSON.stringify({ user_id: user.id, path })
    });
    alert('Uploaded resume.');
  };

  // Call Edge Function to trigger GH Action
  runTailor.onclick = async () => {
    const { data: { session } } = await supa.auth.getSession();
    if (!session) return alert('Sign in first.');

    const resp = await fetch(`${SUPABASE_URL}/functions/v1/request-run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        apikey: SUPABASE_ANON
      },
      body: JSON.stringify({ note: 'user-initiated from dashboard' })
    });
    const out = await resp.json().catch(() => ({}));
    document.getElementById('runMsg').textContent =
      resp.ok ? `Request queued: ${out.request_id}` : `Error: ${out.error || resp.status}`;
  };
})();
