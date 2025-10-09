// Power Edit client: mirrors Profile's complex rewrite behavior (no insert suggestions).
// Format-preserving .docx export (v4):
// - Education + References are HARD-LOCKED (never rewritten) both in plaintext bullets and DOCX export.
// - Only edit inside existing <w:t> nodes; never remove runs/non-text nodes.
// - Preserve bullet glyph run, hyperlinks (leave <w:hyperlink> text intact), tabs/indents/numPr/fonts/sizes/bold/italics.
// - Prefer list paragraphs when matching; very high fallback threshold to avoid headers.

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

  const HEADERS_CANON = new Map([
    ["education","education"],
    ["references","references"],
    ["reference","references"],
    ["work experience","work experience"],
    ["experience","experience"],
    ["side projects","side projects"],
    ["projects","projects"],
    ["technical skills","technical skills"],
    ["skills","skills"],
    ["certifications","certifications"],
    ["awards","awards"],
    ["publications","publications"],
    ["summary","summary"],
    ["objective","objective"],
    ["profile","profile"],
    ["volunteer experience","volunteer experience"],
    ["volunteering","volunteer experience"],
    ["leadership","leadership"],
    ["additional information","additional information"],
    ["interests","interests"]
  ]);
  const PROTECTED_SECTIONS = new Set(["education", "references"]);

  const normalizeHeader = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/&/g, "and")
      .replace(/[:.]/g, "")
      .replace(/[^a-z\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();

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

  // ---------- plaintext section-aware bullets ----------
  function bulletsFromText(txt) {
    const lines = (txt || "").replace(/\r/g, "").split("\n");

    let current = null;
    const out = [];

    for (let raw of lines) {
      const l = raw.trim();
      if (!l) continue;

      // Section header detection in textarea
      const maybeHeader = normalizeHeader(l);
      if (HEADERS_CANON.has(maybeHeader)) {
        current = HEADERS_CANON.get(maybeHeader);
        continue;
      }

      // Skip protected sections entirely
      if (PROTECTED_SECTIONS.has(current)) continue;

      // Only consider lines that look like bullets in the textarea
      const m = l.match(/^([•\-\u2013\u2014\*]|\d+[.)])\s+(.*)$/);
      if (m) {
        out.push(m[2]);
      }
    }
    return out;
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

  // ---------- rebuild After preview (respect bullets only) ----------
  function rebuildAfterPreview(source, rewrites) {
    let text = source || "";

    // We only injected bullets into the textarea for list items, so replace those.
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

  function isBulletLikeText(s = "") {
    const t = String(s).replace(/\s+/g, "");
    return /^[•◦▪▫■□●○·\-–—]+$/u.test(t);
  }

  function nodeHasAncestorTagNS(node, localName, ns) {
    let n = node;
    while (n) {
      if (n.nodeType === 1 && n.localName === localName && n.namespaceURI === ns) return true;
      n = n.parentNode;
    }
    return false;
  }

  function paraMeta(xmlDoc, p) {
    const isList =
      !!p.getElementsByTagNameNS(W_NS, "numPr").length ||
      !!Array.from(p.childNodes).find(
        (n) =>
          n.namespaceURI === W_NS &&
          n.localName === "pPr" &&
          n.getElementsByTagNameNS(W_NS, "numPr").length
      );

    const tNodes = Array.from(p.getElementsByTagNameNS(W_NS, "t"));
    const textConcat = tNodes.map((t) => t.textContent || "").join("");

    const runs = Array.from(p.getElementsByTagNameNS(W_NS, "r"));
    let firstRun = null, firstRunWithText = null;
    for (const r of runs) {
      if (!firstRun) firstRun = r;
      if (r.getElementsByTagNameNS(W_NS, "t").length > 0 && !firstRunWithText) {
        firstRunWithText = r;
      }
      if (firstRun && firstRunWithText) break;
    }

    return {
      node: p,
      text: normalizeWS(textConcat),
      isList,
      firstRun,
      firstRunWithText,
      tNodes,
      section: null  // to be filled later
    };
  }

  function getParagraphs(xmlDoc) {
    const ps = Array.from(xmlDoc.getElementsByTagNameNS(W_NS, "p"));
    return ps.map((p) => paraMeta(xmlDoc, p));
  }

  function labelParagraphsWithSections(paragraphs) {
    let current = null;
    for (let i = 0; i < paragraphs.length; i++) {
      const p = paragraphs[i];
      let label = null;

      // Header candidates: not list, shortish, and matches known headers
      if (!p.isList && p.text && p.text.length <= 60) {
        const maybe = normalizeHeader(p.text);
        if (HEADERS_CANON.has(maybe)) {
          label = HEADERS_CANON.get(maybe);
          current = label;
          p.section = current;
          continue;
        }
      }
      p.section = current;
    }
  }

  function ensureTextRun(xmlDoc, pMeta) {
    if (pMeta.tNodes && pMeta.tNodes.length) return pMeta.tNodes;

    const r = xmlDoc.createElementNS(W_NS, "w:r");
    const src = pMeta.firstRunWithText || pMeta.firstRun;
    if (src) {
      const rPr = src.getElementsByTagNameNS(W_NS, "rPr")[0];
      if (rPr) r.appendChild(rPr.cloneNode(true));
    }
    const t = xmlDoc.createElementNS(W_NS, "w:t");
    t.setAttributeNS(XML_NS, "xml:space", "preserve");
    t.textContent = "";
    r.appendChild(t);

    const pNode = pMeta.node;
    const pPr = pNode.getElementsByTagNameNS(W_NS, "pPr")[0];
    if (pPr && pPr.nextSibling) {
      pNode.insertBefore(r, pPr.nextSibling);
    } else {
      pNode.appendChild(r);
    }
    return [t];
  }

  function replaceParagraphTextInRuns(xmlDoc, pMeta, newText) {
    const pNode = pMeta.node;
    let tNodes = Array.from(pNode.getElementsByTagNameNS(W_NS, "t"));
    if (!tNodes.length) tNodes = ensureTextRun(xmlDoc, pMeta);

    // Preserve leading bullet-like text node if present
    let startIdx = 0;
    if (tNodes.length) {
      const firstText = tNodes[0].textContent || "";
      if (isBulletLikeText(firstText) || /^\s*[•◦▪▫■□●○·\-–—]\s+$/u.test(firstText)) {
        startIdx = 1;
      }
    }

    // Find first text node that belongs to a hyperlink to keep links unchanged
    let firstHyperIdx = -1;
    for (let i = 0; i < tNodes.length; i++) {
      if (nodeHasAncestorTagNS(tNodes[i], "hyperlink", W_NS)) {
        firstHyperIdx = i;
        break;
      }
    }
    const endIdx = firstHyperIdx >= 0 ? firstHyperIdx : tNodes.length;

    // If everything before the first hyperlink is preserved (e.g., bullet only), create a new t after it
    if (startIdx >= endIdx) {
      const r = xmlDoc.createElementNS(W_NS, "w:r");
      const srcRun = pMeta.firstRunWithText || pMeta.firstRun;
      if (srcRun) {
        const rPr = srcRun.getElementsByTagNameNS(W_NS, "rPr")[0];
        if (rPr) r.appendChild(rPr.cloneNode(true));
      }
      const t = xmlDoc.createElementNS(W_NS, "w:t");
      t.setAttributeNS(XML_NS, "xml:space", "preserve");
      r.appendChild(t);

      const anchorRun = tNodes[0]?.parentNode;
      if (anchorRun && anchorRun.nextSibling) {
        pNode.insertBefore(r, anchorRun.nextSibling);
      } else {
        pNode.appendChild(r);
      }

      // refresh list
      tNodes = Array.from(pNode.getElementsByTagNameNS(W_NS, "t"));
      // set new editable window
      startIdx = Math.min(startIdx + 1, tNodes.length - 1);
    }

    // Fill the first editable t and clear any remaining editable ts up to hyperlink
    tNodes[startIdx].setAttributeNS(XML_NS, "xml:space", "preserve");
    tNodes[startIdx].textContent = newText;

    for (let i = startIdx + 1; i < endIdx; i++) {
      tNodes[i].textContent = "";
    }
    // Do not touch any <w:t> inside hyperlinks (keep link text visible/clickable)
  }

  async function buildDocxWithRewrites(buffer, rewrites) {
    const JSZip = window.JSZip;
    if (!JSZip) throw new Error("JSZip not loaded");

    const zip = await JSZip.loadAsync(buffer);
    const docPath = "word/document.xml";
    const xmlStr = await zip.file(docPath).async("string");

    const xmlDoc = new DOMParser().parseFromString(xmlStr, "application/xml");
    const serializer = new XMLSerializer();

    const paragraphs = getParagraphs(xmlDoc);
    labelParagraphsWithSections(paragraphs);

    const replaced = new Set();

    function bestMatchIndex(originalText) {
      const target = normalizeWS(originalText || "");
      let bestIdx = -1, bestScore = 0;

      // Pass 1: list paragraphs outside protected sections
      for (let i = 0; i < paragraphs.length; i++) {
        if (replaced.has(i)) continue;
        const p = paragraphs[i];
        if (!p.isList) continue;
        if (PROTECTED_SECTIONS.has(p.section)) continue;
        const score = jaccard(target, p.text);
        if (score > bestScore) { bestScore = score; bestIdx = i; }
      }
      if (bestScore >= 0.72) return bestIdx;

      // Pass 2: any paragraph (still exclude protected sections, keep high bar)
      bestIdx = -1; bestScore = 0;
      for (let i = 0; i < paragraphs.length; i++) {
        if (replaced.has(i)) continue;
        const p = paragraphs[i];
        if (PROTECTED_SECTIONS.has(p.section)) continue;
        const score = jaccard(target, p.text);
        if (score > bestScore) { bestScore = score; bestIdx = i; }
      }
      return bestScore >= 0.92 ? bestIdx : -1;
    }

    for (const r of rewrites || []) {
      const before = String(r.original || "").trim();
      const after = String(r.rewritten || "").trim();
      if (!before || !after) continue;

      const idx = bestMatchIndex(before);
      if (idx === -1) continue;

      replaceParagraphTextInRuns(xmlDoc, paragraphs[idx], after);
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

      const zip = await window.JSZip.loadAsync(arrayBuffer);
      const docPath = "word/document.xml";
      const xmlStr = await zip.file(docPath).async("string");
      const xmlDoc = new DOMParser().parseFromString(xmlStr, "application/xml");
      const paragraphs = getParagraphs(xmlDoc);
      labelParagraphsWithSections(paragraphs);

      // Plaintext for editing: add "• " only to actual list items; education/references stay as-is
      const plain = paragraphs
        .map(({ text, isList, section }) => {
          if (isList && !PROTECTED_SECTIONS.has(section)) return `• ${text}`;
          return text;
        })
        .join("\n")
        .trim();

      resumeText.value = plain;
      refreshScore();
    } catch (e) {
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
          bullets,
          allowed_vocab: allowed,
          max_words: Math.max(
            12,
            Math.min(60, parseInt(document.getElementById("maxWords").value || "28", 10) || 28)
          ),
          mid_sentence_style: "comma",
          dash_threshold_words: 7,
        },
      });

      if (error) {
        tailorMsg.textContent = "Server error: " + (error.message || "invoke failed");
        afterPreview.textContent = "(error)";
        lastRewrites = [];
        return;
      }

      const rewrites = Array.isArray(data?.rewrites) ? data.rewrites : [];
      lastRewrites = rewrites;

      if (!rewrites.length) {
        tailorMsg.textContent = "No eligible rewrite suggestions returned.";
        afterPreview.textContent = resumeText.value || "(no input)";
        return;
      }

      changesBox.innerHTML = rewrites.map(renderChangeCard).join("");
      const after = rebuildAfterPreview(resumeText.value, rewrites);
      afterPreview.textContent = after;

      const gated = data?.stats?.gated ?? 0;
      const took = data?.stats?.took_ms ?? 0;
      tailorMsg.textContent = `Rewrites: ${rewrites.length} (gated ${gated}, ${took} ms)`;
    } catch (e) {
      tailorMsg.textContent = "Error: " + String(e?.message || e);
      afterPreview.textContent = "(error)";
      lastRewrites = [];
    }
  };

  // ---------- export .docx ----------
  exportDocx.onclick = async () => {
    if (originalDocxBuffer) {
      try {
        const blob = await buildDocxWithRewrites(originalDocxBuffer, lastRewrites);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "Resume-tailored.docx";
        a.click();
        URL.revokeObjectURL(a.href);
        return;
      } catch (e) {
        console.warn("Format-preserving export failed; falling back:", e);
      }
    }

    // Fallback: simple generator (used only if no .docx uploaded)
    const { Document, Packer, Paragraph, TextRun } = window.docx || {};
    if (!Document) {
      alert("docx library not loaded.");
      return;
    }
    const paraFrom = (line) => new Paragraph({ children: [new TextRun(line)] });

    const lines = (afterPreview.textContent || resumeText.value || "").split(/\n/);
    const doc = new Document({
      sections: [{ properties: {}, children: lines.map(paraFrom) }],
    });

    const blob = await Packer.toBlob(doc);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "Resume-tailored.docx";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // ---------- print / save PDF ----------
  printPdf.onclick = () => {
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(
      `<pre style="white-space:pre-wrap;font:13px ui-monospace">${esc(
        afterPreview.textContent || resumeText.value || ""
      )}</pre>`
    );
    w.document.close();
    w.focus();
    w.print();
  };

  await refreshAuthPill();
  setFmtState(false);
  refreshScore();
})();
