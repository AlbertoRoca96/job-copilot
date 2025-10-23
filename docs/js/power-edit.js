// js/power-edit.js
// v=2025-10-24-oneeditor
//
// Power Edit client (JD-URL fetch + ATS scoring + formatted DOCX preview).
// Format-preserving DOCX export (v6):
// - Education + References are HARD-LOCKED.
// - Only write inside existing <w:t xml:space="preserve"> nodes (never delete runs).
// - Preserve: bullet/numbering, leading punctuation, hyperlinks,
//             run boundaries (pour new text across original non-link runs).
// NEW:
// - The “After (DOCX styles)” pane is the ONLY editor (contenteditable).
// - Export pulls diffs directly from that pane.
// - Auto-tailor immediately re-renders the styled “After” with results.

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
  const exportDocx   = $("exportDocx");
  const printPdf     = $("printPdf");
  const scoreVal     = $("scoreVal");
  const signinState  = $("signinState");
  const fmtState     = $("fmtState");
  const docxPreview  = $("docxPreview");

  // Primary (styled) editor elements
  const afterDocx    = $("afterDocx")    || $("afterDocxPE");
  const afterDocxMsg = $("afterDocxMsg") || $("afterDocxMsgPE");
  const afterChange  = $("afterChange")  || $("afterChangePE");

  // ---------- state ----------
  let originalDocxBuffer = null; // used by export + After pane
  let lastRewrites = [];

  // ---------- helpers ----------
  const esc = (s) => String(s || "").replace(/[&<>]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;" }[c]));
  const normalizeWS = (s) => String(s || "").replace(/\s+/g, " ").trim();
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

  async function getUser(){ try { return (await supabase.auth.getUser())?.data?.user || null; } catch { return null; } }
  async function sign(bucket, key, expires=60){
    try {
      const { data, error } = await supabase.storage.from(bucket).createSignedUrl(key, expires);
      return error ? null : data?.signedUrl || null;
    } catch { return null; }
  }
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

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
    const before = String(item.original || item.original_paragraph_text || item.anchor || "");
    const after  = String(item.rewritten || item.modified_paragraph_text || (before && item.inserted_sentence ? `${before} ${item.inserted_sentence}` : "") || "");
    return `<div class="change-card">
      <div class="change-title">Work Experience</div>
      <div class="muted" style="margin-bottom:4px">Before</div>
      <pre class="mono">${esc(before)}</pre>
      <div style="margin-top:8px" class="muted">After</div>
      <pre class="mono">${esc(after)}</pre>
      <div class="change-reason">${esc(item.reason || "Full rewrite using JD keywords (formatting preserved).")}</div>
    </div>`;
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

    // Preserve bullet/number run (if any) by skipping the first <w:t> that is just a symbol/space.
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

    // Distribute 'combined' across the editable nodes proportionally
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

      // 1) prefer bullet/list paragraphs
      for (let i=0;i<paragraphs.length;i++){
        if (replaced.has(i)) continue;
        const p = paragraphs[i];
        if (!p.isList) continue;
        if (PROTECTED_SECTIONS.has(p.section)) continue;
        const score = jaccard(target, p.text);
        if (score>bestScore){ bestScore=score; bestIdx=i; }
      }
      if (bestScore>=0.72) return bestIdx;

      // 2) fallback: any paragraph (except protected)
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

    for (const r of (rewrites || [])) {
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

      // let the After pane reuse this buffer without re-fetching
      window.dispatchEvent(new CustomEvent("pe:docx-loaded", { detail:{ ab: buf } }));

      // Render a read-only formatted view of the DOCX
      try {
        if (window.docx && docxPreview) {
          docxPreview.innerHTML = "";
          await window.docx.renderAsync(buf, docxPreview, undefined, { ignoreWidth: false, breakPages: true });
        }
      } catch {}

      // Extract plaintext for ATS + tailoring
      const zip = await window.JSZip.loadAsync(buf);
      const xmlStr = await zip.file("word/document.xml").async("string");
      const xmlDoc = new DOMParser().parseFromString(xmlStr, "application/xml");
      const paragraphs = getParagraphs(xmlDoc); labelParagraphsWithSections(paragraphs);

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

  // ---------- Styled AFTER (DOCX) ----------
  async function ensureOriginalDocxBuffer() {
    if (originalDocxBuffer) return originalDocxBuffer;
    const u = await getUser(); if (!u) return null;
    const url = await sign("resumes", `${u.id}/current.docx`, 60);
    if (!url) return null;
    try {
      const r = await fetch(url, { cache:"no-store" });
      if (!r.ok) return null;
      originalDocxBuffer = await r.arrayBuffer();
      setFmtState(true);
      return originalDocxBuffer;
    } catch { return null; }
  }

  // ---------- server call (rewrites) ----------
  autoTailor.onclick = async () => {
    tailorMsg.textContent = ""; changesBox.innerHTML = "";
    window.dispatchEvent(new CustomEvent("jc:autoTailor:kickoff")); // notify pane poller
    await refreshAuthPill();
    if (afterDocxMsg) afterDocxMsg.textContent = "Generating rewrites…";

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
      if (error) { tailorMsg.textContent = "Server error: " + (error.message || "invoke failed"); afterDocxMsg && (afterDocxMsg.textContent = "(error)"); lastRewrites = []; return; }

      lastRewrites = Array.isArray(data?.rewrites) ? data.rewrites : [];
      if (!lastRewrites.length) {
        tailorMsg.textContent = "No eligible rewrite suggestions returned.";
        afterDocxMsg && (afterDocxMsg.textContent = "No changes to apply.");
        window.dispatchEvent(new CustomEvent("jc:autoTailor:done"));
        return;
      }

      // Change log cards
      changesBox.innerHTML = lastRewrites.map(renderChangeCard).join("");

      const gated = data?.stats?.gated ?? 0, took = data?.stats?.took_ms ?? 0;
      tailorMsg.textContent = `Rewrites: ${lastRewrites.length} (gated ${gated}, ${took} ms)`;

      // Immediately render into the live styled editor
      const ab = await ensureOriginalDocxBuffer();
      if (ab && afterDocx && window.AfterDocxHelper) {
        await window.AfterDocxHelper.renderAndPatch(ab, afterDocx, lastRewrites);
        afterDocxMsg && (afterDocxMsg.textContent = "");
      }

      // Also notify the pane listener (so dropdown / saved file mode stays in sync)
      window.dispatchEvent(new CustomEvent("jc:autoTailor:done", { detail: { rewrites: lastRewrites } }));
    } catch (e) {
      tailorMsg.textContent = "Error: " + String(e?.message || e);
      afterDocxMsg && (afterDocxMsg.textContent = "(error)");
      lastRewrites = [];
      window.dispatchEvent(new CustomEvent("jc:autoTailor:done"));
    }
  };

  // ---------- export ----------
  exportDocx.onclick = async () => {
    // Preferred: export using live inline edits captured from the styled pane
    try {
      const ab = await ensureOriginalDocxBuffer();
      const styledRoot = afterDocx;
      if (ab && styledRoot && window.AfterDocxHelper) {
        const paneRewrites = window.AfterDocxHelper.getRewrites(styledRoot);
        if (paneRewrites.length){
          const blob = await buildDocxWithRewrites(ab, paneRewrites);
          const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "Resume-tailored.docx"; a.click(); URL.revokeObjectURL(a.href);
          return;
        }
      }
    } catch (e) { console.warn("Styled-pane export failed, trying server rewrites:", e); }

    // Fallback: apply last server rewrites
    if (originalDocxBuffer && lastRewrites?.length) {
      try {
        const blob = await buildDocxWithRewrites(originalDocxBuffer, lastRewrites);
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "Resume-tailored.docx"; a.click(); URL.revokeObjectURL(a.href);
        return;
      } catch (e) { console.warn("Format-preserving export failed; fallback skipped:", e); }
    }

    alert("Nothing to export yet — upload a .docx and make or accept edits first.");
  };

  // ---------- print ----------
  printPdf.onclick = () => {
    const w = window.open("", "_blank"); if (!w) return;
    const styledRoot = afterDocx?.cloneNode(true);
    if (styledRoot && styledRoot.querySelector(".page")) {
      styledRoot.querySelectorAll("[contenteditable]").forEach(n=>n.removeAttribute("contenteditable"));
      w.document.write(`<div>${styledRoot.innerHTML}</div>`);
    } else {
      w.document.write(`<pre style="white-space:pre-wrap;font:13px ui-monospace">${esc(resumeText.value || "")}</pre>`);
    }
    w.document.close(); w.focus(); w.print();
  };

  // ---------- initial boot ----------
  await refreshAuthPill(); setFmtState(false); refreshScore();
})();

