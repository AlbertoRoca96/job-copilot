(async function(){
  const status = document.getElementById('status');
  const table = document.getElementById('jobs');
  const tbody = table.querySelector('tbody');

  try {
    const res = await fetch('./data/scores.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('No scores yet. Run the crawl-and-rank workflow.');
    const data = await res.json();

    tbody.innerHTML = '';
    for (const j of data) {
      const tr = document.createElement('tr');
      const coverName = j.cover_file || '';

      tr.innerHTML = `
        <td>${(j.score ?? 0).toFixed(3)}</td>
        <td><a href="${j.url}" target="_blank" rel="noopener">${j.title}</a></td>
        <td>${j.company}</td>
        <td>${j.location || ''}</td>
        <td>${coverName ? `<a href="../docs/outbox/${coverName}">cover</a>` : '<em>—</em>'}</td>
      `;
      tbody.appendChild(tr);
    }

    status.textContent = `${data.length} jobs loaded.`;
    table.classList.remove('hidden');
  } catch (e) {
    status.textContent = e.message || 'Failed to load data.';
  }
})();
