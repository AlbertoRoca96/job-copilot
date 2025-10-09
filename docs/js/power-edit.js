// Power Edit client: mirrors Profile's complex rewrite behavior (no insert suggestions).
// FORMAT-PRESERVING EXPORT: updates text while keeping original runs (<w:r>) and run props (<w:rPr>).
// - Reads .docx (JSZip) OR plaintext (textarea)
// - Computes lightweight ATS score (scoring.js)
// - Calls Edge Function "power-edit-suggest" for bullet rewrites
// - Renders change cards + After preview
// - Export .docx: if an original .docx was loaded, patch word/document.xml in place;
//                 otherwise fall back to simple generator.

(async function () {
  await new Promise((r) => window.addEventListener("load", r));

  // ---------- Supabase ----------
  const SUPABASE_URL = window.SUPABASE_URL;
  const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY;

  const sbLib =
    window.supabase ||
    (await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.js";
      s.defer = true;
      s.onload = () => resolve(window.supabase);
      s.onerror = reject;
      document.head.appendChild(s);
    }));
  const supabase = sbLib.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const chooseFile = $("chooseFile");
  const fileInput = $("fileInput");
  const resumeText = $("resumeText");
  const jobDesc = $("jobDesc");
  const jobTitle = $("jobTitle");
  const jobCompany = $("jobCompany");
  const autoTailor = $("autoTailor");
  const tailorMsg = $("tailorMsg");
  const changesBox = $("changes");
  const afterPreview = $("afterPreview");
  const exportDocx = $("exportDocx");
  const printPdf = $("printPdf");
  const scoreVal = $("scoreVal");
  const signinState = $("signinState");
  const fmtState = $("fmtState");

  // ---------- state ----------
  let originalDocxBuffer = null;   // ArrayBuffer of uploaded .docx
  let lastRewrites = [];           // server rewrites for format-preserving export

  // ---------- helpers ----------
  const esc = (s) =>
    String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const normalizeWS = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const WORD_RE = /[A-Za-z][A-Za-z0-9+./-]{1,}/g;

  function toks(s = "") { return (String(s).toLowerCase().match(WORD_RE) || []); }
  function tokset(s = "") { return new Set(toks(s)); }
  function jaccard(a = "", b = "") {
    const A = tokset(a), B = tokset(b);
    const inter = [...A].filter((x) => B.has(x)).length;
    const uni = new Set([...A, ...B]).size || 1;
    return inter / uni;
  }

  function setFmtState(active) {
    if (active) {
      fmtState.textContent = "Formatting: original preserved";
      fmtState.style.background = "#e8fff1";
    } else {
      fmtState.textContent = "Formatting: simple";
      fmtState.style.background = "#f6f6f6";
    }
  }

  // ---------- auth indicator ----------
  async function refreshAuthPill() {
    try {
      const { data } = await supabase.auth.getSession();
      if (data?.session) {
        signinState.textContent = "Signed in (server boost)";
        signinState.style.background = "#e8fff1";
      } else {
        signinState.textContent = "Anonymous (rate-limited)";
        signinState.style.background = "#fff7e6";
      }
    } catch {
      signinState.textContent = "Anonymous (rate-limited)";
      signinState.style.background = "#fff7e6";
    }
  }

  // ---------- bullets from text ----------
  function bulletsFromText(txt) {
    const lines = (txt || "").replace(/\r/g, "").split("\n").map((l) => l.trim());
    const out = [];
    for (const l of lines) {
      if (!l) continue;
      const m = l.match(/^([•\-\u2013\u2014\*]|\d+[.)])\s+(.*)$/);
      out.push(m ? m[2] : l);
    }
    // drop likely headers
    return out.filter(
      (b) =>
        b.length >= 6 &&
        !/^(education|skills|projects|work experience|experience)$/i.test(b)
    );
  }

  // ---------- change card ----------
  function renderChangeCard(item) {
    const before = String(item.original || "");
    const after = String(item.rewritten || "");
    return `
      <div class="change-card">
        <div class="change-title">Work Experience</div>
        <div class="muted" style="margin-bottom:4px">Before</div>
        <pre class="mono">${esc(before)}</pre>
        <div style="margin-top:8px" class="muted">After</div>
        <pre class="mono">${esc(after)}</pre>
        <div class="change-reason">${esc(
          item.reason ||
            "Full rewrite to compound/complex sentence using JD keywords (formatting preserved)."
        )}</div>
      </div>
    `;
  }

  // ---------- rebuild After preview ----------
  function rebuildAfterPreview(source, rewrites) {
    let text = source || "";
    for (const r of rewrites) {
      const before = (r.original || "").trim();
      const after = (r.rewritten || "").trim();
      if (!before || !after) continue;

      const pattern = new RegExp(
        `(^|\\n)\\s*(?:[•\\-\\u2013\\u2014\\*]|\\d+[.)])?\\s*${escapeRegExp(before)}\\s*(?=\\n|$)`,
        "g"
      );
      text = text.replace(pattern, (m, g1) => `${g1}${after}`);
    }
    return text;
  }

  // ---------- .docx (format-preserving) utilities ----------
  const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const XML_NS = "http://www.w3.org/XML/1998/namespace";

  function getParagraphs(xmlDoc) {
    const ps = Array.from(xmlDoc.getElementsByTagNameNS(W_NS, "p"));
    return ps.map((p) => {
      const tNodes = Array.from(p.getElementsByTagNameNS(W_NS, "t"));
      const text = tNodes.map((t) => t.textContent || "").join("");
      const isList =
        !!p.getElementsByTagNameNS(W_NS, "numPr").length ||
        !!Array.from(p.childNodes).find(
          (n) => n.namespaceURI === W_NS && n.localName === "pPr" &&
                 n.getElementsByTagNameNS(W_NS, "numPr").length
        );
      return { node: p, text: normalizeWS(text), isList };
    });
  }

  // Replace paragraph text while preserving run formatting/hyperlinks when present.
  function replaceParagraphText(xmlDoc, pNode, newText) {
    const tNodes = Array.from(pNode.getElementsByTagNameNS(W_NS, "t"));
    const hasLinkish =
      pNode.getElementsByTagNameNS(W_NS, "hyperlink")?.length > 0 ||
      pNode.getElementsByTagNameNS(W_NS, "fldSimple")?.length > 0 ||
      pNode.getElementsByTagNameNS(W_NS, "instrText")?.length > 0;

    // If we have any runs already (esp. with links/fields), avoid rebuilding.
    if ((hasLinkish && tNodes.length) || tNodes.length > 0) {
      // Put the whole sentence into the first <w:t>, clear the rest.
      // This keeps rPr, hyperlinks, tabs, proofing marks, etc.
      const first = tNodes[0];
      if (first) {
        first.setAttributeNS(XML_NS, "xml:space", "preserve");
        first.textContent = newText;
        for (let i = 1; i < tNodes.length; i++) {
          tNodes[i].textContent = "";
        }
        return;
      }
    }

    // Otherwise rebuild, but carry over the first run's rPr so font/size stay identical.
    let rPrClone = null;
    const firstRunWithText = Array.from(pNode.getElementsByTagNameNS(W_NS, "r")).find(
      (r) => r.getElementsByTagNameNS(W_NS, "t").length
    );
    if (firstRunWithText) {
      const rPr = Array.from(firstRunWithText.childNodes).find(
        (n) => n.nodeType === 1 && n.namespaceURI === W_NS && n.localName === "rPr"
      );
      if (rPr) rPrClone = rPr.cloneNode(true);
    }

    // Keep <w:pPr>, drop other children.
    const kids = Array.from(pNode.childNodes);
    for (const k of kids) {
      const isPPr = k.nodeType === 1 && k.namespaceURI === W_NS && k.localName === "pPr";
      if (!isPPr) pNode.removeChild(k);
    }
    const r = xmlDoc.createElementNS(W_NS, "w:r");
    if (rPrClone) r.appendChild(rPrClone);
    const t = xmlDoc.createElementNS(W_NS, "w:t");
    t.setAttributeNS(XML_NS, "xml:space", "preserve");
    t.textContent = newText;
    r.appendChild(t);
    pNode.appendChild(r);
  }

  async function buildDocxWithRewrites(buffer, rewrites) {
    const JSZip = window.JSZip;
    if (!JSZip) throw new Error("JSZip not loaded");

    // Fresh zip from original buffer each time (avoid cumulative edits)
    const zip = await JSZip.loadAsync(buffer);
    const docPath = "word/document.xml";
    const xmlStr = await zip.file(docPath).async("string");

    const xmlDoc = new DOMParser().parseFromString(xmlStr, "application/xml");
    const serializer = new XMLSerializer();

    const paragraphs = getParagraphs(xmlDoc);
    const replaced = new Set();
    const MIN_SIM = 0.65; // stricter to avoid touching headings/labels

    function bestMatchIndex(originalText) {
      const target = normalizeWS(originalText || "");
      let bestIdx = -1, bestScore = 0;
      for (let i = 0; i < paragraphs.length; i++) {
        if (replaced.has(i)) continue;
        const p = paragraphs[i];
        const score = jaccard(target, p.text) + (p.isList ? 0.06 : 0);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
      return bestScore >= MIN_SIM ? bestIdx : -1;
    }

    for (const r of rewrites || []) {
      const before = String(r.original || "").trim();
      const after = String(r.rewritten || "").trim();
      if (!before || !after) continue;

      const idx = bestMatchIndex(before);
      if (idx === -1) continue;

      replaceParagraphText(xmlDoc, paragraphs[idx].node, after);
      replaced.add(idx);
    }

    const outXml = serializer.serializeToString(xmlDoc);
    zip.file(docPath, outXml);
    return await zip.generateAsync({ type: "blob" });
  }

  // ---------- .docx import ----------
  chooseFile.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    try {
      const arrayBuffer = await f.arrayBuffer();
      originalDocxBuffer = arrayBuffer;
      setFmtState(true);

      // Parse document.xml to derive clean plaintext that mirrors paragraph order.
      const zip = await window.JSZip.loadAsync(arrayBuffer);
      const docPath = "word/document.xml";
      const xmlStr = await zip.file(docPath).async("string");
      const xmlDoc = new DOMParser().parseFromString(xmlStr, "application/xml");
      const paragraphs = getParagraphs(xmlDoc);

      // Prefix list items with • for readability while editing.
      const plain = paragraphs
        .map(({ text, isList }) => (isList ? `• ${text}` : text))
        .join("\n")
        .trim();

      resumeText.value = plain;
      refreshScore();
    } catch (e) {
      // Fallback to Mammoth if direct read fails
      try {
        const arrayBuffer = await f.arrayBuffer();
        const result = await window.mammoth.convertToHtml({ arrayBuffer });
        const html = result.value || "";
        const tmp = document.createElement("div");
        tmp.innerHTML = html;
        const plain = (tmp.textContent || tmp.innerText || "").trim();
        resumeText.value = plain;
        setFmtState(true);
        refreshScore();
      } catch (e2) {
        setFmtState(false);
        alert("Failed to read .docx: " + (e?.message || e));
      }
    }
  };

  // ---------- scoring ----------
  function refreshScore() {
    const s = window.computeAtsScore(jobDesc.value || "", resumeText.value || "");
    scoreVal.textContent = (s?.score ?? 0).toFixed(1);
  }
  jobDesc.addEventListener("input", refreshScore);
  resumeText.addEventListener("input", refreshScore);

  // ---------- server call ----------
  autoTailor.onclick = async () => {
    tailorMsg.textContent = "";
    changesBox.innerHTML = "";
    afterPreview.textContent = "(working…)";

    refreshScore();
    await refreshAuthPill();

    const bullets = bulletsFromText(resumeText.value);
    const allowed = window.deriveAllowedVocabFromResume(resumeText.value);

    try {
      const { data, error } = await supabase.functions.invoke("power-edit-suggest", {
        body: {
          job_title: jobTitle.value || "",
          job_company: jobCompany.value || "",
          job_description: jobDesc.value || "",
          resume_plain: resumeText.value || "",
