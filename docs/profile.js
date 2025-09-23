(async function () {
  await new Promise(r => window.addEventListener('load', r));

  const supabase = window.supabase.createClient(
    'https://imozfqawxpsasjdmgdkh.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imltb3pmcWF3eHBzYXNqZG1nZGtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg1Njk3NTUsImV4cCI6MjA3NDE0NTc1NX0.fkGObZvEy-oUfLrPcwgTSJbc-n6O5aE31SGIBeXImtc'
  );

  const who = document.getElementById('who');
  const signinOnly = document.getElementById('signinOnly');
  const profBox = document.getElementById('profile');

  const matBox = document.getElementById('materials');
  const genBtn = document.getElementById('genBtn');
  const genMsg = document.getElementById('genMsg');
  const topN   = document.getElementById('topN');
  const draftTable = document.getElementById('draftTable');
  const draftBody  = draftTable.querySelector('tbody');
  const noDrafts   = document.getElementById('noDrafts');

  function pills(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return '—';
    return arr.map(x => `<span class="pill">${String(x)}</span>`).join(' ');
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { signinOnly.classList.remove('hidden'); return; }

  who.textContent = `Signed in as ${user.email || user.id}`;

  // Read own profile row
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  profBox.classList.remove('hidden');
  matBox.classList.remove('hidden');

  if (!error && data) {
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
  } else {
    document.getElementById('full_name').textContent = `Error: ${error?.message || 'profile not found'}`;
  }

  // Generate materials -> call Edge Function request-draft (singular)
  async function generateDrafts() {
    genMsg.textContent = 'Queuing…';
    const session = (await supabase.auth.getSession()).data.session;
    if (!session) { genMsg.textContent = 'Sign in first.'; return; }
    try {
      const restBase = 'https://imozfqawxpsasjdmgdkh.supabase.co';
      const resp = await fetch(`${restBase}/functions/v1/request-draft`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imltb3pmcWF3eHBzYXNqZG1nZGtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg1Njk3NTUsImV4cCI6MjA3NDE0NTc1NX0.fkGObZvEy-oUfLrPcwgTSJbc-n6O5aE31SGIBeXImtc',
          Authorization: `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ top: Math.max(1, Math.min(20, parseInt(topN.value || '5', 10) || 5)) })
      });
      const out = await resp.json().catch(() => ({}));
      if (!resp.ok) { genMsg.textContent = `Error: ${out.detail || out.error || resp.status}`; return; }
      genMsg.textContent = `Queued request ${out.request_id}. Refresh in a bit.`;
      pollDrafts();
    } catch (e) {
      genMsg.textContent = 'Error: ' + String(e);
    }
  }

  // List drafts via signed URLs
  async function loadDrafts() {
    draftBody.innerHTML = '';
    const key = `${user.id}/drafts_index.json`;
    const { data: signed, error } = await supabase.storage.from('outputs').createSignedUrl(key, 60);
    if (error || !signed?.signedUrl) {
      draftTable.classList.add('hidden');
      noDrafts.classList.remove('hidden');
      return;
    }
    let idx = null;
    try {
      const r = await fetch(signed.signedUrl, { cache: 'no-cache' });
      if (r.ok) idx = await r.json();
    } catch {}
    const rows = [];
    function push(type, file) { rows.push([type, file]); }
    (idx?.outbox || []).forEach(f => push('cover',   `outbox/${f}`));
    (idx?.resumes || []).forEach(f => push('resume', `resumes/${f}`));
    (idx?.changes || []).forEach(f => push('changes',`changes/${f}`));

    if (rows.length === 0) {
      draftTable.classList.add('hidden');
      noDrafts.classList.remove('hidden');
      return;
    }

    // For each file, make a signed URL row
    for (const [type, rel] of rows) {
      const key2 = `${user.id}/${rel}`;
      const { data: s2 } = await supabase.storage.from('outputs').createSignedUrl(key2, 60);
      const tr = document.createElement('tr');
      const tdT = document.createElement('td'); tdT.textContent = type; tr.appendChild(tdT);
      const tdF = document.createElement('td');
      const a = document.createElement('a');
      a.href = s2?.signedUrl || '#'; a.target = '_blank'; a.rel = 'noopener'; a.textContent = rel.split('/').slice(-1)[0];
      tdF.appendChild(a); tr.appendChild(tdF);
      draftBody.appendChild(tr);
    }
    draftTable.classList.remove('hidden');
    noDrafts.classList.add('hidden');
  }

  // Polling after queue
  let pollTimer = null;
  function pollDrafts() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(loadDrafts, 5000);
  }

  genBtn.onclick = generateDrafts;
  await loadDrafts();
})();
