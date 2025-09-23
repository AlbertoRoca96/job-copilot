(async function () {
  await new Promise(r => window.addEventListener('load', r));

  const supabase = window.supabase.createClient(
    'https://imozfqawxpsasjdmgdkh.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imltb3pmcWF3eHBzYXNqZG1nZGtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg1Njk3NTUsImV4cCI6MjA3NDE0NTc1NX0.fkGObZvEy-oUfLrPcwgTSJbc-n6O5aE31SGIBeXImtc'
  );

  const who = document.getElementById('who');
  const signinOnly = document.getElementById('signinOnly');
  const profBox = document.getElementById('profile');

  function pills(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return '—';
    return arr.map(x => `<span class="pill">${String(x)}</span>`).join(' ');
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { signinOnly.classList.remove('hidden'); return; }

  who.textContent = `Signed in as ${user.email || user.id}`;

  // Read own profile row (RLS: id = auth.uid())
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  if (error) {
    profBox.classList.remove('hidden');
    document.getElementById('full_name').textContent = `Error: ${error.message}`;
    return;
  }

  profBox.classList.remove('hidden');
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
})();
