// profile_enricher.js
// Visits each Sales Navigator lead profile to extract:
//   1. Full name  — from the LinkedIn /in/ URL in the 3-dots menu
//   2. Company website — by clicking the company in the experience section
// Updates leads.json and re-runs email enrichment logic for affected leads.

const { chromium } = require('playwright');
const { spawn }    = require('child_process');
const fs   = require('fs');
const path = require('path');

const CHROME_SRC_PROFILE = 'C:\\Users\\arunl\\AppData\\Local\\Google\\Chrome\\User Data\\Default';
const TEMP_PROFILE_DIR   = 'C:\\Users\\arunl\\AppData\\Local\\Temp\\linkedin_playwright';
const LEADS_FILE         = path.join(__dirname, 'data', 'leads.json');
const CACHE_FILE         = path.join(__dirname, 'data', 'enriched_profiles.json');

// ── Helpers ───────────────────────────────────────────────────────────────────

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function sleep(ms, jitter = 0) { return new Promise(r => setTimeout(r, ms + rand(0, jitter))); }
function thinkDelay() { return sleep(rand(800, 2000)); }
function readDelay()  { return sleep(rand(1500, 3000)); }
function microDelay() { return sleep(rand(80, 220)); }

// ── Human-like mouse movement (curved bezier arc) ────────────────────────────
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

// Scroll and hover around a profile page like a human reading it
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

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}
function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// ── Identify leads needing enrichment ────────────────────────────────────────

function isTruncated(name) {
  const namePart = name.split(',')[0].trim();
  const parts = namePart.split(' ');
  const last = parts[parts.length - 1].replace('.', '');
  return last.length === 1;
}

function getLeadsToEnrich(leads) {
  return leads.filter(l => {
    if (!l.profileUrl) return false;
    return isTruncated(l.name) || !l.domain;
  });
}

// ── Extract full name from LinkedIn /in/ URL slug ─────────────────────────────

