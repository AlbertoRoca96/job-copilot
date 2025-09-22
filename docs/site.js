// docs/site.js
// Renders your shortlist table (existing) AND shows a signed-in panel for:
// - profile save (acts like profile.yaml)
// - resume upload to private Storage
// - "Tailor my application" -> calls Edge Function to start the GitHub Action

(async function() {
  // ---------- Shortlist (unchanged parts) ----------
  const statusEl = document.getElementById('status');
  const table = document.getElementById('jobs');
  const tbody = table ? table.querySelector('tbody') : null;

  function showStatus(msg) { if (statusEl) statusEl.textContent = msg; }
  function hideStatus() { if (statusEl) statusEl.classList.add('hidden'); }
  function showTable() { if (table) table.classList.remove('hidden'); }

  let jobs = [];
  try {
    const res = await fetch('data/scores.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    jobs = await res.json();
  } catch {
    showStatus('Failed to load scores.json'); return;
  }
  jobs.sort((a, b) => (b.score || 0) - (a.score || 0));

  if (tbody) {
    for (const j of jobs) {
      const tr = document.createElement('tr');

      const tdScore = document.createElement('td');
      tdScore.textContent = (j.score ?? 0).toFixed(3); tr.appendChild(tdScore);

      const tdTitle = document.createElement('td');
      const aJD = document.createElement('a');
      aJD.href = j.url || '#'; aJD.target = '_blank'; aJD.rel = 'noopener';
      aJD.textContent = j.title || '(no title)';
      tdTitle.appendChild(aJD); tr.appendChild(tdTitle);

      const tdCompany = document.createElement('td'); tdCompany.textContent = j.company || ''; tr.appendChild(tdCompany);
      const tdLoc = document.createElement('td'); tdLoc.textContent = (j.location || '').trim(); tr.appendChild(tdLoc);

      // Posted (if present)
      const tdPosted = document.createElement('td'); tdPosted.textContent = j.posted_at ? String(j.posted_at).slice(0,10) : '—'; tr.appendChild(tdPosted);

      const tdCover = document.createElement('td');
      if (j.cover_path) { const a=document.createElement('a'); a.href=j.cover_path; a.target='_blank'; a.rel='noopener'; a.textContent='Open'; tdCover.appendChild(a); }
      else tdCover.textContent = '—'; tr.appendChild(tdCover);

      const tdResume = document.createElement('td');
      if (j.resume_docx) { const hash=j.resume_docx_hash?`?v=${j.resume_docx_hash}`:`?t=${Date.now()}`; const a=document.createElement('a'); a.href=j.resume_docx+hash; a.textContent='DOCX'; tdResume.appendChild(a); }
      else tdResume.textContent = '—'; tr.appendChild(tdResume);

      const tdExplain = document.createElement('td');
      if (j.changes_path) { const b=document.createElement('button'); b.className='btn'; b.textContent='Explain'; b.onclick=()=>openExplain(j); tdExplain.appendChild(b); }
      else tdExplain.textContent = '—'; tr.appendChild(tdExplain);

      tbody.appendChild(tr);
    }
  }
  hideStatus(); showTable();

  // Explain modal (unchanged)
  const modal = document.getElementById('explainModal');
  const closeBtn = document.getElementById('closeExplain');
  const titleEl = document.getElementById('explainTitle');
  const keywordsEl = document.getElementById('explainKeywords');
  const changesEl = document.getElementById('explainChanges');

  async function openExplain(job) {
    titleEl.textContent = `${job.title || ''} @ ${job.company || ''}`;
    keywordsEl.innerHTML = '';
    const kws = Array.isArray(job.ats_keywords) ? job.ats_keywords : (job.keywords || []);
    kws.slice(0, 24).forEach(k => { const s=document.createElement('span'); s.className='pill'; s.textContent=k; keywordsEl.appendChild(s); });
    changesEl.innerHTML = '';
    try {
      const res = await fetch(job.changes_path, { cache: 'no-cache' });
      if (res.ok) {
        const data = await res.json();
        const changes = Array.isArray(data.changes) ? data.changes : [];
        changes.forEach(ch => {
          const row=document.createElement('div'); row.className='diffrow';
          const L=document.createElement('div'); L.className='diffcol'; L.innerHTML = `<strong>${ch.section||''} — before</strong>\n\n${ch.before||''}`;
          const R=document.createElement('div'); R.className='diffcol'; R.innerHTML = `<strong>${ch.section||''} — after</strong>\n\n${ch.after||''}`;
          const reason=document.createElement('div'); reason.className='muted'; reason.style.fontSize='12px'; reason.style.marginTop='4px'; reason.textContent=`Reason: ${ch.reason || ''}`;
          changesEl.appendChild(row); row.appendChild(L); row.appendChild(R); changesEl.appendChild(reason);
        });
      }
    } catch {}
    modal.style.display='block'; document.body.classList.add('modal-open');
  }
  function closeExplain(){ modal.style.display='none'; document.body.classList.remove('modal-open'); }
  closeBtn?.addEventListener('click', closeExplain);
  modal?.addEventListener('click', e => { if (e.target===modal) closeExplain(); });
  document.addEventListener('keydown', e => { if (e.key==='Escape' && modal.style.display==='block') closeExplain(); });

  // ---------- Auth + user panel ----------
  await new Promise(r => window.addEventListener('load', r));
  const supabase = window.supabase.createClient(
    'https://YOUR-REF.supabase.co',
    'YOUR_ANON_KEY'
  ); // Supabase JS v2 createClient. :contentReference[oaicite:7]{index=7}

  // Insert a small panel in the page header
  const header = document.querySelector('.wrap') || document.body;
  const panel = document.createElement('div');
  panel.innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0 16px">
      <a class="btn" href="login.html">Sign in</a>
      <button id="logout" class="btn" style="display:none">Sign out</button>
      <span id="who" class="muted"></span>
      <label>Full name <input id="full_name" style="width:180px"></label>
      <label>Phone <input id="phone" style="width:140px"></label>
      <label>Skills <input id="skills" placeholder="comma-separated" style="width:180px"></label>
      <button id="saveProfile" class="btn">Save Profile</button>
      <input type="file" id="resume" accept=".docx" />
      <button id="uploadResume" class="btn">Upload Resume</button>
      <button id="runTailor" class="btn">Tailor my application</button>
      <span id="runMsg" class="muted"></span>
    </div>`;
  header.insertBefore(panel, header.children[1]);

  async function refresh() {
    const { data: { user } } = await supabase.auth.getUser();
    document.getElementById('logout').style.display = user ? '' : 'none';
    document.querySelector('a.btn[href="login.html"]').style.display = user ? 'none' : '';
    document.getElementById('who').textContent = user ? `Signed in as ${user.email || user.id}` : '';
    // Try load profile
    if (user) {
      const r = await fetch(`${supabase.storage.url.replace('/storage/v1','')}/rest/v1/profiles?id=eq.${user.id}&select=*`, {
        headers: { apikey: supabase.headers().apikey, Authorization: supabase.headers().Authorization }
      });
      if (r.ok) {
        const rows = await r.json();
        const p = rows[0] || {};
        document.getElementById('full_name').value = p.full_name || '';
        document.getElementById('phone').value = p.phone || '';
        document.getElementById('skills').value = (p.skills || []).join(', ');
      }
    }
  }
  refresh();

  document.getElementById('logout').onclick = async () => { await supabase.auth.signOut(); location.href = './login.html'; };

  document.getElementById('saveProfile').onclick = async () => {
    const { data: { user } } = await supabase.auth.getUser(); if (!user) return;
    const body = {
      id: user.id,
      full_name: document.getElementById('full_name').value || null,
      phone: document.getElementById('phone').value || null,
      skills: (document.getElementById('skills').value || '').split(',').map(s=>s.trim()).filter(Boolean)
    };
    await fetch(`${supabase.storage.url.replace('/storage/v1','')}/rest/v1/profiles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabase.headers().apikey,
        Authorization: supabase.headers().Authorization,
        Prefer: 'resolution=merge-duplicates'
      },
      body: JSON.stringify(body)
    });
    alert('Saved!');
  };

  document.getElementById('uploadResume').onclick = async () => {
    const { data: { user } } = await supabase.auth.getUser(); if (!user) return alert('Sign in first.');
    const file = document.getElementById('resume').files[0]; if (!file) return alert('Choose a .docx file');
    const path = `${user.id}/current.docx`;
    const { error } = await supabase.storage.from('resumes').upload(path, file, { upsert: true }); // Storage upload. :contentReference[oaicite:8]{index=8}
    if (error) return alert('Upload error: ' + error.message);
    await fetch(`${supabase.storage.url.replace('/storage/v1','')}/rest/v1/resumes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: supabase.headers().apikey, Authorization: supabase.headers().Authorization },
      body: JSON.stringify({ user_id: user.id, path })
    });
    alert('Uploaded.');
  };

  document.getElementById('runTailor').onclick = async () => {
    const { data: { session } } = await supabase.auth.getSession(); if (!session) return alert('Sign in first.');
    const resp = await fetch(`${supabase.storage.url.replace('/storage/v1','')}/functions/v1/request-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}`, apikey: supabase.headers().apikey },
      body: JSON.stringify({ note: 'user run from dashboard' })
    });
    const out = await resp.json().catch(()=>({}));
    document.getElementById('runMsg').textContent = resp.ok ? `Queued: ${out.request_id}` : `Error: ${out.error || resp.status}`;
  };
})();
