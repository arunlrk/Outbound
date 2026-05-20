// scrape_saved_leads.js
// One-time script: scrapes all saved leads from Sales Nav, filters out already-enriched,
// saves to leads.json, then runs email_finder.js automatically.

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const CHROME_SRC_PROFILE = 'C:\\Users\\arunl\\AppData\\Local\\Google\\Chrome\\User Data\\Default';
const TEMP_PROFILE_DIR   = 'C:\\Users\\arunl\\AppData\\Local\\Temp\\linkedin_playwright';
const LEADS_FILE         = path.join(__dirname, 'data', 'leads.json');

const SAVED_LEADS_URL = 'https://www.linkedin.com/sales/search/people?query=(filters%3AList((type%3ASAVED_LEADS_AND_ACCOUNTS%2Cvalues%3AList((id%3ASL%2CselectionType%3AINCLUDED)))))&sessionId=KAOX4945Q3WASkAhvd0EFw%3D%3D';

function copyProfile() {
  const dest = path.join(TEMP_PROFILE_DIR, 'Default');
  if (fs.existsSync(dest)) { console.log('♻️  Reusing existing temp profile.'); return; }
  console.log('📋 Copying Chrome profile (one-time)...');
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(CHROME_SRC_PROFILE, dest, {
    recursive: true, errorOnExist: false,
    filter: src => !['GPUCache','ShaderCache','Code Cache','Cache','CacheStorage'].some(s => src.includes(s)),
  });
  console.log('✅ Profile copied.\n');
}

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function sleep(ms, jitter = 0) { return new Promise(r => setTimeout(r, ms + rand(0, jitter))); }


async function waitForResults(page) {
  const selectors = [
    '[data-anonymize="person-name"]',
    '.artdeco-entity-lockup__title',
    '[data-view-name="search-results-lead-row"]',
    'ol.artdeco-list li',
  ];
  for (const sel of selectors) {
    const found = await page.waitForSelector(sel, { timeout: 20000 }).catch(() => null);
    if (found) return true;
  }
  return false;
}

async function collectLeads(page) {
  return page.evaluate(() => {
    const results = [];
    const seenNames = new Set();

    // ── Pass 1: People — anchor off /sales/lead/ links ────────────────────────
    const profileLinks = [...document.querySelectorAll('a[href*="/sales/lead/"]')];
    for (const link of profileLinks) {
      let row = link;
      for (let i = 0; i < 8; i++) {
        if (!row.parentElement) break;
        row = row.parentElement;
        if (row.tagName === 'LI' || row.getAttribute('data-view-name') === 'search-results-lead-row') break;
      }
      const nameEl    = row.querySelector('[data-anonymize="person-name"]') ||
                        link.querySelector('span[aria-hidden="true"]') ||
                        link.querySelector('span');
      const titleEl   = row.querySelector('[data-anonymize="title"]') ||
                        row.querySelector('.artdeco-entity-lockup__subtitle span:first-child');
      const companyEl = row.querySelector('[data-anonymize="company-name"]') ||
                        row.querySelector('.artdeco-entity-lockup__subtitle a');
      const name = nameEl?.textContent?.trim();
      if (name && name.length > 1 && !/^(see|view|connect|follow|save|more)/i.test(name) && !seenNames.has(name)) {
        seenNames.add(name);
        results.push({
          name,
          title:      titleEl?.textContent?.trim()  || 'tech leader',
          company:    companyEl?.textContent?.trim() || 'your company',
          profileUrl: link.href || null,
          type:       'person',
        });
      }
    }

    // ── Pass 2: Company accounts — li rows with /sales/company/ but no /sales/lead/ ──
    const allRows = [
      ...document.querySelectorAll('[data-view-name="search-results-lead-row"]'),
      ...document.querySelectorAll('ol.artdeco-list > li'),
      ...document.querySelectorAll('ul.artdeco-list > li'),
      ...document.querySelectorAll('li.artdeco-list__item'),
    ];
    for (const row of [...new Set(allRows)]) {
      if (row.querySelector('a[href*="/sales/lead/"]')) continue; // already handled in pass 1
      const companyLink = row.querySelector('a[href*="/sales/company/"]');
      if (!companyLink) continue;
      const nameEl = row.querySelector('[data-anonymize="company-name"]') ||
                     row.querySelector('.artdeco-entity-lockup__title a span') ||
                     companyLink.querySelector('span[aria-hidden="true"]') ||
                     companyLink.querySelector('span');
      const name = nameEl?.textContent?.trim();
      if (name && name.length > 1 && !/^(see|view|connect|follow|save|more)/i.test(name) && !seenNames.has(name)) {
        seenNames.add(name);
        results.push({
          name,
          title:      'Company',
          company:    name,
          profileUrl: companyLink.href || null,
          type:       'company',
        });
      }
    }

    return results;
  });
}

