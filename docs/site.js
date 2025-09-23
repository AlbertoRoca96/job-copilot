// docs/site.js
// Multi-user onboarding page:
// - If no session: show Sign in link only
// - If signed in: show upload + run buttons
// - Shortlist loads from Supabase Storage outputs/<uid>/scores.json after a run

(async function () {
  await new Promise(r => window.addEventListener('load', r));
  const supabase = window.supabase.createClient(
    'https://imozfqawxpsasjdmgdkh.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imltb3pmcWF3eHBzYXNqZG1nZGtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg1Njk3NTUsImV4cCI6MjA3NDE0NTc1NX0.fkGObZvEy-oUfLrPcwgTSJbc-n6O5aE31SGIBeXImtc'
  );

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

  async function currentUser() {
    const { data: { user } } = await supabase.auth.getUser();
    return user || null;
  }

  async function showState() {
    const user = await currentUser();
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

  async function uploadResume() {
    const user = await currentUser(); if (!user) return alert('Sign in first.');
    const file = document.getElementById('resume').files[0]; if (!file) return alert('Choose a .docx file');
    const path = `${user.id}/current.docx`;
    const { error } = await supabase.storage.from('resumes').upload(path, file, { upsert: true });
    if (error) { upMsg.textContent = 'Upload error: ' + error.message; return; }
    // Also insert metadata row (RLS permits own insert)
    await fetch(`${supabase.storage.url.replace('/storage/v1','')}/rest/v1/resumes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabase.headers().apikey,
        Authorization: supabase.headers().Authorization
      },
      body: JSON.stringify({ user_id: user.id, path })
    }).catch(()=>{});
    upMsg.textContent = 'Uploaded.';
  }

  async function runTailor() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return alert('Sign in first.');
    runMsg.textContent = 'Queuing…';
    const resp = await fetch(`${supabase.storage.url.replace('/storage/v1','')}/functions/v1/request-run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        apikey: supabase.headers().apikey
      },
      body: JSON.stringify({ note: 'user run from onboarding' })
    });
    const out = await resp.json().catch(()=>({}));
    runMsg.textContent = resp.ok ? `Queued: ${out.request_id}` : `Error: ${out.error || resp.status}`;
    if (resp.ok) {
      // poll for outputs for a bit
      pollForShortlist();
    }
  }

  async function downloadOutputsJSON(path) {
    const { data, error } = await supabase.storage.from('outputs').download(path);
    if (error) return null;
    try {
      const txt = await data.text();
      return JSON.parse(txt);
    } catch {
      return null;
    }
  }

  async function loadShortlist() {
    const user = await currentUser(); if (!user) return;
    const arr = await downloadOutputsJSON(`${user.id}/scores.json`);
    if (!arr || !Array.isArray(arr) || arr.length === 0) {
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
      const tdTitle = document.createElement('td'); const a=document.createElement('a'); a.href=j.url||'#'; a.target='_blank'; a.rel='noopener'; a.textContent=j.title||'(no title)'; tdTitle.appendChild(a); tr.appendChild(tdTitle);
      const tdCompany = document.createElement('td'); tdCompany.textContent = j.company||''; tr.appendChild(tdCompany);
      const tdLoc = document.createElement('td'); tdLoc.textContent = (j.location||'').trim(); tr.appendChild(tdLoc);
      const tdPosted = document.createElement('td'); tdPosted.textContent = j.posted_at ? String(j.posted_at).slice(0,10) : '—'; tr.appendChild(tdPosted);
      tbody.appendChild(tr);
    }
    shortlist.classList.remove('hidden');
    table.classList.remove('hidden');
    noData.classList.add('hidden');
  }

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