/* -----------------------------------------------------------------------
   Helper (inlined): AfterDocxHelper
   - renderAndPatch(arrayBuffer, rootEl, changes[]):
       Renders DOCX to HTML via docx-preview and applies change entries.
       Makes paragraphs inline-editable and snapshots orig/current text.
   - getRewrites(rootEl) -> [{original, rewritten}] from inline edits.
------------------------------------------------------------------------ */
(function (w) {
  const NS = {};
  const norm = (s="") => String(s).replace(/[–—]/g,"-").replace(/\s+/g," ").trim();
  const plain = (s="") => String(s).replace(/\s+/g," ").trim();

  function collectParas(root){ return Array.from(root.querySelectorAll("p, li")); }

  function snapshotOriginal(root){
    const paras = collectParas(root);
    paras.forEach((p,i)=>{
      p.dataset.pid = String(i);
      p.dataset.orig = plain(p.textContent || "");
      p.dataset.current = p.dataset.orig;
      p.setAttribute("contenteditable","true");
      p.setAttribute("spellcheck","false");
      p.tabIndex = 0;
    });
  }

  function onInput(e){
    const n = e.target; if (!n || !n.dataset) return;
    n.dataset.current = plain(n.textContent || "");
  }

  function makeEditable(root, onChange){
    root.addEventListener("input", (ev)=>{ onInput(ev); if (typeof onChange==="function") onChange(ev); });
  }

  function canonicalizeChanges(changes){
    const arr = Array.isArray(changes) ? changes : [];
    const out = [];
    for (const ch of arr){
      const before =
        ch.original_paragraph_text ?? ch.original ?? ch.anchor ?? "";
      let after =
        ch.modified_paragraph_text ?? ch.rewritten ?? "";
      if (!after && ch.inserted_sentence && before){
        after = plain(before + " " + ch.inserted_sentence);
      }
      const b = plain(before), a = plain(after);
      if (b && a && b !== a) out.push({before:b, after:a});
    }
    return out;
  }

  function applyChangesToRenderedDocx(root, changes){
    const edits = canonicalizeChanges(changes);
    if (!edits.length) return;
    const paras = collectParas(root);
    const bucket = new Map();
    for (const p of paras){
      const t = norm(p.textContent || "");
      if (!t) continue;
      if (!bucket.has(t)) bucket.set(t, []);
      bucket.get(t).push(p);
    }
    for (const {before,after} of edits){
      const key = norm(before);
      let candidates = bucket.get(key);
      if (!candidates || !candidates.length){
        candidates = paras.filter(p => norm(p.textContent || "").includes(key));
      }
      if (!candidates.length) continue;
      const p = candidates.shift();
      p.textContent = after;
      if (p.dataset) p.dataset.current = plain(after);
    }
  }

  async function renderAndPatch(ab, root, changes){
    root.innerHTML = "";
    await w.docx.renderAsync(
      ab, root, null,
      { className:"docx", inWrapper:true, breakPages:true, ignoreFonts:false, trimXmlDeclaration:true }
    );
    snapshotOriginal(root); // capture BEFORE applying patches
    if (changes && changes.length) applyChangesToRenderedDocx(root, changes);
    makeEditable(root);
  }

  function getRewrites(root){
    const out = [];
    collectParas(root).forEach(p=>{
      const orig = plain(p.dataset?.orig || "");
      const cur  = plain(p.dataset?.current || plain(p.textContent || ""));
      if (orig && cur && orig !== cur) out.push({ original: orig, rewritten: cur });
    });
    return out;
  }

  NS.renderAndPatch = renderAndPatch;
  NS.applyChangesToRenderedDocx = applyChangesToRenderedDocx;
  NS.getRewrites = getRewrites;
  NS.canonicalizeChanges = canonicalizeChanges;

  w.AfterDocxHelper = NS;
})(window);
