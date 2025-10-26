// supabase/functions/assistant/index.ts
// Job Copilot assistant (fixed tool schemas).
// - Robust CORS
// - Always 200 JSON ({reply, actions} or {error})
// - Tool schemas valid for OpenAI (arrays define "items")

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/* ---------------- CORS ---------------- */
const ALLOW_ORIGINS = new Set([
  "https://albertoroca96.github.io",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") || "";
  const vary = "Origin, Access-Control-Request-Headers, Access-Control-Request-Method";
  const h = new Headers({
    "Vary": vary,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json",
  });
  if (origin && ALLOW_ORIGINS.has(origin)) h.set("Access-Control-Allow-Origin", origin);
  h.set(
    "Access-Control-Allow-Headers",
    req.headers.get("Access-Control-Request-Headers") ||
      "authorization, x-client-info, apikey, content-type"
  );
  return h;
}
const ok = (req: Request, payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { headers: corsHeaders(req), status });

/* ---------------- Secrets ---------------- */
const OPENAI_API_KEY   = Deno.env.get("OPENAI_API_KEY")   ?? "";
const TAVILY_API_KEY   = Deno.env.get("TAVILY_API_KEY")   ?? "";
const GITHUB_TOKEN     = Deno.env.get("GITHUB_TOKEN")     ?? "";
const BROWSER_BOT_URL  = Deno.env.get("BROWSER_BOT_URL")  ?? "";
const BROWSER_BOT_AUTH = Deno.env.get("BROWSER_BOT_AUTH") ?? "";
function ensureOpenAI() { if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY"); }

/* ---------------- Helpers ---------------- */
function stripHtml(html: string, max = 4000) {
  const noScripts = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  const text = noScripts.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, max);
}

async function tavilySearch(query: string, maxResults = 5) {
  if (!TAVILY_API_KEY) return { error: "TAVILY_API_KEY not set on server; web_search unavailable." };
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TAVILY_API_KEY}` },
    body: JSON.stringify({ query, include_answer: true, max_results: maxResults }),
  });
  if (!r.ok) throw new Error(`Tavily error: ${await r.text()}`);
  return await r.json();
}

async function fetchPage(url: string, maxChars = 5000) {
  const r = await fetch(url, { redirect: "follow" });
  const ct = r.headers.get("content-type") || "";
  const body = await r.text();
  const text = /html/i.test(ct) ? stripHtml(body, maxChars) : body.slice(0, maxChars);
  return { url, contentType: ct, text, html: /html/i.test(ct) ? body : "" };
}

async function repoTree(owner: string, repo: string, prefix = "") {
  if (!GITHUB_TOKEN) return { error: "GITHUB_TOKEN not set on server; repo_tree unavailable." };
  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/main?recursive=1`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${GITHUB_TOKEN}`,
    },
  });
  if (!r.ok) throw new Error(`GitHub error: ${await r.text()}`);
  const json = await r.json();
  const all = (json.tree || []).map((t: any) => t.path);
  const files = prefix ? all.filter((p: string) => p.startsWith(prefix)) : all;
  return { count: files.length, files: files.slice(0, 400) };
}

function sameOrigin(url: string, origin: string) { try { return new URL(url).origin === origin; } catch { return false; } }

function extractLinksFromHtml(html: string, baseUrl: string) {
  const out: string[] = [];
  const re = /href\s*=\s*["']([^"']+)["']/gi; let m: RegExpExecArray | null;
  while (m = re.exec(html)) { try { out.push(new URL(m[1], baseUrl).href); } catch {} }
  return Array.from(new Set(out));
}

async function siteCrawl(root: string, limit = 12) {
  const first = await fetchPage(root, 6000);
  const origin = new URL(root).origin;
  const links = extractLinksFromHtml(first.html || "", root).filter((u) => sameOrigin(u, origin));
  const uniq = Array.from(new Set([root, ...links])).slice(0, limit);
  const pages = [
    { url: first.url, contentType: first.contentType, text: first.text },
    ...await Promise.all(uniq.slice(1).map((url) =>
      fetchPage(url, 3000).then(p => ({ url: p.url, contentType: p.contentType, text: p.text }))
        .catch(() => ({ url, contentType: "", text: "(fetch failed)" }))
    )),
  ];
  return { pages };
}

async function runBrowserTask(args: any) {
  if (!BROWSER_BOT_URL) return { error: "BROWSER_BOT_URL not set on server; browser_task unavailable." };

  // Map snake_case (tool) -> camelCase (worker)
  const payload = {
    startUrl: args?.start_url || "https://albertoroca96.github.io/job-copilot/",
    steps: Array.isArray(args?.steps) ? args.steps : [],
    timeoutMs: Number(args?.timeout_ms) || 45000,
    viewport: args?.viewport || { width: 1280, height: 900 },
  };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (BROWSER_BOT_AUTH) headers["Authorization"] = BROWSER_BOT_AUTH;

  const r = await fetch(BROWSER_BOT_URL, { method: "POST", headers, body: JSON.stringify(payload) });
  let json: any; try { json = await r.json(); } catch { json = { error: await r.text().catch(() => "unknown error") }; }
  if (!r.ok) return { error: `Browser task error: ${JSON.stringify(json)}` };

  const { finalUrl, results, screenshot } = json || {};
  const html = typeof json?.html === "string" ? String(json.html).slice(0, 8000) : "";
  return { finalUrl, results, screenshot, html };
}

function detectLocalActions(raw: string) {
  const t = (raw || "").toLowerCase(); const out: any[] = [];
  if (/(^| )(home|go home|back to home)( |$)/.test(t)) out.push({ type: "navigate", path: "/job-copilot/", announce: "Going Home." });
  if (/(open|go to).*(power edit)/.test(t)) out.push({ type: "click", text: "Open Power Edit", announce: "Opening Power Edit." });
  if (/(go to|open).*(profile)/.test(t)) out.push({ type: "click", text: "Go to Profile", announce: "Opening Profile." });
  if (/give feedback|open feedback|feedback/.test(t)) out.push({ type: "click", text: "Give Feedback", announce: "Opening Feedback." });
  if (/start editing|start.*editing/.test(t)) out.push({ type: "click", text: "Start editing", announce: "Starting editor." });
  if (/sign in|log in|login/.test(t)) out.push({ type: "click", text: "Sign in", announce: "Opening sign in." });
  if (/scroll to bottom|scroll down/.test(t)) out.push({ type: "scroll", to: "bottom", announce: "Scrolling to bottom." });
  if (/scroll to top|scroll up/.test(t)) out.push({ type: "scroll", to: "top", announce: "Scrolling to top." });
  const m = t.match(/click (the )?(.+)/); if (m) out.push({ type: "click", text: m[2] });
  return out.slice(0, 10);
}

/* ---------------- Chat + tools ---------------- */
async function chatWithTools(messages: any[], tools: any[], model = "gpt-4o-mini", maxIterations = 4) {
  for (let i = 0; i < maxIterations; i++) {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, tools, tool_choice: "auto" }),
    });
    const bodyText = await r.text();
    if (!r.ok) throw new Error(`OpenAI error: ${bodyText}`);
    const data = JSON.parse(bodyText);
    const msg = data.choices?.[0]?.message;

    if (msg?.tool_calls?.length) {
      for (const call of msg.tool_calls) {
        const name = call.function?.name;
        const args = JSON.parse(call.function?.arguments || "{}");
        let result: any = { error: `Unknown tool: ${name}` };
        try {
          if (name === "web_search")        result = await tavilySearch(args.query, args.top_k ?? 5);
          else if (name === "fetch_url")    result = await fetchPage(args.url, args.max_chars ?? 5000);
          else if (name === "repo_tree")    result = await repoTree(args.owner ?? "AlbertoRoca96", args.repo ?? "job-copilot", args.path_prefix ?? "");
          else if (name === "crawl_site")   result = await siteCrawl(args.root ?? "https://albertoroca96.github.io/job-copilot/", args.limit ?? 10);
          else if (name === "propose_dom_actions") {
            // passthrough; client will execute
            result = { accepted: true, count: Array.isArray(args.actions) ? args.actions.length : 0 };
          } else if (name === "browser_task") {
            result = await runBrowserTask(args);
          }
        } catch (e: any) {
          result = { error: String(e?.message || e) };
        }
        messages.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify(result) });
      }
      continue; // loop again
    }

    const finalText = typeof msg?.content === "string" ? msg.content : "(no reply)";
    return { text: finalText };
  }
  return { text: "I ran into a loop while using tools. Please try again." };
}

/* ---------------- Serve ---------------- */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });

  try {
    const body = await req.json().catch(() => ({}));
    const text = (body?.text ?? "").toString();
    const username = (body?.username ?? "there").toString();
    const pageSnapshot = body?.page_snapshot;

    // Cloud runner passthrough
    if (body?.browser_task) {
      if (!BROWSER_BOT_URL) return ok(req, { error: "BROWSER_BOT_URL not set; cannot run browser_task." });
      const h: Record<string, string> = { "Content-Type": "application/json" };
      if (BROWSER_BOT_AUTH) h["Authorization"] = BROWSER_BOT_AUTH;
      const r = await fetch(BROWSER_BOT_URL, { method: "POST", headers: h, body: JSON.stringify(body.browser_task) });
      let json: any; try { json = await r.json(); } catch { json = { error: await r.text() }; }
      return ok(req, { status: r.status, ...json });
    }

    // Cheap greet (no OpenAI)
    if (body?.greet) return ok(req, { reply: `Hello ${username}, how may I assist you today?` });

    ensureOpenAI();

    const SITE_HINT = `
Known pages:
- Home → "/job-copilot/"
- Profile → "/job-copilot/#profile"
- Power Edit → via the "Open Power Edit" button on Home
Prefer proposing SAFE DOM actions by visible text. Keep plans short.`.trim();

    const SYSTEM = {
      role: "system",
      content:
        "You are Job Copilot. Be concise, friendly, and proactive. You can use tools to search the web, fetch pages, " +
        "crawl the site, list repo files, and (optionally) run a remote browser via browser_task. " + SITE_HINT,
    };
    const USER = { role: "user", content: text || "Say hello." };
    const CONTEXT = pageSnapshot
      ? [{ role: "system", content: `CURRENT PAGE: ${pageSnapshot.url || ""}\nTITLE: ${pageSnapshot.title || ""}\nTEXT: ${pageSnapshot.text?.slice(0, 2000) || ""}` }]
      : [];

    /* ---------- TOOL SCHEMAS (fixed) ---------- */
    const tools = [
      {
        type: "function",
        function: {
          name: "web_search",
          description: "High quality web search (Tavily). Use for news, docs, tutorials.",
          parameters: {
            type: "object",
            properties: {
              query:  { type: "string", description: "Search query" },
              top_k:  { type: "integer", minimum: 1, maximum: 10, default: 5 }
            },
            required: ["query"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "fetch_url",
          description: "Fetch a URL and return plain text (HTML stripped).",
          parameters: {
            type: "object",
            properties: {
              url:       { type: "string" },
              max_chars: { type: "integer", minimum: 500, maximum: 20000, default: 5000 }
            },
            required: ["url"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "repo_tree",
          description: "List files in a GitHub repo tree (main branch).",
          parameters: {
            type: "object",
            properties: {
              owner:       { type: "string", default: "AlbertoRoca96" },
              repo:        { type: "string", default: "job-copilot" },
              path_prefix: { type: "string", description: "Only include files under this path" }
            }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "crawl_site",
          description: "Shallow crawl of the site (root + same-origin links).",
          parameters: {
            type: "object",
            properties: {
              root:  { type: "string", default: "https://albertoroca96.github.io/job-copilot/" },
              limit: { type: "integer", minimum: 1, maximum: 20, default: 10 }
            }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "propose_dom_actions",
          description: "Plan SAFE client actions (navigate/click/input/scroll/focus/announce/snapshot).",
          parameters: {
            type: "object",
            properties: {
              actions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    type:     { type: "string", enum: ["navigate","click","input","scroll","focus","announce","snapshot"] },
                    url:      { type: "string" },
                    path:     { type: "string" },
                    name:     { type: "string" },
                    selector: { type: "string" },
                    text:     { type: "string" },
                    value:    { type: "string" },
                    to:       { type: "string", enum: ["top","bottom"] },
                    y:        { type: "number" },
                    announce: { type: "string" },
                    placeholder: { type: "string" }
                  },
                  required: ["type"]
                }
              }
            },
            required: ["actions"]
          }
        }
      },
      {
        // *** FIXED: array has "items" with a concrete object schema ***
        type: "function",
        function: {
          name: "browser_task",
          description: "Run scripted steps in a remote headless Chromium via Cloudflare Worker.",
          parameters: {
            type: "object",
            properties: {
              start_url: { type: "string", description: "Starting URL" },
              steps: {
                type: "array",
                description: "Sequence of browser steps",
                items: {
                  type: "object",
                  properties: {
                    action: { type: "string", enum: [
                      "goto",          // {url}
                      "clickText",     // {text}
                      "clickSelector", // {selector}
                      "fill",          // {selector, value}
                      "press",         // {key}
                      "waitFor",       // {ms}
                      "scroll",        // {to|y}
                      "screenshot",    // {}
                      "extractHtml"    // {}
                    ] },
                    url:      { type: "string" },
                    text:     { type: "string" },
                    selector: { type: "string" },
                    value:    { type: "string" },
                    key:      { type: "string" },
                    ms:       { type: "integer", minimum: 0 },
                    to:       { type: "string", enum: ["top","bottom"] },
                    y:        { type: "number" }
                  },
                  required: ["action"]
                }
              },
              timeout_ms: { type: "integer", minimum: 1000, default: 45000 },
              viewport: {
                type: "object",
                properties: {
                  width:  { type: "integer", minimum: 100, default: 1280 },
                  height: { type: "integer", minimum: 100, default: 900 }
                }
              }
            },
            required: ["steps"]
          }
        }
      }
    ];
    /* ---------- /TOOLS ---------- */

    const { text: reply } = await chatWithTools([SYSTEM, ...CONTEXT, USER], tools);
    const localPlan = detectLocalActions(text);
    return ok(req, { reply, actions: localPlan });
  } catch (e: any) {
    return ok(req, { error: String(e?.message || e) });
  }
});
