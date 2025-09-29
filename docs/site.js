// docs/site.js — optional helper used by older pages (not required by profile.html)
export async function initOnboardControls(supabase) {
  const el = (id) => document.getElementById(id);

  const onboard   = el('onboard');
  const shortlist = el('shortlist');
  const who       = el('who');
  const logout    = el('logout');
  const uploadBtn = el('uploadResume');
  const upMsg     = el('upMsg');
  const runBtn    = el('runTailor');
  const runMsg    = el('runMsg');
  const refreshBtn= el('refresh');

  const table  = el('jobs');
  const tbody  = table ? table.querySelector('tbody') : null;
  const noData = el('noData');

  async function getUser()    { return (await supabase.auth.getUser()).data.user || null; }
  async function getSession() { return (await supabase.auth.getSession()).data.session || null; }

  if (!(onboard || shortlist)) return; // nothing to do on this page

  async function uploadResume() {
    const session = await getSession();
    const user = session?.user;
    if (!user) return alert('Sign in first.');

    const fileEl = document.getElementById('resume');
    const file = fileEl?.files?.[0];
    if (!file) return alert('Choose a .docx file');

    const path = `${user.id}/current.docx`;
    const { error: upErr } = await supabase.storage.from('resumes').upload(path, file, { upsert: true });
    if (upErr) { if (upMsg) upMsg.textContent = 'Upload error: ' + upErr.message; return; }

    const { error: metaErr } = await supabase.from('resumes').insert({ user_id: user.id, bucket: 'resumes', path });
    if (metaErr) { if (upMsg) upMsg.textContent = 'Upload metadata error: ' + metaErr.message; return; }

    if (upMsg) upMsg.textContent = 'Uploaded.';
  }

  async function runTailor() {
    const session = await getSession();
    if (!session) return alert('Sign in first.');
    if (runMsg) runMsg.textContent = 'Queuing…';

    const titlesVal = (document.getElementById('desiredTitles')?.value || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const locsVal   = (document.getElementById('desiredLocs')?.value || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const recencyDays   = Math.max(0, parseInt(document.getElementById('recencyDays')?.value || '0', 10) || 0);
    const remoteOnly    = !!document.getElementById('remoteOnly')?.checked;
    const requirePosted = !!document.getElementById('requirePosted')?.checked;

    try {
      const { data, error } = await supabase.functions.invoke('request-run', {
        body: {
          note: 'user run (legacy)',
          search_policy: { recency_days: recencyDays, require_posted_date: requirePosted, remote_only: remoteOnly },
          // If you also want to save titles/locations here, do that via supabase.from('profiles').update(...).
        }
      });
      if (error) { if (runMsg) runMsg.textContent = `Error: ${error.message}`; return; }
      if (runMsg) runMsg.textContent = `Queued: ${data?.request_id || 'ok'}`;
      await loadShortlist();
    } catch (e) {
      if (runMsg) runMsg.textContent = 'Error: ' + String(e);
    }
  }

  async function loadShortlist() {
    const user = await getUser(); if (!user) return;
    if (!(shortlist && table && tbody)) return;

    const { data, error } = await supabase.storage.from('outputs').createSignedUrl(`${user.id}/scores.json`, 60);
    if (error || !data?.signedUrl) {
      shortlist.classList.remove('hidden'); table.classList.add('hidden'); if (noData) noData.classList.remove('hidden'); return;
    }

    let arr = [];
    try {
      const res = await fetch(data.signedUrl, { cache: 'no-cache' });
      if (res.ok) arr = await res.json();
    } catch {}

    if (!Array.isArray(arr) || arr.length === 0) {
      shortlist.classList.remove('hidden'); table.classList.add('hidden'); if (noData) noData.classList.remove('hidden'); return;
    }

    tbody.innerHTML = '';
    arr.sort((a, b) => (b.score || 0) - (a.score || 0));
    for (const j of arr) {
      const tr = document.createElement('tr');
      const tdScore = document.createElement('td'); tdScore.textContent = (j.score ?? 0).toFixed(3); tr.appendChild(tdScore);
      const tdTitle = document.createElement('td');
      const a = document.createElement('a'); a.href = j.url || '#'; a.target = '_blank'; a.rel = 'noopener'; a.textContent = j.title || '(no title)';
      tdTitle.appendChild(a); tr.appendChild(tdTitle);
      const tdCompany = document.createElement('td'); tdCompany.textContent = j.company || ''; tr.appendChild(tdCompany);
      const tdLoc = document.createElement('td'); tdLoc.textContent = (j.location || '').trim(); tr.appendChild(tdLoc);
      const tdPosted = document.createElement('td'); tdPosted.textContent = j.posted_at ? String(j.posted_at).slice(0,10) : '—'; tr.appendChild(tdPosted);
      tbody.appendChild(tr);
    }
    shortlist.classList.remove('hidden'); table.classList.remove('hidden'); if (noData) noData.classList.add('hidden');
  }

  const user = await getUser(); if (!user) return;
  if (who) who.textContent = `Signed in as ${user.email || user.id}`;
  if (onboard) onboard.classList.remove('hidden');

  if (uploadBtn)  uploadBtn.onclick  = uploadResume;
  if (runBtn)     runBtn.onclick     = runTailor;
  if (refreshBtn) refreshBtn.onclick = loadShortlist;
  if (logout)     logout.onclick     = async () => { await supabase.auth.signOut(); location.reload(); };

  await loadShortlist();
}
