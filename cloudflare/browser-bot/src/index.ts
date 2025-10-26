// Route: POST /run
// Requires a Browser Rendering binding named BROWSER.
// Deploy via Workers → Connect to Git with root directory set to cloudflare/browser-bot
import puppeteer from "@cloudflare/puppeteer";

export default {
  async fetch(request: Request, env: any) {
    const { pathname } = new URL(request.url);
    if (request.method !== "POST" || pathname !== "/run") {
      return new Response(JSON.stringify({ error: "POST /run only" }), {
        status: 404, headers: { "content-type": "application/json" }
      });
    }

    let payload: any = {};
    try { payload = await request.json(); } catch {}

    const {
      startUrl = "https://albertoroca96.github.io/job-copilot/",
      steps = [],                 // [{action:'goto'|'clickText'|'fill'|'press'|'waitFor'|'scroll', ...}]
      timeoutMs = 45000,
      viewport = { width: 1280, height: 900 },
    } = payload;

    const browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setViewport(viewport);

    const results: any[] = [];
    try {
      if (!steps[0] || steps[0].action !== "goto") {
        await page.goto(startUrl, { waitUntil: "load", timeout: timeoutMs });
      }

      async function clickByText(txt: string) {
        // Prefer ARIA roles first
        const btn = page.getByRole("button", { name: new RegExp(txt, "i") });
        if (await btn.count()) return await btn.first().click({ timeout: timeoutMs });

        const link = page.getByRole("link", { name: new RegExp(txt, "i") });
        if (await link.count()) return await link.first().click({ timeout: timeoutMs });

        await page.getByText(new RegExp(txt, "i")).first().click({ timeout: timeoutMs });
      }

      for (const step of steps) {
        const s = { ...step };
        if (s.action === "goto") {
          await page.goto(s.url, { waitUntil: "load", timeout: timeoutMs });
          results.push({ ok: true, action: s.action, url: page.url() });
        } else if (s.action === "clickText") {
          await clickByText(s.text);
          results.push({ ok: true, action: s.action, text: s.text, url: page.url() });
        } else if (s.action === "fill") {
          if (s.selector) {
            await page.fill(s.selector, s.value ?? "", { timeout: timeoutMs });
          } else if (s.placeholder) {
            await page.getByPlaceholder(new RegExp(s.placeholder, "i"))
              .fill(s.value ?? "", { timeout: timeoutMs });
          } else {
            throw new Error("fill: require selector or placeholder");
          }
          results.push({ ok: true, action: s.action });
        } else if (s.action === "press") {
          await page.keyboard.press(s.key, { timeout: timeoutMs });
          results.push({ ok: true, action: s.action, key: s.key });
        } else if (s.action === "waitFor") {
          if (s.selector) await page.waitForSelector(s.selector, { timeout: timeoutMs });
          if (s.timeMs) await page.waitForTimeout(s.timeMs);
          results.push({ ok: true, action: s.action });
        } else if (s.action === "scroll") {
          if (typeof s.y === "number") {
            await page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" }), s.y);
          } else if (s.to === "bottom") {
            await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }));
          } else {
            await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
          }
          results.push({ ok: true, action: s.action });
        } else {
          results.push({ ok: false, action: s.action, error: "Unknown action" });
        }
      }

      const html = await page.content();
      const finalUrl = page.url();
      const shot = await page.screenshot({ type: "png" });
      const b64 = arrayBufferToBase64(shot as ArrayBuffer);

      await browser.close();
      return new Response(JSON.stringify({
        ok: true, finalUrl, results, html, screenshot: `data:image/png;base64,${b64}`
      }), { headers: { "content-type": "application/json" } });
    } catch (e: any) {
      try { await browser.close(); } catch {}
      return new Response(JSON.stringify({
        ok: false, error: String(e?.message || e), results
      }), { status: 500, headers: { "content-type": "application/json" } });
    }
  }
};

function arrayBufferToBase64(ab: ArrayBuffer) {
  let binary = "";
  const bytes = new Uint8Array(ab);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