async function main() {
  copyProfile();

  console.log('🚀 Launching Chrome...');
  const context = await chromium.launchPersistentContext(TEMP_PROFILE_DIR, {
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: false,
    viewport: null,
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  const page = context.pages()[0] || await context.newPage();

  console.log('📂 Navigating to Saved Leads...');
  await page.goto(SAVED_LEADS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000, 1500);

  if (page.url().includes('login')) {
    console.log('\n🔐 Please log in. Waiting up to 3 min...\n');
    await page.waitForFunction(() => !window.location.href.includes('login'), { timeout: 180000, polling: 2000 });
    await page.goto(SAVED_LEADS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(4000, 2000);
    console.log('✅ Logged in!\n');
  }

  const loaded = await waitForResults(page);
  if (!loaded) {
    await page.screenshot({ path: path.join(__dirname, 'logs', 'linkedin_debug.png') });
    console.log('❌ Results did not load. Screenshot saved.');
    await context.close(); return;
  }

  const allLeads = [];
  let pageNum = 1;

  while (true) {
    console.log(`\n🔍 Scraping page ${pageNum}...`);
    await sleep(2500, 1000); // extra wait for page to fully render

    // Scroll down incrementally to trigger lazy-loading of all rows
    let lastCount = 0, stableRounds = 0;
    for (let attempt = 0; attempt < 15; attempt++) {
      await page.mouse.wheel(0, 500);
      await sleep(900, 400);
      const count = await page.locator('li.artdeco-list__item').count();
      console.log(`   (scroll ${attempt + 1}: ${count} rows visible)`);
      if (count === lastCount) { stableRounds++; if (stableRounds >= 3) break; }
      else stableRounds = 0;
      lastCount = count;
    }
    await page.mouse.wheel(0, -9999); // scroll back to top
    await sleep(800);

    // Debug: count lead vs company links
    const linkCounts = await page.evaluate(() => ({
      leads:     document.querySelectorAll('a[href*="/sales/lead/"]').length,
      companies: document.querySelectorAll('a[href*="/sales/company/"]').length,
    }));
    console.log(`   (lead links: ${linkCounts.leads}, company links: ${linkCounts.companies})`);

    const leads = await collectLeads(page);
    let newOnPage = 0;
    for (const lead of leads) {
      if (!allLeads.find(l => l.name === lead.name)) {
        allLeads.push(lead);
        newOnPage++;
      }
    }
    console.log(`   ${leads.length} leads found, ${newOnPage} new (${allLeads.length} total so far)`);

    // Next page
    const nextBtn = page.locator('button[aria-label="Next"]').first();
    const isVisible = await nextBtn.isVisible({ timeout: 3000 }).catch(() => false);
    const isEnabled = isVisible && await nextBtn.isEnabled().catch(() => false);
    if (!isVisible || !isEnabled) {
      console.log('\n✅ No more pages — done scraping.');
      break;
    }

    await nextBtn.scrollIntoViewIfNeeded();
    await sleep(500, 300);
    await nextBtn.click();
    pageNum++;
    await sleep(3000, 1500);

    const loaded2 = await waitForResults(page);
    if (!loaded2) { console.log('❌ Next page did not load.'); break; }
  }

  await context.close();

  console.log(`\n📋 Total scraped: ${allLeads.length}`);
  fs.writeFileSync(LEADS_FILE, JSON.stringify(allLeads, null, 2));
  console.log(`💾 Saved ${allLeads.length} entries to leads.json`);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
