// linkedin_mutuals.js
// Visits each 2nd-degree lead from a Sales Nav saved search and scrapes the
// mutual (1st-degree) connections so you can ask those mutuals for warm intros.
//
// Usage: node linkedin_mutuals.js "<saved-search-url>" [batchSize=10]

const { chromium } = require('playwright');
const { spawn }    = require('child_process');
const fs           = require('fs');
const path         = require('path');

const CHROME_SRC_PROFILE = 'C:\\Users\\arunl\\AppData\\Local\\Google\\Chrome\\User Data\\Default';
const TEMP_PROFILE_DIR   = 'C:\\Users\\arunl\\AppData\\Local\\Temp\\linkedin_playwright';
const OUTPUT_CSV         = path.join(__dirname, 'data', 'mutual_connections.csv');
const CACHE_FILE         = path.join(__dirname, 'data', 'mutuals_cache.json');

const SAVED_SEARCH_URL = process.argv[2];
const BATCH_SIZE       = parseInt(process.argv[3]) || 10;

if (!SAVED_SEARCH_URL) {
  console.error('Usage: node linkedin_mutuals.js "<saved-search-url>" [batchSize=10]');
  process.exit(1);
}

// ── Profile copy ──────────────────────────────────────────────────────────────
function copyProfile() {
  const dest = path.join(TEMP_PROFILE_DIR, 'Default');
  if (fs.existsSync(dest)) { console.log('♻️  Reusing existing temp profile.'); return; }
  console.log('📋 Copying Chrome profile (one-time)...');
  fs.mkdirSync(dest, { recursive: true });
  const skip = ['GPUCache','ShaderCache','Code Cache','Cache','CacheStorage'];
  try {
    fs.cpSync(CHROME_SRC_PROFILE, dest, {
      recursive: true,
      errorOnExist: false,
      filter: src => !skip.some(s => src.includes(s)),
    });
    console.log('✅ Profile copied.\n');
  } catch (err) {
    if (err.code === 'EBUSY') {
      console.log('⚠️  Some profile files were locked — continuing with partial copy.\n');
    } else { throw err; }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function sleep(ms, jitter = 0) { return new Promise(r => setTimeout(r, ms + rand(0, jitter))); }
function thinkDelay() { return sleep(rand(800, 2000)); }
function readDelay()  { return sleep(rand(1500, 3000)); }
function microDelay() { return sleep(rand(80, 220)); }

let mouseX = 760, mouseY = 400;
async function humanMoveTo(page, targetX, targetY) {
  const steps = rand(12, 25);
  const startX = mouseX, startY = mouseY;
  const cpX = startX + (targetX - startX) * 0.5 + rand(-80, 80);
  const cpY = startY + (targetY - startY) * 0.5 + rand(-60, 60);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round((1-t)*(1-t)*startX + 2*(1-t)*t*cpX + t*t*targetX);
    const y = Math.round((1-t)*(1-t)*startY + 2*(1-t)*t*cpY + t*t*targetY);
    await page.mouse.move(x + rand(-2, 2), y + rand(-2, 2));
    await sleep(rand(8, 25));
  }
  mouseX = targetX; mouseY = targetY;
}
async function humanClick(page, locator) {
  const box = await locator.boundingBox();
  if (!box) { await locator.click(); return; }
  const targetX = Math.round(box.x + box.width  * (0.35 + Math.random() * 0.3));
  const targetY = Math.round(box.y + box.height * (0.35 + Math.random() * 0.3));
  await humanMoveTo(page, targetX, targetY);
  await sleep(rand(120, 350));
  await page.mouse.click(targetX, targetY);
  await microDelay();
}
async function humanScrollTo(page, element) {
  await element.scrollIntoViewIfNeeded();
  await sleep(rand(300, 700));
  await page.mouse.wheel(0, rand(-30, 30));
  await sleep(rand(200, 400));
}
async function browseProfileNaturally(page) {
  const scrolls = rand(3, 6);
  for (let i = 0; i < scrolls; i++) {
    await page.mouse.wheel(0, rand(180, 400));
    await sleep(rand(700, 1800));
    if (Math.random() < 0.5) {
      await page.mouse.move(rand(300, 900), rand(200, 600));
      await sleep(rand(300, 800));
    }
  }
  await page.mouse.wheel(0, -9999);
  await sleep(rand(400, 900));
}

// ── Prevent sleep ─────────────────────────────────────────────────────────────
let _caffeinate = null;
function setSleep(enable) {
  if (!enable) {
    _caffeinate = spawn('powershell', ['-noprofile', '-Command',
      `Add-Type -Name W -Member '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);' -Namespace W; while($true){[W.W]::SetThreadExecutionState(0x80000003); Start-Sleep 60}`
    ], { detached: false, stdio: 'ignore' });
  } else if (_caffeinate) {
    _caffeinate.kill();
    _caffeinate = null;
  }
}

// ── Cache ─────────────────────────────────────────────────────────────────────
function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}
function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// Stable lead ID from any Sales Nav URL (strips session tokens)
function stableId(url) {
  if (!url) return null;
  const m = url.match(/\/sales\/lead\/([^,?]+)/) || url.match(/\/sales\/people\/([^,?]+)/) || url.match(/\/in\/([^\/?#]+)/);
  return m ? m[1] : null;
}

// ── Collect leads from search results page ───────────────────────────────────
async function collectLeads(page) {
  // Lazy-load all rows first
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, 800);
    await sleep(rand(400, 700));
  }
  await page.mouse.wheel(0, -10000);
  await sleep(rand(1200, 2000));

  return page.evaluate(() => {
    const rows = [
      ...document.querySelectorAll('ol.artdeco-list > li'),
      ...document.querySelectorAll('li.artdeco-list__item'),
    ];
    const unique = [...new Set(rows)];
    const results = [];
    for (const row of unique) {
      let nameEl = row.querySelector('[data-anonymize="person-name"]') ||
                   row.querySelector('a[href*="/sales/lead/"] span[aria-hidden="true"]') ||
                   row.querySelector('a[href*="/sales/lead/"] span') ||
                   row.querySelector('a[href*="/sales/lead/"]');
      if (!nameEl?.textContent?.trim()) {
        const moreBtn = row.querySelector('button[aria-label*="See more actions for"]');
        const ariaLabel = moreBtn?.getAttribute('aria-label') || '';
        const m = ariaLabel.match(/See more actions for (.+?)(?:\.|$)/);
        if (m) nameEl = { textContent: m[1] };
      }
      const titleEl   = row.querySelector('[data-anonymize="title"]');
      const companyEl = row.querySelector('[data-anonymize="company-name"]');
      const linkEl    = row.querySelector('a[href*="/sales/lead/"]');
      const name = nameEl?.textContent?.trim();
      if (!name || name.length <= 1 || !linkEl) continue;
      if (!results.find(r => r.name === name)) {
        results.push({
          name,
          title:   titleEl?.textContent?.trim()   || '',
          company: companyEl?.textContent?.trim()  || '',
          profileUrl: linkEl.href,
        });
      }
    }
    return results;
  });
}

// ── Wait for search results to appear ─────────────────────────────────────────
async function waitForResults(page) {
  try {
    await page.waitForSelector('ol.artdeco-list, li.artdeco-list__item', { timeout: 20000 });
    return true;
  } catch { return false; }
}

// ── Human-like search page browse before targeting a row ──────────────────────
async function browseSearchResultsNaturally(page) {
  const scrolls = rand(2, 4);
  for (let i = 0; i < scrolls; i++) {
    await page.mouse.wheel(0, rand(150, 350));
    await sleep(rand(600, 1500));
    if (Math.random() < 0.5) {
      await page.mouse.move(rand(300, 1100), rand(250, 650));
      await sleep(rand(300, 800));
    }
  }
  await page.mouse.wheel(0, -9999);
  await sleep(rand(400, 900));
}

// ── Scrape mutual connections from the search results page (no profile visit) ─
async function scrapeMutualsForLead(page, lead) {
  // Skim the page first like a human reading results before clicking
  await browseSearchResultsNaturally(page);

  // Locate the row containing this lead
  const row = page.locator('li.artdeco-list__item, ol.artdeco-list > li').filter({ hasText: lead.name }).first();
  if (!await row.isVisible({ timeout: 3000 }).catch(() => false)) {
    return { count: 0, mutuals: [], expanded: false };
  }

  // Scroll the row into view and dwell briefly as if reading the lead details
  await humanScrollTo(page, row);
  await readDelay();
  const rowBox = await row.boundingBox().catch(() => null);
  if (rowBox) {
    await humanMoveTo(page,
      Math.round(rowBox.x + rowBox.width * (0.2 + Math.random() * 0.5)),
      Math.round(rowBox.y + rowBox.height * (0.3 + Math.random() * 0.4))
    );
    await sleep(rand(500, 1200));
  }

  // Find the "X mutual connections" badge within the row
  const badge = row.locator(
    'button:has-text("mutual connection"), a:has-text("mutual connection"), ' +
    '[aria-label*="mutual connection"]'
  ).first();

  if (!await badge.isVisible({ timeout: 3000 }).catch(() => false)) {
    return { count: 0, mutuals: [], expanded: false };
  }

  const badgeText = await badge.textContent().catch(() => '') || '';
  const countMatch = badgeText.match(/(\d+)\s+mutual/i);
  const count = countMatch ? parseInt(countMatch[1]) : 0;

  // Pause/hover the badge before clicking — humans dwell briefly on a target
  const badgeBox = await badge.boundingBox().catch(() => null);
  if (badgeBox) {
    await humanMoveTo(page,
      Math.round(badgeBox.x + badgeBox.width / 2),
      Math.round(badgeBox.y + badgeBox.height / 2)
    );
    await sleep(rand(400, 900));
  }

  await humanClick(page, badge);
  await sleep(rand(2500, 4000));

  // Pretend to read the popover — small mouse drift + dwell time
  await page.mouse.move(rand(500, 1200), rand(300, 600));
  await readDelay();

  // Click "View all" — navigates to full mutuals page
  let expanded = false;
  const viewAllCandidates = [
    'a:has-text("View all")',
    'button:has-text("View all")',
    'span:has-text("View all")',
    '[role="button"]:has-text("View all")',
  ];
  for (const sel of viewAllCandidates) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
      try {
        await humanClick(page, loc);
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await sleep(rand(2500, 4000));
        expanded = true;
        break;
      } catch (e) { /* try next */ }
    }
  }

  // On full mutuals page — browse it naturally (read names like a human would)
  if (expanded) {
    await browseProfileNaturally(page);
  }

  let { mutuals, debug } = await page.evaluate(({ expanded, leadName }) => {
    let root;
    if (expanded) {
      root = document;
    } else {
      const candidates = [...document.querySelectorAll('div, section, aside')].filter(el => {
        if (el.offsetParent === null) return false;
        const t = el.innerText || '';
        if (t.length < 50 || t.length > 5000) return false;
        return /warm introduction/i.test(t);
      });
      candidates.sort((a, b) => b.innerText.length - a.innerText.length);
      root = candidates[0] || null;
    }
    if (!root) return { mutuals: [], debug: { url: location.href, rootFound: false } };

    const seen = new Set();
    const out = [];
    const leadNameLower = (leadName || '').toLowerCase();

    for (const nameEl of root.querySelectorAll('[data-anonymize="person-name"]')) {
      const name = nameEl.textContent?.trim();
      if (!name || name.length < 2 || name.length > 80) continue;
      if (seen.has(name)) continue;
      // Filter: skip the lead's own name (it shows up in some popovers as context)
      if (leadNameLower && name.toLowerCase() === leadNameLower) continue;
      const linkParent = nameEl.closest('a[href*="/in/"], a[href*="/sales/people/"]');
      const profileUrl = linkParent?.href || null;
      seen.add(name);
      out.push({ name, profileUrl });
    }

    if (out.length === 0) {
      for (const a of root.querySelectorAll('a[href*="/sales/people/"], a[href*="linkedin.com/in/"], a[href*="/in/"]')) {
        const href = a.href;
        if (!/\/(sales\/people|in)\//.test(href)) continue;
        if (/\/me\//.test(href)) continue;
        if (seen.has(href)) continue;
        let name = a.querySelector('span[aria-hidden="true"]')?.textContent?.trim()
                || a.textContent?.trim();
        if (!name || name.length < 2 || name.length > 80) continue;
        if (/^(view|see|all|members|people|company|profile|show|message)\b/i.test(name)) continue;
        if (leadNameLower && name.toLowerCase() === leadNameLower) continue;
        seen.add(href);
        out.push({ name, profileUrl: href });
      }
    }

    return {
      mutuals: out,
      debug: {
        url: location.href,
        rootFound: true,
        rootIsDoc: root === document,
        personNameSpans: root.querySelectorAll('[data-anonymize="person-name"]').length,
      },
    };
  }, { expanded, leadName: lead.name });
  console.log(`   🔬 url=${debug.url} rootFound=${debug.rootFound} rootIsDoc=${debug.rootIsDoc} personNames=${debug.personNameSpans}`);

  // Safeguard: when popover wasn't expanded (small badge count), cap scraped at
  // badge_count + 1 to avoid pulling in adjacent row names. View all expanded
  // scrapes are trusted because they're on a dedicated mutuals page.
  if (!expanded && count > 0 && mutuals.length > count + 1) {
    console.log(`   ⚠️  Scraped ${mutuals.length} > badge ${count} + 1 — trimming to top ${count + 1}.`);
    mutuals = mutuals.slice(0, count + 1);
  }

  return { count, mutuals, expanded };
}

// ── CSV helpers ───────────────────────────────────────────────────────────────
const CSV_HEADER = 'LeadName,LeadTitle,LeadCompany,LeadUrl,MutualName,MutualUrl';
function csvEscape(v) { return `"${(v || '').replace(/"/g, '""')}"`; }

// Load existing (lead-id, mutual-name) pairs from CSV so re-runs don't duplicate
function loadExistingPairs() {
  const set = new Set();
  if (!fs.existsSync(OUTPUT_CSV)) return set;
  const lines = fs.readFileSync(OUTPUT_CSV, 'utf8').replace(/^﻿/, '').trim().split('\n').slice(1);
  for (const line of lines) {
    const fields = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map(m => m[1].replace(/""/g, '"'));
    const leadUrl = fields[3];
    const mutualName = fields[4];
    const leadId = stableId(leadUrl);
    if (leadId && mutualName) set.add(`${leadId}|${mutualName}`);
  }
  return set;
}

function appendCsvRow(lead, mutual, existingPairs) {
  const leadId = stableId(lead.profileUrl);
  const key = `${leadId}|${mutual.name}`;
  if (existingPairs.has(key)) return false;
  existingPairs.add(key);
  const row = [lead.name, lead.title, lead.company, lead.profileUrl, mutual.name, mutual.profileUrl]
    .map(csvEscape).join(',');
  if (!fs.existsSync(OUTPUT_CSV)) {
    fs.writeFileSync(OUTPUT_CSV, CSV_HEADER + '\n');
  }
  fs.appendFileSync(OUTPUT_CSV, row + '\n');
  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  setSleep(false);
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
  await page.mouse.move(rand(300, 900), rand(200, 500));

  await page.goto(SAVED_SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(rand(2500, 4000));

  if (page.url().includes('login')) {
    console.log('\n🔐 Please log in. Waiting up to 3 min...\n');
    await page.waitForFunction(() => !window.location.href.includes('login'), null, { timeout: 180000, polling: 2000 });
    console.log('✅ Logged in!\n');
    await page.goto(SAVED_SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(rand(2500, 4000));
  }

  const ready = await waitForResults(page);
  if (!ready) { console.log('❌ Search results did not load.'); await context.close(); setSleep(true); return; }

  const cache = loadCache();
  const existingPairs = loadExistingPairs();
  console.log(`📋 CSV already has ${existingPairs.size} (lead, mutual) pairs — won't duplicate.`);
  let processed = 0;
  let pageNum = 1;

  outer:
  while (processed < BATCH_SIZE) {
    console.log(`\n🔍 Page ${pageNum}: lazy-loading and collecting leads...`);
    const leads = await collectLeads(page);
    console.log(`   ✅ ${leads.length} leads found on this page.`);

    for (const lead of leads) {
      if (processed >= BATCH_SIZE) break outer;

      const id = stableId(lead.profileUrl);
      if (id && cache[id]) {
        console.log(`   ⏭️  ${lead.name} — already scraped (${cache[id].mutuals.length} mutuals), skipping.`);
        continue;
      }

      console.log(`\n[${processed + 1}/${BATCH_SIZE}] ${lead.name} — ${lead.title} @ ${lead.company}`);
      try {
        const { count, mutuals, expanded } = await scrapeMutualsForLead(page, lead);
        console.log(`   👥 Badge says ${count} mutual(s), scraped ${mutuals.length} name(s)${expanded ? ' (View all opened)' : ''}.`);
        if (mutuals.length > 0) {
          mutuals.slice(0, 5).forEach(m => console.log(`      • ${m.name}`));
          if (mutuals.length > 5) console.log(`      … and ${mutuals.length - 5} more`);
          let written = 0;
          for (const m of mutuals) { if (appendCsvRow(lead, m, existingPairs)) written++; }
          if (written < mutuals.length) console.log(`   (skipped ${mutuals.length - written} duplicate row(s) already in CSV)`);
        }
        cache[id] = { lead, count, mutuals, scrapedAt: new Date().toISOString() };
        saveCache(cache);

        // If "View all" navigated us away from search, go back so we can process next lead
        if (expanded) {
          console.log(`   ↩️  Navigating back to search...`);
          await page.goto(SAVED_SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await sleep(rand(2500, 4000));
          await waitForResults(page);
          // Re-scroll-load before next iteration's collectLeads
        }
      } catch (err) {
        console.log(`   💥 Error: ${err.message}`);
        cache[id] = { lead, mutuals: [], error: err.message, scrapedAt: new Date().toISOString() };
        saveCache(cache);
        // Attempt recovery — navigate back to search
        await page.goto(SAVED_SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await sleep(rand(2500, 4000));
      }

      processed++;

      if (processed < BATCH_SIZE) {
        // Most gaps are short (8-18s). Roughly 1 in 5 is a longer "break" (30-60s)
        // to mimic real browsing rhythm.
        const longBreak = Math.random() < 0.2;
        const gap = longBreak ? rand(30000, 60000) : rand(8000, 18000);
        console.log(`   ⏳ Waiting ${(gap/1000).toFixed(0)}s${longBreak ? ' (longer break)' : ''}...`);
        const gapStart = Date.now();
        while (Date.now() - gapStart < gap) {
          await sleep(rand(1500, 3500));
          if (Date.now() - gapStart < gap) {
            await page.mouse.move(rand(200, 1200), rand(150, 700));
          }
        }
      }

      // After processing one lead and navigating back, re-collect leads on next loop
      break;
    }

    if (processed >= BATCH_SIZE) break;

    // Move to next search page
    pageNum++;
    console.log(`\n📄 Moving to page ${pageNum}...`);
    const currentUrl = page.url();
    const nextUrl = currentUrl.includes('page=')
      ? currentUrl.replace(/([?&])page=\d+/, `$1page=${pageNum}`)
      : currentUrl + (currentUrl.includes('?') ? '&' : '?') + `page=${pageNum}`;
    try {
      await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err) {
      console.log(`❌ Failed to load page ${pageNum}: ${err.message}. Stopping.`);
      break;
    }
    await sleep(rand(3000, 5000));
    const ok = await waitForResults(page);
    if (!ok) { console.log('❌ Next page did not load. Stopping.'); break; }
  }

  console.log('\n══════════════════════════════════════════════════');
  console.log(`✅ Done! Processed: ${processed} lead(s)`);
  console.log(`   CSV: ${OUTPUT_CSV}`);
  console.log(`   Cache: ${CACHE_FILE}`);
  console.log('══════════════════════════════════════════════════\n');

  await sleep(rand(2000, 3000));
  await context.close();
  setSleep(true);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
