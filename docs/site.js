// docs/site.js
// Multi-user onboarding page:
// - If no session: show Sign in link only
// - If signed in: show upload + run buttons
// - Shortlist loads from Supabase Storage outputs/<uid>/scores.json via signed URL

(async function () {
  await new Promise(r => window.addEventListener('load', r));

  const supabase = window.supabase.createClient(
    'https://imozfqawxpsasjdmgdkh.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imltb3pmcWF3eHBzYXNqZG1nZGtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg1Njk3NTUsImV4cCI6MjA3NDE0NTc1NX0.fkGObZvEy-oUfLrPcwgTSJbc-n6O5aE31SGIBeXImtc'
  );

  // UI elements
  const signinOnly = document.getElementById('signinOnly');
  const onboard = document.getElementById('onboard');
  const who = document.getElementById('who');
  const logout = document.getElementById('logout');
  const uploadBtn = document.getElementById('uploadResume');
  const upMsg = document.getElementById('upMsg');
  const runBtn = document.getElementById('runTailor');
  const runMsg = document.getElementById('runMsg');
  const refreshBtn = document.getElementById('refresh');

  const table = document.getElementById('jobs');
  const tbody = table.querySelector('tbody');
  const shortlist = document.getElementById('shortlist');
  const noData = document.getElementById('noData');

  // helpers
  async function getUser() {
    const { data: { user } } = await supabase.auth.getUser();
    return user || null;
  }
  async function getSession() {
    const { data: { session } } = await supabase.auth.getSession();
    return session || null;
  }

  async function showState() {
    const user = await getUser();
    if (!user) {
      signinOnly.classList.remove('hidden');
      onboard.classList.add('hidden');
      shortlist.classList.add('hidden');
      return;
    }
    signinOnly.classList.add('hidden');
    onboard.classList.remove('hidden');
    who.textContent = `Signed in as ${user.email || user.id}`;
    await loadShortlist(); // try to show any previous run
  }

  // ---- 1) Upload resume (.docx) ----
  async function uploadResume() {
    const session = await getSession();
    const user = session?.user;
    if (!user) return alert('Sign in first.');

    const file = document.getElementById('resume').files[0];
    if (!file) return alert('Choose a .docx file');

    const path = `${user.id}/current.docx`;

    // Storage upload (private bucket 'resumes')
    const { error: upErr } = await supabase.storage.from('resumes').upload(path, file, { upsert: true });
    if (upErr) { upMsg.textContent = 'Upload error: ' + upErr.message; return; }

    // Insert metadata row into public.resumes with USER JWT for RLS
    try {
      const restBase = supabase.storage.url.replace('/storage/v1', '');
      const resp = await fetch(`${restBase}/rest/v1/resumes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: supabase.headers().apikey,                 // anon key
          Authorization: `Bearer ${session.access_token}`,   // USER JWT (important for RLS)
          Prefer: 'return=representation'
        },
        body: JSON.stringify({ user_id: user.id, bucket: 'resumes', path })
      });
      if (!resp.ok) {
        const t = await resp.text().catch(()=>'');
        upMsg.textContent = 'Upload metadata error: ' + t;
        return;
      }
    } catch (e) {
      upMsg.textContent = 'Upload metadata error: ' + String(e);
      return;
    }

    upMsg.textContent = 'Uploaded.';
  }

  // ---- 2) Trigger tailor workflow (Edge Function -> GitHub Action) ----
  async function runTailor() {
    const session = await getSession();
    if (!session) return alert('Sign in first.');

    runMsg.textContent = 'Queuing…';

    try {
      const restBase = supabase.storage.url.replace('/storage/v1', '');
      const resp = await fetch(`${restBase}/functions/v1/request-run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: supabase.headers().apikey,
          Authorization: `Bearer ${session.access_token}`   // USER JWT
        },
        body: JSON.stringify({ note: 'user run from onboarding' })
      });
      const out = await resp.json().catch(()=>({}));
      runMsg.textContent = resp.ok ? `Queued: ${out.request_id}` : `Error: ${out.error || resp.status}`;
      if (resp.ok) pollForShortlist();
    } catch (e) {
      runMsg.textContent = 'Error: ' + String(e);
    }
  }

  // ---- 3) Load shortlist from outputs/<uid>/scores.json via signed URL ----
  async function loadShortlist() {
    const user = await getUser(); if (!user) return;

    // create a short-lived signed URL for the private file
    const key = `${user.id}/scores.json`;
    const { data, error } = await supabase.storage.from('outputs').createSignedUrl(key, 60);
    if (error || !data?.signedUrl) {
      // no shortlist yet (or not generated)
      shortlist.classList.remove('hidden');
      table.classList.add('hidden');
      noData.classList.remove('hidden');
      return;
    }

    let arr = [];
    try {
      const res = await fetch(data.signedUrl, { cache: 'no-cache' });
      if (res.ok) arr = await res.json();
    } catch {}

    if (!Array.isArray(arr) || arr.length === 0) {
      shortlist.classList.remove('hidden');
      table.classList.add('hidden');
      noData.classList.remove('hidden');
      return;
    }

    // render
    tbody.innerHTML = '';
    arr.sort((a,b) => (b.score||0) - (a.score||0));
    for (const j of arr) {
      const tr = document.createElement('tr');
      const tdScore = document.createElement('td'); tdScore.textContent = (j.score ?? 0).toFixed(3); tr.appendChild(tdScore);
      const tdTitle = document.createElement('td');
      const a = document.createElement('a');
      a.href = j.url || '#'; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = j.title || '(no title)';
      tdTitle.appendChild(a); tr.appendChild(tdTitle);
      const tdCompany = document.createElement('td'); tdCompany.textContent = j.company || ''; tr.appendChild(tdCompany);
      const tdLoc = document.createElement('td'); tdLoc.textContent = (j.location || '').trim(); tr.appendChild(tdLoc);
      const tdPosted = document.createElement('td'); tdPosted.textContent = j.posted_at ? String(j.posted_at).slice(0,10) : '—'; tr.appendChild(tdPosted);
      tbody.appendChild(tr);
    }
    shortlist.classList.remove('hidden');
    table.classList.remove('hidden');
    noData.classList.add('hidden');
  }

  // polling after queueing a run
  let pollTimer = null;
  function pollForShortlist() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(loadShortlist, 5000);
  }

  // wire up
  uploadBtn.onclick = uploadResume;
  runBtn.onclick = runTailor;
  refreshBtn.onclick = loadShortlist;
  logout.onclick = async () => { await supabase.auth.signOut(); location.reload(); };

  await showState();
})();
