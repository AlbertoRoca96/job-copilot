// docs/js/power-edit.js
// Power Edit client: mirrors Profile's complex rewrite behavior (no insert suggestions).
// - Reads .docx (mammoth) OR plaintext
// - Computes lightweight ATS score (scoring.js)
// - Calls Edge Function "power-edit-suggest" for bullet rewrites
// - Renders change cards + After preview; export .docx / print

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

  // ---------- helpers ----------
  const esc = (s) =>
    String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const normalizeWS = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

  // ---------- .docx import ----------
  chooseFile.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    try {
      const arrayBuffer = await f.arrayBuffer();
      const result = await window.mammoth.convertToHtml({ arrayBuffer });
      const html = result.value || "";
      const tmp = document.createElement("div");
      tmp.innerHTML = html;
      const plain = tmp.textContent || tmp.innerText || "";
      resumeText.value = plain.trim();
      refreshScore();
    } catch (e) {
      alert("Failed to read .docx: " + (e?.message || e));
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
        return;
      }

      const rewrites = Array.isArray(data?.rewrites) ? data.rewrites : [];
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
    }
  };

  // ---------- export .docx ----------
  exportDocx.onclick = async () => {
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
  refreshScore();
})();
