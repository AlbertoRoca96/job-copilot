// ----- run crawl & rank -----
runBtn.onclick = async () => {
  const session = await getSession(); if (!session) return alert("Sign in first.");
  runMsg.textContent = "Saving & queuing…";

  // 1) Save targets into the profile the user owns (RLS must allow this)
  const titles = (titlesInput.value || "").split(",").map(s => s.trim()).filter(Boolean);
  const locs   = (locsInput.value || "").split(",").map(s => s.trim()).filter(Boolean);

  // The anon key can PATCH the user's own row if you add an RLS policy:
  //   create policy "profiles_owner_update" on profiles for update
  //   using (id = auth.uid()) with check (id = auth.uid());
  // See Supabase RLS examples using auth.uid(). :contentReference[oaicite:2]{index=2}
  let patchErr = null;
  try {
    const { error } = await supabase
      .from("profiles")
      .update({ target_titles: titles, locations: locs })
      .eq("id", (await getUser()).id);
    if (error) patchErr = error;
  } catch (e) { patchErr = e; }

  if (patchErr) { runMsg.textContent = "Save failed: " + String(patchErr.message || patchErr); return; }

  // 2) Queue the run (optionally update only search_policy)
  const recencyDays   = Math.max(0, parseInt(recencyInput.value || "0", 10) || 0);
  const remoteOnly    = !!remoteOnlyCb.checked;
  const requirePosted = !!requirePostCb.checked;

  try {
    const restBase = "https://imozfqawxpsasjdmgdkh.supabase.co";
    const resp = await fetch(`${restBase}/functions/v1/request-run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: "<your anon key>",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        note: "user run from profile",
        search_policy: {
          recency_days: recencyDays,
          require_posted_date: requirePosted,
          remote_only: remoteOnly
        }
      }),
    });
    let out = {}; try { out = await resp.json(); } catch {}
    if (!resp.ok) { runMsg.textContent = `Error: ${out.detail || out.error || resp.status}`; return; }
    runMsg.textContent = `Queued: ${out.request_id || "ok"}`;
    setTimeout(loadShortlist, 3000);
  } catch (e) {
    runMsg.textContent = "Error: " + String(e);
  }
};
