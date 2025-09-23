// docs/profile.js
(async function () {
  await new Promise(r => window.addEventListener('load', r));

  const supabase = window.supabase.createClient(
    'https://imozfqawxpsasjdmgdkh.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imltb3pmcWF3eHBzYXNqZG1nZGtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg1Njk3NTUsImV4cCI6MjA3NDE0NTc1NX0.fkGObZvEy-oUfLrPcwgTSJbc-n6O5aE31SGIBeXImtc'
  );

  const who = document.getElementById('who');
  const signinOnly = document.getElementById('signinOnly');
  const profBox = document.getElementById('profile');

  const shortlist = document.getElementById('shortlist');
  const table = document.getElementById('jobs');
  const tbody = table.querySelector('tbody');
  const noData = document.getElementById('noData');

  function pills(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return '—';
    return arr.map(x => `<span class="pill">${String(x)}</span>`).join(' ');
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { signinOnly.classList.remove('hidden'); return; }

  who.textContent = `Signed in as ${user.email || user.id}`;

  // ---- Load profile row (RLS: id = auth.uid()) ----
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  profBox.classList.remove('hidden');
  if (error) {
    document.getElementById('full_name').textContent = `Error: ${error.message}`;
  } else {
    document.getElementById('full_name').textContent = data?.full_name || '—';
    document.getElementById('email').textContent     = data?.email || '—';
    document.getElementById('phone').textContent     = data?.phone || '—';
    document.getElementById('skills').innerHTML      = pills(data?.skills || []);
    document.getElementById('titles').innerHTML      = pills(data?.target_titles || []);
    document.getElementById('locs').innerHTML        = pills(data?.locations || []);

    const pol = data?.search_policy || {};
    const s = [
      `recency_days=${pol.recency_days ?? 0}`,
      `require_posted_date=${!!pol.require_posted_date}`,
      `remote_only=${!!pol.remote_only}`
    ].join(', ');
    document.getElementById('policy').textContent = s;
    document.getElementById('updated').textContent = (data?.updated_at || data?.created_at || '—').toString();
  }

  // ---- Load shortlist from outputs/<uid>/scores.json via signed URL ----
  async function loadShortlist() {
    const key = `${user.id}/scores.json`;
    const { data, error } = await supabase.storage.from('outputs').createSignedUrl(key, 60);
    if (error || !data?.signedUrl) {
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
    shortlist.classList.remove('hidden');
    table.classList.remove('hidden');
    noData.classList.add('hidden');
  }

  // Poll shortlist for a couple of minutes (new users)
  await loadShortlist();
  let tries = 0;
  const timer = setInterval(async () => {
    tries += 1;
    await loadShortlist();
    if (tries > 24) clearInterval(timer); // ~2 minutes @5s
  }, 5000);
})();