function nameFromSlug(slug) {
  // e.g. "kevin-norman-abc123" → "Kevin Norman"
  const parts = slug.split('-').filter(p => !/^[a-z0-9]{6,}$/.test(p) && p.length > 1);
  return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

// ── Visit lead profile and extract data ──────────────────────────────────────

async function enrichFromProfile(page, lead) {
  const result = { fullName: null, website: null };

  await page.goto(lead.profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(rand(2500, 4000));

  // Random starting mouse position — not 0,0
  await page.mouse.move(rand(300, 900), rand(200, 500));
  await sleep(rand(400, 800));

  // Browse the profile naturally before extracting anything
  await browseProfileNaturally(page);

  // ── 1. Full name via 3-dots menu → "Copy LinkedIn URL" ───────────────────
  try {
    const moreBtn = page.locator(
      'button[aria-label*="More actions"], button[aria-label*="more actions"], ' +
      'button[id*="hue-web-ui"], button:has([data-icon="overflow-web-google-nav"])'
    ).first();

    if (await moreBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
      await humanScrollTo(page, moreBtn);
      await thinkDelay();
      await humanClick(page, moreBtn);
      await thinkDelay();

      const copyUrlItem = page.locator(
        '[role="menuitem"]:has-text("Copy LinkedIn URL"), ' +
        '[role="menuitem"]:has-text("Copy LinkedIn profile URL"), ' +
        'li:has-text("Copy LinkedIn URL")'
      ).first();

      if (await copyUrlItem.isVisible({ timeout: 2500 }).catch(() => false)) {
        const linkedinUrl = await copyUrlItem.evaluate(el => {
          const a = el.querySelector('a[href*="linkedin.com/in/"]');
          return a ? a.href : null;
        });
        if (linkedinUrl) {
          const match = linkedinUrl.match(/linkedin\.com\/in\/([^/?#]+)/);
          if (match) result.fullName = nameFromSlug(match[1]);
        }
        await page.keyboard.press('Escape');
        await microDelay();
      } else {
        await page.keyboard.press('Escape');
        await microDelay();
      }
    }
  } catch {}

  // Fallback: page title — Sales Nav sets it to "Full Name | LinkedIn Sales Navigator"
  if (!result.fullName) {
    try {
      const title = await page.title();
      const match = title.match(/^([^|–\-]+)/);
      if (match) {
        const candidate = match[1].trim();
        const blocked = /navigator|linkedin|lead page|sales|sign in|basic lead information/i.test(candidate);
        const words = candidate.split(' ').filter(w => w.length > 1);
        if (!blocked && words.length >= 2 && !isTruncated(candidate)) {
          result.fullName = candidate;
        }
      }
    } catch {}
  }

  // Fallback: scan entire DOM for any /in/ URL (includes hidden elements)
  if (!result.fullName) {
    try {
      const href = await page.evaluate(() => {
        const a = [...document.querySelectorAll('a[href*="linkedin.com/in/"], a[href*="/in/"]')]
          .find(el => el.href && el.href.includes('/in/'));
        return a ? a.href : null;
      });
      if (href) {
        const match = href.match(/linkedin\.com\/in\/([^/?#]+)/);
        if (match) result.fullName = nameFromSlug(match[1]);
      }
    } catch {}
  }

  // Fallback: broadest h1 sweep — take first h1 with 2+ real words, skip nav strings
  if (!result.fullName) {
    try {
      const name = await page.evaluate(() => {
        const blocked = /navigator|linkedin|lead page|sales|sign in|basic lead information/i;
        for (const h1 of document.querySelectorAll('h1')) {
          const t = h1.innerText?.trim();
          if (t && t.split(' ').filter(w => w.length > 1).length >= 2 && !blocked.test(t)) return t;
        }
        return null;
      });
      if (name && !isTruncated(name)) result.fullName = name;
    } catch {}
  }

  await readDelay();

  // ── 2. Company website via "Current role" section ─────────────────────────
  try {
    // First company link on the page is almost always the current company
    // (LinkedIn renders "Current role" → company link → past experience)
    const companyLink = page.locator(
      'a[href*="/sales/company/"], a[href*="linkedin.com/company/"]'
    ).first();

    if (await companyLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await humanScrollTo(page, companyLink);
      await readDelay();
      await humanClick(page, companyLink);
      await sleep(rand(3000, 5000));

      // On the company page, find the website link
      const websiteLink = page.locator(
        'a[data-control-name*="website"], ' +
        'a[aria-label*="website"], ' +
        '.company-info a[href*="http"]:not([href*="linkedin.com"]), ' +
        '[data-view-name*="company-website"] a, ' +
        'dt:has-text("Website") + dd a, ' +
        'a.link-without-visited-state[href^="http"]:not([href*="linkedin.com"])'
      ).first();

      if (await websiteLink.isVisible({ timeout: 5000 }).catch(() => false)) {
        // Hover over the link naturally before reading it
        const box = await websiteLink.boundingBox().catch(() => null);
        if (box) {
          await humanMoveTo(page,
            Math.round(box.x + box.width * (0.3 + Math.random() * 0.4)),
            Math.round(box.y + box.height * 0.5)
          );
          await sleep(rand(400, 900));
        }
        const websiteHref = await websiteLink.getAttribute('href');
        if (websiteHref && !websiteHref.includes('linkedin.com')) {
          try {
            result.website = new URL(websiteHref).hostname.replace(/^www\./, '');
          } catch {
            result.website = websiteHref;
          }
        }
      }

      // Navigate back to lead profile
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await sleep(rand(1500, 2500));
    }
  } catch {}

  return result;
}


// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  setSleep(false);

  const leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
  const cache = loadCache();

  const maxLeads = parseInt(process.argv[2]) || Infinity;

  const toEnrich = getLeadsToEnrich(leads);
  const allRemaining = toEnrich.filter(l => !cache[l.profileUrl]);
  const remaining = allRemaining.slice(0, maxLeads);

  console.log(`\n📋 ${leads.length} total leads`);
  console.log(`🔍 ${toEnrich.length} need enrichment — ${toEnrich.length - allRemaining.length} already cached — processing ${remaining.length}${maxLeads < Infinity ? ` (capped at ${maxLeads})` : ''}\n`);

  if (remaining.length === 0) {
    console.log('✅ Nothing new to enrich.\n');
    setSleep(true);
    return;
  }

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

  // Random starting mouse position — not 0,0
  await page.mouse.move(rand(300, 900), rand(200, 500));

  // Verify login
  await page.goto('https://www.linkedin.com/sales/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);
  if (page.url().includes('login')) {
    console.log('\n🔐 Please log in. Waiting up to 3 min...\n');
    await page.waitForFunction(() => !window.location.href.includes('login'), { timeout: 180000, polling: 2000 });
    console.log('✅ Logged in!\n');
  }

  let improved = 0, unchanged = 0, failed = 0;

  for (let i = 0; i < remaining.length; i++) {
    const lead = remaining[i];
    console.log(`\n[${i + 1}/${remaining.length}] ${lead.name} @ ${lead.company}`);

    try {
      const extracted = await enrichFromProfile(page, lead);
      cache[lead.profileUrl] = extracted;
      saveCache(cache);

      // Apply extracted data
      const updatedLead = { ...lead };
      let changed = false;

      if (extracted.fullName && extracted.fullName !== lead.name && extracted.fullName.split(' ').length >= 2) {
        console.log(`   👤 Name: "${lead.name}" → "${extracted.fullName}"`);
        updatedLead.name = extracted.fullName;
        changed = true;
      }

      if (extracted.website) {
        console.log(`   🌐 Domain: ${extracted.website}`);
        updatedLead.domain = extracted.website;
        changed = true;
      } else {
        console.log(`   ❌ Company website not found — email_finder.js will try DNS`);
      }

      if (changed) improved++; else unchanged++;

      // Update leads.json with corrected name/data
      const idx = leads.findIndex(l => l.profileUrl === lead.profileUrl);
      if (idx !== -1) leads[idx] = updatedLead;
      fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));

    } catch (err) {
      console.log(`   💥 Error: ${err.message}`);
      failed++;
      cache[lead.profileUrl] = { error: err.message };
      saveCache(cache);
    }

    // Human-like gap between profile visits with idle mouse movement
    if (i < remaining.length - 1) {
      const gap = rand(6000, 14000);
      console.log(`   ⏳ Waiting ${(gap/1000).toFixed(0)}s...`);
      const gapStart = Date.now();
      while (Date.now() - gapStart < gap) {
        await sleep(rand(1500, 3500));
        if (Date.now() - gapStart < gap) {
          await page.mouse.move(rand(200, 1200), rand(150, 700));
        }
      }
    }
  }

  console.log('\n══════════════════════════════════════════════════');
  console.log('✅ Done! Run email_finder.js to find emails.');
  console.log(`   Improved:  ${improved}`);
  console.log(`   Unchanged: ${unchanged}`);
  console.log(`   Failed:    ${failed}`);
  console.log('══════════════════════════════════════════════════\n');

  await sleep(rand(2000, 3000));
  await context.close();
  setSleep(true);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
