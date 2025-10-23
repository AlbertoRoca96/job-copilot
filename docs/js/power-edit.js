// Power Edit client (JD-URL fetch + Rich Editor + formatted DOCX preview).
// Format-preserving DOCX export (v5):
// - Education + References are HARD-LOCKED.
// - Only write inside existing <w:t> nodes (never delete runs).
// - Preserve: bullet/numbering, leading punctuation prefix (—/–/-/• + spaces), hyperlinks,
//             run boundaries (by pouring new text proportionally across original non-link runs).

(async function () {
  await new Promise((r) => window.addEventListener("load", r));

  // ---------- Supabase ----------
  const supabase = (window.supabase || await (async () => {
    const s = document.createElement("script");
    s.src = "https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.js";
    s.defer = true;
    await new Promise((res, rej) => { s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    return window.supabase;
  })()).createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const chooseFile   = $("chooseFile");
  const fileInput    = $("fileInput");
  const resumeText   = $("resumeText");
  const jobDesc      = $("jobDesc");
  const jobTitle     = $("jobTitle");
  const jobCompany   = $("jobCompany");
  const jdUrl        = $("jdUrl");
  const fetchJD      = $("fetchJD");
  const fetchMsg     = $("fetchMsg");
  const autoTailor   = $("autoTailor");
  const tailorMsg    = $("tailorMsg");
  const changesBox   = $("changes");
  const afterPreview = $("afterPreview");
  const exportDocx   = $("exportDocx");
  const printPdf     = $("printPdf");
  const scoreVal     = $("scoreVal");
  const signinState  = $("signinState");
  const fmtState     = $("fmtState");
  const docxPreview  = $("docxPreview");

  // ---------- state ----------
  let originalDocxBuffer = null;
  let lastRewrites = [];
  let editor = null;

  // ---------- helpers ----------
  const esc = (s) => String(s || "").replace(/[&<>]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;" }[c]));
  const normalizeWS = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const WORD_RE = /[A-Za-z][A-Za-z0-9+./-]{1,}/g;

  const HEADERS_CANON = new Map([
    ["education","education"], ["references","references"], ["reference","references"],
    ["work experience","work experience"], ["experience","experience"],
    ["side projects","side projects"], ["projects","projects"],
    ["technical skills","technical skills"], ["skills","skills"],
    ["certifications","certifications"], ["awards","awards"],
    ["publications","publications"], ["summary","summary"],
    ["objective","objective"], ["profile","profile"],
    ["volunteer experience","volunteer experience"], ["volunteering","volunteer experience"],
    ["leadership","leadership"], ["additional information","additional information"],
    ["interests","interests"]
  ]);
  const PROTECTED_SECTIONS = new Set(["education", "references"]);

  const normalizeHeader = (s) =>
    String(s || "").toLowerCase().replace(/&/g,"and").replace(/[:.]/g,"")
      .replace(/[^a-z\s]/g,"").replace(/\s+/g," ").trim();

  const toks = (s="") => (String(s).toLowerCase().match(WORD_RE) || []);
  const tokset = (s="") => new Set(toks(s));
  const jaccard = (a="",b="") => {
    const A = tokset(a), B = tokset(b);
    const inter = [...A].filter(x => B.has(x)).length;
    const uni = new Set([...A,...B]).size || 1;
    return inter/uni;
  };

  function setFmtState(active) {
    fmtState.textContent = active ? "Formatting: original preserved" : "Formatting: simple";
    fmtState.style.background = active ? "#e8fff1" : "#f6f6f6";
  }

  async function refreshAuthPill() {
    try {
      const { data } = await supabase.auth.getSession();
      if (data?.session) { signinState.textContent = "Signed in (server boost)"; signinState.style.background = "#e8fff1"; }
      else { signinState.textContent = "Anonymous (rate-limited)"; signinState.style.background = "#fff7e6"; }
    } catch { signinState.textContent = "Anonymous (rate-limited)"; signinState.style.background = "#fff7e6"; }
  }

  // ---------- TinyMCE ----------
  async function ensureEditor() {
    if (editor) return editor;
    if (!window.tinymce) return null;
    const eds = await window.tinymce.init({
      selector: '#afterEditor',
      menubar: false,
      plugins: 'lists link',
      toolbar: 'undo redo | styles | bold italic underline | bullist numlist outdent indent | link | removeformat',
      height: 420,
      branding: false,
      content_style: 'body{font:13px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding:10px;}'
    });
    editor = eds?.[0] || null;
    return editor;
  }

  function textToEditorHtml(txt="") {
    const lines = String(txt).replace(/\r/g,"").split("\n");
    let html = "", inList = false;
    const bullet = /^([•\-\u2013\u2014\*]|\d+[.)])\s+(.*)$/;
    for (const raw of lines) {
      const l = raw.trim();
      if (!l) { if (inList) { html += "</ul>"; inList=false; } html += "<p><br></p>"; continue; }
      const m = l.match(bullet);
      if (m) {
        if (!inList) { html += "<ul>"; inList = true; }
        html += `<li>${esc(m[2])}</li>`;
      } else {
        if (inList) { html += "</ul>"; inList=false; }
        html += `<p>${esc(l)}</p>`;
      }
    }
    if (inList) html += "</ul>";
    return html || "<p><br></p>";
  }

  function editorTextOrAfter() {
    const ed = window.tinymce?.get('afterEditor');
    const txt = ed ? ed.getContent({ format: 'text' }).trim() : "";
    return txt || (afterPreview.textContent || resumeText.value || "");
  }

  // ---------- textarea bullets (section-aware) ----------
  function bulletsFromText(txt) {
    const lines = (txt || "").replace(/\r/g,"").split("\n");
    let current = null, out = [];
    for (const raw of lines) {
      const l = raw.trim(); if (!l) continue;
      const maybeHeader = normalizeHeader(l);
      if (HEADERS_CANON.has(maybeHeader)) { current = HEADERS_CANON.get(maybeHeader); continue; }
      if (PROTECTED_SECTIONS.has(current)) continue;
      const m = l.match(/^([•\-\u2013\u2014\*]|\d+[.)])\s+(.*)$/);
      if (m) out.push(m[2]);
    }
    return out;
  }

  function renderChangeCard(item) {
    const before = String(item.original || ""), after = String(item.rewritten || "");
    return `<div class="change-card">
      <div class="change-title">Work Experience</div>
      <div class="muted" style="margin-bottom:4px">Before</div>
      <pre class="mono">${esc(before)}</pre>
      <div style="margin-top:8px" class="muted">After</div>
      <pre class="mono">${esc(after)}</pre>
      <div class="change-reason">${esc(item.reason || "Full rewrite using JD keywords (formatting preserved).")}</div>
    </div>`;
  }

  function rebuildAfterPreview(source, rewrites) {
    let text = source || "";
    for (const r of rewrites) {
      const before = (r.original || "").trim();
      const after = (r.rewritten || "").trim();
      if (!before || !after) continue;
      const pattern = new RegExp(`(^|\\n)\\s*(?:[•\\-\\u2013\\u2014\\*]|\\d+[.)])?\\s*${escapeRegExp(before)}\\s*(?=\\n|$)`, "g");
      text = text.replace(pattern, (m,g1) => `${g1}${after}`);
    }
    return text;
  }

  // ---------- DOCX utils ----------
  const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const XML_NS = "http://www.w3.org/XML/1998/namespace";
  const isBulletLikeText = (s="") => /^[\s\u00A0•◦▪▫■□●○·\-–—]+$/u.test(String(s).replace(/\s+/g," "));

  function nodeHasAncestorTagNS(node, localName, ns) {
    let n = node;
    while (n) { if (n.nodeType===1 && n.localName===localName && n.namespaceURI===ns) return true; n = n.parentNode; }
    return false;
  }

  function paraMeta(xmlDoc, p) {
    const hasNum = !!p.getElementsByTagNameNS(W_NS, "numPr").length ||
      !!Array.from(p.childNodes).find(n => n.namespaceURI===W_NS && n.localName==="pPr" &&
        n.getElementsByTagNameNS(W_NS,"numPr").length);
    const tNodes = Array.from(p.getElementsByTagNameNS(W_NS, "t"));
    const text = tNodes.map(t => t.textContent || "").join("");
    const runs = Array.from(p.getElementsByTagNameNS(W_NS, "r"));
    let firstRun=null, firstRunWithText=null;
    for (const r of runs) {
      if (!firstRun) firstRun = r;
      if (!firstRunWithText && r.getElementsByTagNameNS(W_NS,"t").length) firstRunWithText = r;
      if (firstRun && firstRunWithText) break;
    }
    return { node:p, text:normalizeWS(text), isList:hasNum, firstRun, firstRunWithText, tNodes, section:null };
  }

  function getParagraphs(xmlDoc) {
    return Array.from(xmlDoc.getElementsByTagNameNS(W_NS,"p")).map(p => paraMeta(xmlDoc,p));
  }

  function labelParagraphsWithSections(paragraphs) {
    let current = null;
    for (const p of paragraphs) {
      if (!p.isList && p.text && p.text.length <= 60) {
        const maybe = normalizeHeader(p.text);
        if (HEADERS_CANON.has(maybe)) { current = HEADERS_CANON.get(maybe); p.section = current; continue; }
      }
      p.section = current;
    }
  }

  function ensureTextRun(xmlDoc, pMeta) {
    if (pMeta.tNodes && pMeta.tNodes.length) return pMeta.tNodes;
    const r = xmlDoc.createElementNS(W_NS,"w:r");
    const src = pMeta.firstRunWithText || pMeta.firstRun;
    if (src) { const rPr = src.getElementsByTagNameNS(W_NS,"rPr")[0]; if (rPr) r.appendChild(rPr.cloneNode(true)); }
    const t = xmlDoc.createElementNS(W_NS,"w:t");
    t.setAttributeNS(XML_NS,"xml:space","preserve"); t.textContent = ""; r.appendChild(t);
    const pNode = pMeta.node, pPr = pNode.getElementsByTagNameNS(W_NS,"pPr")[0];
    if (pPr && pPr.nextSibling) pNode.insertBefore(r, pPr.nextSibling); else pNode.appendChild(r);
    return [t];
  }

  // Pour new text across existing non-hyperlink text nodes while preserving prefix punctuation
  function replaceParagraphTextInRuns(xmlDoc, pMeta, newText) {
    const pNode = pMeta.node;
    let tNodes = Array.from(pNode.getElementsByTagNameNS(W_NS,"t"));
    if (!tNodes.length) tNodes = ensureTextRun(xmlDoc, pMeta);

    // Preserve the bullet/number run (if any) by skipping the first <w:t> that is just a symbol/space.
    let startIdx = 0;
    if (tNodes.length) {
      const firstText = tNodes[0].textContent || "";
      if (isBulletLikeText(firstText)) startIdx = 1;
    }

    // Editable nodes before the first hyperlink
    const editable = [];
    for (let i = startIdx; i < tNodes.length; i++) {
      const t = tNodes[i];
      if (nodeHasAncestorTagNS(t, "hyperlink", W_NS)) break;
      editable.push(t);
    }
    if (!editable.length) {
      const r = xmlDoc.createElementNS(W_NS,"w:r");
      const srcRun = pMeta.firstRunWithText || pMeta.firstRun;
      if (srcRun) { const rPr = srcRun.getElementsByTagNameNS(W_NS,"rPr")[0]; if (rPr) r.appendChild(rPr.cloneNode(true)); }
      const t = xmlDoc.createElementNS(W_NS,"w:t"); t.setAttributeNS(XML_NS,"xml:space","preserve"); r.appendChild(t);
      const anchor = tNodes[startIdx-1]?.parentNode || tNodes[0]?.parentNode;
      if (anchor && anchor.nextSibling) pNode.insertBefore(r, anchor.nextSibling); else pNode.appendChild(r);
      tNodes = Array.from(pNode.getElementsByTagNameNS(W_NS,"t"));
      editable.push(tNodes[startIdx]);
    }

    const firstEditableText = editable[0].textContent || "";
    const prefixMatch = firstEditableText.match(/^([\s\u00A0\-\u2013\u2014•◦▪▫·]+)(.*)$/u);
    const prefix = prefixMatch ? prefixMatch[1] : "";
    const combined = prefix + newText;

    // Distribute 'combined' across the editable nodes proportionally to their original lengths
    const originalLens = editable.map(t => (t.textContent || "").length || 1);
    const totalOrig = originalLens.reduce((a,b)=>a+b,0) || 1;
    const totalNew = combined.length;

    let cursor = 0;
    for (let i = 0; i < editable.length; i++) {
      const share = (i === editable.length - 1)
        ? totalNew - cursor
        : Math.max(0, Math.min(totalNew - cursor, Math.round((originalLens[i] / totalOrig) * totalNew)));
      const slice = combined.slice(cursor, cursor + share);
      editable[i].setAttributeNS(XML_NS,"xml:space","preserve");
      editable[i].textContent = slice;
      cursor += share;
    }
  }

  async function buildDocxWithRewrites(buffer, rewrites) {
    const zip = await window.JSZip.loadAsync(buffer);
    const docPath = "word/document.xml";
    const xmlStr = await zip.file(docPath).async("string");

    const xmlDoc = new DOMParser().parseFromString(xmlStr, "application/xml");
    const serializer = new XMLSerializer();

    const paragraphs = getParagraphs(xmlDoc);
    labelParagraphsWithSections(paragraphs);

    const replaced = new Set();
    function bestMatchIndex(originalText) {
      const target = normalizeWS(originalText || "");
      let bestIdx=-1, bestScore=0;

      for (let i=0;i<paragraphs.length;i++){
        if (replaced.has(i)) continue;
        const p = paragraphs[i];
        if (!p.isList) continue;
        if (PROTECTED_SECTIONS.has(p.section)) continue;
        const score = jaccard(target, p.text);
        if (score>bestScore){ bestScore=score; bestIdx=i; }
      }
      if (bestScore>=0.72) return bestIdx;

      bestIdx=-1; bestScore=0;
      for (let i=0;i<paragraphs.length;i++){
        if (replaced.has(i)) continue;
        const p = paragraphs[i];
        if (PROTECTED_SECTIONS.has(p.section)) continue;
        const score = jaccard(target, p.text);
        if (score>bestScore){ bestScore=score; bestIdx=i; }
      }
      return bestScore>=0.92 ? bestIdx : -1;
    }

    for (const r of rewrites || []) {
      const before = String(r.original || "").trim();
      const after  = String(r.rewritten || "").trim();
      if (!before || !after) continue;
      const idx = bestMatchIndex(before);
      if (idx === -1) continue;
      replaceParagraphTextInRuns(xmlDoc, paragraphs[idx], after);
      replaced.add(idx);
    }

    zip.file(docPath, serializer.serializeToString(xmlDoc));
    return await zip.generateAsync({ type: "blob" });
  }

  // ---------- import ----------
  chooseFile.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const f = fileInput.files?.[0]; if (!f) return;
    try {
      const buf = await f.arrayBuffer(); originalDocxBuffer = buf; setFmtState(true);

      // Broadcast original DOCX to the After (DOCX) helper so it can render without re-downloading
      window.dispatchEvent(new CustomEvent("pe:docx-loaded", { detail:{ ab: buf, name: f.name } }));

      // Render a read-only formatted view of the DOCX
      try {
        if (window.docx && docxPreview) {
          docxPreview.innerHTML = "";
          await window.docx.renderAsync(buf, docxPreview, undefined, { ignoreWidth: false, breakPages: true });
        }
      } catch {}

      const zip = await window.JSZip.loadAsync(buf);
      const xmlStr = await zip.file("word/document.xml").async("string");
      const xmlDoc = new DOMParser().parseFromString(xmlStr, "application/xml");
      const paragraphs = getParagraphs(xmlDoc); labelParagraphsWithSections(paragraphs);

      // Only put a "• " in front of real list items we’ll rewrite (not Education/References)
      const plain = paragraphs.map(({text,isList,section}) =>
        (isList && !PROTECTED_SECTIONS.has(section) ? `• ${text}` : text)
      ).join("\n").trim();

      resumeText.value = plain; refreshScore();
    } catch (e) {
      try {
        const arr = await f.arrayBuffer();
        const result = await window.mammoth.convertToHtml({ arrayBuffer: arr });
        const tmp = document.createElement("div"); tmp.innerHTML = result.value || "";
        resumeText.value = (tmp.textContent || tmp.innerText || "").trim();
        setFmtState(true); refreshScore();
      } catch (e2) { setFmtState(false); alert("Failed to read .docx: " + (e?.message || e)); }
    }

    await ensureEditor();
  };

  // ---------- scoring ----------
  function refreshScore() {
    const s = window.computeAtsScore(jobDesc.value || "", resumeText.value || "");
    scoreVal.textContent = (s?.score ?? 0).toFixed(1);
  }
  jobDesc.addEventListener("input", refreshScore);
  resumeText.addEventListener("input", refreshScore);

  // ---------- JD URL fetch ----------
  function looksLikeHttpUrl(u) {
    try { const p = new URL(String(u)); return p.protocol === "http:" || p.protocol === "https:"; }
    catch { return false; }
  }

  fetchJD.onclick = async () => {
    const url = (jdUrl.value || "").trim();
    fetchMsg.textContent = "";
    if (!looksLikeHttpUrl(url)) { fetchMsg.textContent = "Enter a valid http(s) URL."; return; }

    fetchMsg.textContent = "Fetching…";
    try {
      const { data, error } = await supabase.functions.invoke("jd-fetch", { body: { url } });
      if (error) { fetchMsg.textContent = "Server error: " + (error.message || "invoke failed"); return; }

      const title   = String(data?.title || "").trim();
      const company = String(data?.company || "").trim();
      const jdText  = String(data?.jd_text || data?.text || "").trim();

      if (title)   jobTitle.value   = title;
      if (company) jobCompany.value = company;
      if (jdText)  jobDesc.value    = jdText;

      fetchMsg.textContent = jdText ? "Loaded." : "Fetched (no JD text found).";
      refreshScore();
    } catch (e) {
      fetchMsg.textContent = "Error: " + String(e?.message || e);
    }
  };

  // ---------- server call (rewrites) ----------
  autoTailor.onclick = async () => {
    tailorMsg.textContent = ""; changesBox.innerHTML = ""; afterPreview.textContent = "(working…)";
    refreshScore(); await refreshAuthPill();

    const bullets = bulletsFromText(resumeText.value);
    const allowed = window.deriveAllowedVocabFromResume(resumeText.value);

    try {
      const { data, error } = await supabase.functions.invoke("power-edit-suggest", {
        body: {
          job_title: jobTitle.value || "",
          job_company: jobCompany.value || "",
          job_description: jobDesc.value || "",
          resume_plain: resumeText.value || "",
          bullets,
          allowed_vocab: allowed,
          max_words: Math.max(12, Math.min(60, parseInt(document.getElementById("maxWords").value || "28", 10) || 28)),
          mid_sentence_style: "comma",
          dash_threshold_words: 7,
        },
      });
      if (error) { tailorMsg.textContent = "Server error: " + (error.message || "invoke failed"); afterPreview.textContent = "(error)"; lastRewrites = []; return; }

      lastRewrites = Array.isArray(data?.rewrites) ? data.rewrites : [];
      if (!lastRewrites.length) { tailorMsg.textContent = "No eligible rewrite suggestions returned."; afterPreview.textContent = resumeText.value || "(no input)"; return; }

      changesBox.innerHTML = lastRewrites.map(renderChangeCard).join("");
      const afterText = rebuildAfterPreview(resumeText.value, lastRewrites);
      afterPreview.textContent = afterText;

      // Push into the rich editor
      await ensureEditor();
      if (editor) editor.setContent(textToEditorHtml(afterText));

      const gated = data?.stats?.gated ?? 0, took = data?.stats?.took_ms ?? 0;
      tailorMsg.textContent = `Rewrites: ${lastRewrites.length} (gated ${gated}, ${took} ms)`;
    } catch (e) {
      tailorMsg.textContent = "Error: " + String(e?.message || e);
      afterPreview.textContent = "(error)"; lastRewrites = [];
      return;
    }

    // ---- NEW: Kick off server-side DOCX-styled "After" generation that writes a change JSON ----
    // We keep your existing UX, but also trigger a background function that persists a
    // change file to outputs/<uid>/changes/*.json. When it lands, after-docx.js will
    // auto-refresh via events/polling.
    try {
      // Signal kickoff (starts short polling on the viewer)
      window.dispatchEvent(new CustomEvent("jc:autoTailor:kickoff"));

      // Try to persist a server-side change log using current resume in storage.
      const { data: udata } = await supabase.auth.getUser();
      const uid = udata?.user?.id || null;
      let resumeSignedUrl = null;
      if (uid) {
        const sig = await supabase.storage.from("resumes").createSignedUrl(`${uid}/current.docx`, 60);
        resumeSignedUrl = sig?.data?.signedUrl || null;
      }

      // Prefer a dedicated function if present; fall back to the generic drafting endpoint.
      // Expectation: backend writes drafts_index.json and a new changes/<slug>.json, and
      // (optionally) returns { change_file: "xxxx.json" }.
      let resp = await supabase.functions.invoke("power-edit-tailor", {
        body: {
          job_title: jobTitle.value || "",
          job_company: jobCompany.value || "",
          jd_text: jobDesc.value || "",
          resume_signed_url: resumeSignedUrl,
          resume_key: uid ? `${uid}/current.docx` : null
        }
      });

      if (resp.error) {
        // Fallback: ask the generic pipeline to draft for this one JD/resume pair.
        resp = await supabase.functions.invoke("request-draft", {
          body: {
            top: 1,
            context: {
              job_title: jobTitle.value || "",
              job_company: jobCompany.value || "",
              jd_text: jobDesc.value || "",
              resume_key: uid ? `${uid}/current.docx` : null
            }
          }
        });
      }

      if (!resp.error) {
        const changeFile = resp.data?.change_file || resp.data?.changes?.[0] || null;
        if (changeFile) {
          // Tell the viewer exactly which file to render (instant refresh).
          window.dispatchEvent(new CustomEvent("jc:autoTailor:done", { detail:{ change: changeFile } }));
        }
      }
      // If neither endpoint returns a filename, the polling started at kickoff will still catch it.
    } catch {
      // Silent best-effort; the main UX above already completed.
    }
  };

  // ---------- export ----------
  exportDocx.onclick = async () => {
    // If we have the original DOCX and server rewrites, use the format-preserving path.
    if (originalDocxBuffer && lastRewrites?.length) {
      try {
        const blob = await buildDocxWithRewrites(originalDocxBuffer, lastRewrites);
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "Resume-tailored.docx"; a.click(); URL.revokeObjectURL(a.href);
        return;
      } catch (e) { console.warn("Format-preserving export failed; falling back:", e); }
    }

    // Fallback: export current edited text as simple paragraphs
    const { Document, Packer, Paragraph, TextRun } = window.docx || {};
    if (!Document) { alert("docx library not loaded."); return; }
    const finalText = editorTextOrAfter();
    const lines = (finalText || "").split(/\n/);
    const doc = new Document({ sections:[{ properties:{}, children: lines.map(l => new Paragraph({ children:[new TextRun(l)] })) }] });
    const blob = await Packer.toBlob(doc);
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "Resume-edited.docx"; a.click(); URL.revokeObjectURL(a.href);
  };

  // ---------- print ----------
  printPdf.onclick = () => {
    const w = window.open("", "_blank"); if (!w) return;
    w.document.write(`<pre style="white-space:pre-wrap;font:13px ui-monospace">${esc(editorTextOrAfter())}</pre>`);
    w.document.close(); w.focus(); w.print();
  };

  await ensureEditor();
  await refreshAuthPill(); setFmtState(false); refreshScore();
})();
