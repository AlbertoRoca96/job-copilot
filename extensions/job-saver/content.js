// content.js - scrape common job page fields

function pick(selArr) {
  for (const sel of selArr) {
    const el = document.querySelector(sel);
    if (el && el.textContent) return el.textContent.trim();
  }
  return "";
}
function og(name){
  const el = document.querySelector(`meta[property="og:${name}"]`) || document.querySelector(`meta[name="${name}"]`);
  return el?.getAttribute("content") || "";
}

function scrape(){
  const url = location.href;
  // heuristics per ATS
  const title = pick(["h1", ".posting-headline h2", ".posting-title", ".job-title", "h2"]);
  const company = og("site_name") || pick([".company", ".company-name", ".posting-category .company", ".app-name"]);
  const location = pick([".location", ".posting-location", ".job-location", ".sort-by-location", "li:has(svg[aria-label*=location])"]);
  // description
  const descEl = document.querySelector("article, .content, #content, .section-wrapper, .posting, .job, .description, .job-description");
  const description = (descEl?.innerText || document.body.innerText || "").trim().slice(0, 20000);
  // source hint
  let source = "web";
  if (/greenhouse\.io/i.test(url)) source = "greenhouse";
  else if (/lever\.co/i.test(url)) source = "lever";
  else if (/ashbyhq\.com/i.test(url)) source = "ashby";
  else if (/workday/i.test(url)) source = "workday";

  return { url, title, company, location, description, source };
}

const payload = scrape();
chrome.runtime.sendMessage({ type: "SCRAPE_RESULT", payload });
