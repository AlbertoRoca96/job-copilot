function $(id){ return document.getElementById(id); }

function fillForm(p){
  if (!p) return;
  $('title').value = p.title || '';
  $('company').value = p.company || '';
  $('location').value = p.location || '';
  $('source').value = p.source || 'web';
  $('url').value = p.url || location.href;
  $('description').value = p.description || '';
}

function setMsg(txt, ok){
  const el = $('msg');
  el.textContent = txt || '';
  el.className = ok ? 'small ok' : 'small err';
}

document.addEventListener('DOMContentLoaded', ()=>{
  chrome.runtime.sendMessage({ type: "GET_LAST" }, (res)=>{
    fillForm(res?.payload || null);
  });
  chrome.storage.sync.get(["supabaseUrl","functionPath","userJwt"], (cfg)=>{
    $('supabaseUrl').value = cfg.supabaseUrl || '';
    $('functionPath').value = cfg.functionPath || '/save-job';
    $('userJwt').value = cfg.userJwt || '';
  });

  $('save').addEventListener('click', ()=>{
    const payload = {
      url: $('url').value.trim(),
      title: $('title').value.trim(),
      company: $('company').value.trim(),
      location: $('location').value.trim(),
      description: $('description').value.trim(),
      source: $('source').value.trim() || 'web',
      note: $('note').value.trim() || undefined
    };
    chrome.runtime.sendMessage({ type: "SAVE_JOB", payload }, (res)=>{
      if (res?.ok) setMsg('Saved ✔', true);
      else setMsg(`Failed: ${res?.status || ''} ${res?.error || (res?.body?.error || '')}`, false);
    });
  });

  $('save_settings').addEventListener('click', ()=>{
    chrome.storage.sync.set({
      supabaseUrl: $('supabaseUrl').value.trim(),
      functionPath: $('functionPath').value.trim(),
      userJwt: $('userJwt').value.trim()
    }, ()=> setMsg('Settings saved', true));
  });
});
