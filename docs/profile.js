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
  const draftsBox = document.getElementById('drafts');
  const logout = document.getElementById('logout');

  const coversDiv = document.getElementById('covers');
  const resumesDiv = document.getElementById('resumes');
  const draftMsg = document.getElementById('draftMsg');

  function pills(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return '—';
    return arr.map(x => `<span class="pill">${String(x)}</span>`).join(' ');
  }

  // auth
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { signinOnly.classList.remove('hidden'); return; }
  who.textContent = `Signed in as ${user.email || user.id}`;
  logout.onclick = async () => { await supabase.auth.signOut(); location.href = './'; };

  // load profile (RLS)
  const { data, error } = await supabase.from('profiles').select('*').eq('id', user.id).single();
  profBox.classList.remove('hidden');
  draftsBox.classList.remove('hidden');
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

  // helper to list + link files in Storage via signed URLs
  async function listFiles(prefix) {
    const { data: files, error } = await supabase.storage.from('outputs').list(`${user.id}/${prefix}`, { limit: 100, sortBy: { column: 'name', order: 'desc' } });
    if (error) return [];
    const items = [];
    for (const f of files) {
      const key = `${user.id}/${prefix}/${f.name}`;
      const { data: signed } = await supabase.storage.from('outputs').createSignedUrl(key, 60);
      if (signed?.signedUrl) items.push({ name: f.name, url: signed.signedUrl });
    }
    return items;
  }

  async function refreshDraftLists() {
    coversDiv.innerHTML = ''; resumesDiv.innerHTML = '';
    for (const item of await listFiles('outbox')) {
      const a = document.createElement('a'); a.href = item.url; a.textContent = item.name; a.className='file'; a.target='_blank';
      coversDiv.appendChild(a);
    }
    for (const item of await listFiles('resumes')) {
      const a = document.createElement('a'); a.href = item.url; a.textContent = item.name; a.className='file'; a.target='_blank';
      resumesDiv.appendChild(a);
    }
  }

  // run drafts (Edge Function -> dispatch GH workflow)
  document.getElementById('runDrafts').onclick = async () => {
    draftMsg.textContent = 'Queuing…';
    try {
      const { data: session } = await supabase.auth.getSession();
      const top = Math.max(1, Math.min(25, parseInt(document.getElementById('topN').value || '5', 10) || 5));
      const resp = await fetch('https://imozfqawxpsasjdmgdkh.supabase.co/functions/v1/request-draft', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imltb3pmcWF3eHBzYXNqZG1nZGtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg1Njk3NTUsImV4cCI6MjA3NDE0NTc1NX0.fkGObZvEy-oUfLrPcwgTSJbc-n6O5aE31SGIBeXImtc',
          Authorization: `Bearer ${session.session?.access_token || ''}`
        },
        body: JSON.stringify({ top, note: 'user triggered from profile' })
      });
      const out = await resp.json().catch(()=> ({}));
      draftMsg.textContent = resp.ok ? `Queued (top=${top})` : `Error: ${out.detail || out.error || resp.status}`;
      if (resp.ok) {
        // start polling list for new files
        const t = setInterval(async () => {
          await refreshDraftLists();
        }, 5000);
        // initial refresh
        await refreshDraftLists();
        // stop polling after 2 minutes to avoid running forever
        setTimeout(()=> clearInterval(t), 120000);
      }
    } catch (e) {
      draftMsg.textContent = 'Error: ' + String(e);
    }
  };

  await refreshDraftLists();
})();
