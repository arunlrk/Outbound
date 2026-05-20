const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CHROME_SRC_PROFILE = 'C:\\Users\\arunl\\AppData\\Local\\Google\\Chrome\\User Data\\Default';
const TEMP_PROFILE_DIR   = 'C:\\Users\\arunl\\AppData\\Local\\Temp\\linkedin_playwright';

function copyProfile() {
  const dest = path.join(TEMP_PROFILE_DIR, 'Default');
  if (fs.existsSync(dest)) {
    console.log('♻️  Reusing existing temp profile.');
    return;
  }
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
      console.log('⚠️  Some profile files were locked (Chrome open?) — continuing with partial copy. You may need to log in.\n');
    } else {
      throw err;
    }
  }
}

const CONFIG = {
  chromeUserData: TEMP_PROFILE_DIR,
  chromeExecutable: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  salesNavUrl: process.argv[2] || 'https://www.linkedin.com/sales/search/people?savedSearchId=1975735748&sessionId=HVYhIuTuR%2BeSYo40kPyAJA%3D%3D',
  maxRequests: 10,
  sendNote: true,   // set to true to re-enable personalized note
};

const SENT_LOG_FILE = path.join(__dirname, 'data', 'sent_log.json');

// Load set of already-contacted profile URLs (falls back to name if no URL)
function loadSentLog() {
  try { return new Set(JSON.parse(fs.readFileSync(SENT_LOG_FILE, 'utf8'))); } catch { return new Set(); }
}

function saveSentLog(log) {
  fs.writeFileSync(SENT_LOG_FILE, JSON.stringify([...log], null, 2));
}

function sentKey(lead) {
  return lead.profileUrl || lead.name;
}

// ── Human-like timing helpers ────────────────────────────────────────────────

// Random int between min and max
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

// Sleep with optional jitter
function sleep(ms, jitter = 0) {
  return new Promise(r => setTimeout(r, ms + rand(0, jitter)));
}

// Gaussian-ish delay: feels more natural than uniform random
function thinkDelay() { return sleep(rand(800, 2200)); }
function readDelay()  { return sleep(rand(1500, 3500)); }
function microDelay() { return sleep(rand(80, 220)); }

// ── Human-like mouse movement (curved arc) ───────────────────────────────────
let mouseX = 760, mouseY = 400; // track approximate position

async function humanMoveTo(page, targetX, targetY) {
  const steps = rand(12, 25);
  const startX = mouseX, startY = mouseY;

  // Control point for a slight bezier curve
  const cpX = startX + (targetX - startX) * 0.5 + rand(-80, 80);
  const cpY = startY + (targetY - startY) * 0.5 + rand(-60, 60);

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round((1 - t) * (1 - t) * startX + 2 * (1 - t) * t * cpX + t * t * targetX);
    const y = Math.round((1 - t) * (1 - t) * startY + 2 * (1 - t) * t * cpY + t * t * targetY);
    await page.mouse.move(x + rand(-2, 2), y + rand(-2, 2));
    await sleep(rand(8, 25));
  }
  mouseX = targetX; mouseY = targetY;
}

// Move to an element's center, hover briefly, then click
async function humanClick(page, locator) {
  const box = await locator.boundingBox();
  if (!box) { await locator.click(); return; }

  const targetX = Math.round(box.x + box.width  * (0.35 + Math.random() * 0.3));
  const targetY = Math.round(box.y + box.height * (0.35 + Math.random() * 0.3));

  await humanMoveTo(page, targetX, targetY);
  await sleep(rand(120, 350));       // hover pause before click
  await page.mouse.click(targetX, targetY);
  await microDelay();
}

// ── Human-like typing ────────────────────────────────────────────────────────
async function humanType(textarea, text) {
  // Click into textarea first
  await textarea.click();
  await sleep(rand(200, 500));

  for (let i = 0; i < text.length; i++) {
    await textarea.pressSequentially(text[i], { delay: rand(45, 160) });
    // Occasional "thinking" pause mid-sentence
    if (Math.random() < 0.04) await sleep(rand(400, 900));
    // Slight pause after punctuation
    if ([',', '.', '!', '?'].includes(text[i])) await sleep(rand(100, 300));
  }
}

// ── Human-like scroll ────────────────────────────────────────────────────────
async function humanScrollTo(page, element) {
  await element.scrollIntoViewIfNeeded();
  await sleep(rand(300, 700));
  // A little extra scroll jitter to look natural
  await page.mouse.wheel(0, rand(-30, 30));
  await sleep(rand(200, 400));
}

// ── Scroll down page like reading ────────────────────────────────────────────
async function browsePageNaturally(page) {
  const scrolls = rand(2, 4);
  for (let i = 0; i < scrolls; i++) {
    await page.mouse.wheel(0, rand(200, 450));
    await sleep(rand(600, 1400));
  }
  // Scroll back to top
  await page.mouse.wheel(0, -9999);
  await sleep(rand(400, 800));
}

// ── Skim a page of already-viewed profiles — looks like a human glancing ──────
// Called when every lead on the page was already viewed. Simulates:
//   • slow scroll down reading names
//   • brief mouse hover over 2-3 random rows
//   • pause as if "deciding" before clicking Next
async function humanSkimViewedPage(page) {
  // Slow read-scroll — more deliberate than browsePageNaturally
  const scrolls = rand(3, 6);
  for (let i = 0; i < scrolls; i++) {
    await page.mouse.wheel(0, rand(150, 320));
    await sleep(rand(900, 2200));
    // Occasionally move the mouse to a random spot on the page as if reading
    if (Math.random() < 0.6) {
      await page.mouse.move(rand(300, 900), rand(200, 650));
      await sleep(rand(300, 700));
    }
  }

  // Hover briefly over 2-3 random lead rows (as if reading their names)
  const rows = await page.locator('li.artdeco-list__item').all();
  const targets = rows.sort(() => Math.random() - 0.5).slice(0, rand(2, 3));
  for (const row of targets) {
    const box = await row.boundingBox().catch(() => null);
    if (!box) continue;
    const x = Math.round(box.x + box.width  * (0.2 + Math.random() * 0.4));
    const y = Math.round(box.y + box.height * (0.3 + Math.random() * 0.4));
    await humanMoveTo(page, x, y);
    await sleep(rand(600, 1400)); // hover as if reading
  }

  // "Deciding" pause before moving on
  await sleep(rand(1500, 3000));
  // Scroll back toward top naturally
  await page.mouse.wheel(0, -9999);
  await sleep(rand(500, 1000));
}

// ── Infer focus area from job title ──────────────────────────────────────────
function inferFocus(title) {
  const t = title.toLowerCase();
  if (/automati/.test(t))                          return 'test automation';
  if (/codeless|no.?code|low.?code/.test(t))       return 'codeless testing';
  if (/devops|ci\/cd|pipeline/.test(t))            return 'CI/CD pipelines';
  if (/sre|reliability|platform/.test(t))          return 'platform reliability';
  if (/qa|quality|test/.test(t))                   return 'quality engineering';
  if (/engineer|architect|technical/.test(t))      return 'engineering efficiency';
  if (/product|vp|director|head|lead/.test(t))     return 'product delivery';
  if (/agile|scrum|delivery/.test(t))              return 'agile delivery';
  return 'scaling software quality';
}

// ── Message templates ─────────────────────────────────────────────────────────
function buildMessage(firstName, title, company) {
  const templates = [
    `Hi ${firstName}, I’m with CloudQA in Florida. We’re talking to engineering leaders about the shift from codeless automation to AI-powered testing. Would love to hear how your team is navigating that change.`,
    `Hi ${firstName}, CloudQA is based in Florida and we’re hearing from engineering leaders on how AI-powered testing is reshaping QA. Curious if your team is evaluating that after codeless automation?`,
    `Hi ${firstName}, I’m reaching out from CloudQA in Florida. We’re learning from engineering leaders about the transition from codeless QA to AI-powered test automation — interested in your perspective.`,
  ];
  const msg = templates[rand(0, templates.length - 1)];
  return msg.length > 300 ? msg.substring(0, 296) + '...' : msg;
}

// ── Wait for results ──────────────────────────────────────────────────────────
async function waitForResults(page) {
  const selectors = [
    '[data-anonymize="person-name"]',
    '.artdeco-entity-lockup__title',
    '[data-view-name="search-results-lead-row"]',
    'ol.artdeco-list li',
  ];
  for (const sel of selectors) {
    const found = await page.waitForSelector(sel, { timeout: 20000 }).catch(() => null);
    if (found) return sel;
  }
  return null;
}

// ── Collect leads ─────────────────────────────────────────────────────────────
async function collectLeads(page, sentLog) {
  return page.evaluate((sentArr) => {
    const sentSet = new Set(sentArr);
    const results = [];
    const candidateRows = [
      ...document.querySelectorAll('[data-view-name="search-results-lead-row"]'),
      ...document.querySelectorAll('ol.artdeco-list > li'),
      ...document.querySelectorAll('ul.artdeco-list > li'),
      ...document.querySelectorAll('li.artdeco-list__item'),
    ];
    const uniqueRows = [...new Set(candidateRows)];

    uniqueRows.forEach(row => {
      const labels = [
        ...row.querySelectorAll('span, li, [class*="viewed"], [class*="saved"], [class*="label"], [data-control-name]'),
      ].map(el => el.textContent?.trim());
      const isViewed = labels.some(t => /^viewed$/i.test(t));
      const isSaved  = labels.some(t => /^saved$/i.test(t));

      // Try a wide range of selectors — LinkedIn rotates DOM frequently.
      // Note: order matters; specific selectors first, broader fallbacks last.
      let nameEl    = row.querySelector('[data-anonymize="person-name"]') ||
                      row.querySelector('.artdeco-entity-lockup__title a span') ||
                      row.querySelector('a[href*="/sales/lead/"] span[aria-hidden="true"]') ||
                      row.querySelector('a[href*="/sales/lead/"] span') ||
                      row.querySelector('a[href*="/sales/lead/"]');
      // Last-ditch fallback: pull from the ... menu's aria-label "See more actions for <Name>"
      if (!nameEl?.textContent?.trim()) {
        const moreBtn = row.querySelector('button[aria-label*="See more actions for"]');
        const ariaLabel = moreBtn?.getAttribute('aria-label') || '';
        const m = ariaLabel.match(/See more actions for (.+?)(?:\.|$)/);
        if (m) nameEl = { textContent: m[1] };
      }
      const titleEl   = row.querySelector('[data-anonymize="title"]') ||
                        row.querySelector('.artdeco-entity-lockup__subtitle span:first-child');
      const companyEl = row.querySelector('[data-anonymize="company-name"]') ||
                        row.querySelector('.artdeco-entity-lockup__subtitle a');
      const linkEl    = row.querySelector('a[href*="/sales/lead/"]') ||
                        row.querySelector('a[href*="linkedin.com/in/"]');

      const name = nameEl?.textContent?.trim();
      if (!name || name.length <= 1) return;
      if (sentSet.has(name) || sentSet.has(linkEl?.href)) return;

      if (!results.find(r => r.name === name)) {
        results.push({
          name,
          title:      titleEl?.textContent?.trim()   || 'tech leader',
          company:    companyEl?.textContent?.trim()  || 'your company',
          profileUrl: linkEl?.href || null,
          saved:      isSaved,
        });
      }
    });
    return results;
  }, [...sentLog]);
}

// ── Send one connection request — fully human-like ────────────────────────────
async function sendConnect(page, lead, message) {
  // Find the row containing this lead, then find the "..." button within it
  // Using row-relative lookup avoids aria-label name-mismatch issues (Dr. prefix, badges, etc.)
  const leadRow = page.locator('li.artdeco-list__item').filter({ hasText: lead.name }).first();
  const moreBtn = leadRow.locator('button[aria-label*="See more actions"]').first();

  if (!await moreBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
    // Fallback: try global aria-label match in case row selector missed it
    const moreBtnFallback = page.locator(`button[aria-label="See more actions for ${lead.name}"]`).first();
    if (!await moreBtnFallback.isVisible({ timeout: 2000 }).catch(() => false)) {
      return { status: 'skipped', reason: '"..." button not visible' };
    }
    await humanScrollTo(page, moreBtnFallback);
    await readDelay();
    await humanClick(page, moreBtnFallback);
  } else {
    await humanScrollTo(page, moreBtn);
    await readDelay();
    await humanClick(page, moreBtn);
  }
  await thinkDelay();

  // Find and click "Connect" in the dropdown
  const connectOpt = page.locator('[role="menuitem"]:has-text("Connect"), li:has-text("Connect")').first();
  if (!await connectOpt.isVisible({ timeout: 2500 }).catch(() => false)) {
    await page.keyboard.press('Escape');
    await microDelay();
    return { status: 'skipped', reason: 'No Connect option (already connected or InMail only)' };
  }

  await humanClick(page, connectOpt);
  await thinkDelay();
  await sleep(rand(2000, 3500)); // wait for modal to fully render — slow modals were causing false "Send button not found"

  if (CONFIG.sendNote) {
    // "Add a note" button — give the modal time to load before checking
    const addNoteBtn = page.locator('button:has-text("Add a note")').first();
    if (await addNoteBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
      await humanClick(page, addNoteBtn);
      await sleep(rand(700, 1200));
    }

    // Type the personalized message naturally (textarea may appear with or without "Add a note")
    const textarea = page.locator('textarea').first();
    if (await textarea.isVisible({ timeout: 4000 }).catch(() => false)) {
      await humanScrollTo(page, textarea);
      await sleep(rand(400, 800)); // pause before typing — "composing thoughts"
      await humanType(textarea, message);
      await sleep(rand(500, 1000)); // pause after typing — "reviewing message"
    } else {
      console.log('   ⚠️  No textarea — will send without note.');
    }
  }

  // Click Send — covers all known button labels across Sales Navigator modal variants
  const sendBtn = page.locator(
    'button:has-text("Send invitation"), button:has-text("Send now"), button:has-text("Send"), button:has-text("Done")'
  ).first();
  // First attempt: 8s timeout
  let sendVisible = await sendBtn.isVisible({ timeout: 8000 }).catch(() => false);
  // Retry once after a short pause — modals occasionally take longer than 8s to render
  if (!sendVisible) {
    await sleep(rand(2000, 3000));
    sendVisible = await sendBtn.isVisible({ timeout: 4000 }).catch(() => false);
  }
  if (!sendVisible) {
    const screenshotPath = path.join(__dirname, 'logs', `linkedin_modal_debug_${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`   📸 Screenshot saved: ${screenshotPath}`);
    await page.keyboard.press('Escape');
    return { status: 'skipped', reason: 'Send button not found' };
  }

  await humanClick(page, sendBtn);
  await sleep(rand(1500, 2500)); // wait for modal to close
  return { status: 'sent' };
}

// ── Main ──────────────────────────────────────────────────────────────────────
const { spawn } = require('child_process');
let _caffeinate = null;
function setSleep(enable) {
  if (!enable) {
    // Spawn a PowerShell process that calls SetThreadExecutionState every 60s to prevent sleep
    _caffeinate = spawn('powershell', ['-noprofile', '-Command',
      `Add-Type -Name W -Member '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);' -Namespace W; while($true){[W.W]::SetThreadExecutionState(0x80000003); Start-Sleep 60}`
    ], { detached: false, stdio: 'ignore' });
  } else if (_caffeinate) {
    _caffeinate.kill();
    _caffeinate = null;
  }
}

async function main() {
  setSleep(false);
  copyProfile();
  console.log('\n🚀 Launching Chrome...');

  const context = await chromium.launchPersistentContext(CONFIG.chromeUserData, {
    executablePath: CONFIG.chromeExecutable,
    headless: false,
    viewport: null,
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled', // hide automation flag
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  // Mask navigator.webdriver so LinkedIn can't detect Playwright
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  const page = context.pages()[0] || await context.newPage();

  // Random starting mouse position (not 0,0)
  await page.mouse.move(rand(300, 900), rand(200, 500));

  console.log('📂 Navigating to Sales Navigator...');
  await page.goto(CONFIG.salesNavUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(rand(2500, 4000));

  // Handle login if needed
  if (page.url().includes('login')) {
    console.log('\n🔐 Please log in in the Chrome window. Waiting up to 3 min...\n');
    await page.waitForFunction(() => !window.location.href.includes('login'), null, { timeout: 180000, polling: 2000 });
    await page.goto(CONFIG.salesNavUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(rand(4000, 6000));
    console.log('✅ Logged in!\n');
  }

  // Wait for results, then browse naturally before scraping
  console.log('⏳ Waiting for results...');
  const foundSel = await waitForResults(page);
  if (!foundSel) {
    await page.screenshot({ path: path.join(__dirname, 'logs', 'linkedin_debug.png') });
    console.log('❌ Results did not load. Screenshot saved.');
    await context.close(); return;
  }

  const sentLog = loadSentLog();
  console.log(`📋 Sent log: ${sentLog.size} already contacted.\n`);

  const initialPage = parseInt(CONFIG.salesNavUrl.match(/[?&]page=(\d+)/)?.[1]) || 1;
  let sent = 0, skipped = 0, pageNum = initialPage;
  const sentLeads = []; // only leads we actually sent connection requests to — used for email enrichment
  const seenNames = new Set(); // for pagination loop detection
  let stalePages = 0;          // consecutive pages with no new lead names

  // ── Page loop: paginate until we have enough sends or run out of pages ───────
  outer:
  while (sent < CONFIG.maxRequests) {
    // Lazy-loaded content: scroll the results list to the bottom (slowly) before collecting,
    // otherwise unrendered rows have no /sales/lead/ link and get skipped silently
    console.log(`🔍 Page ${pageNum}: scrolling to lazy-load all rows...`);
    // Use mouse wheel + Page Down to mimic real scroll behavior — works with both window scroll
    // and any inner scroll container. Sales Nav virtualizes the list so we must drive the
    // visible viewport down to render all rows.
    await page.keyboard.press('End').catch(() => {});
    for (let i = 0; i < 10; i++) {
      await page.mouse.wheel(0, 800);
      await sleep(rand(400, 700));
    }
    await page.keyboard.press('End').catch(() => {});
    await sleep(rand(800, 1200));
    // Scroll back to top so the ... menus on the first leads are interactable
    await page.keyboard.press('Home').catch(() => {});
    await page.mouse.wheel(0, -10000);
    await sleep(rand(1200, 2000));

    console.log(`🔍 Page ${pageNum}: collecting leads...`);
    const leads = await collectLeads(page, sentLog);

    await browsePageNaturally(page);
    await sleep(rand(1000, 2000));
    // Only push successfully-sent leads to leads.json — moved into the sent-success branch below

    // Pagination loop detection: count how many names on this page are new
    const newNamesThisPage = leads.filter(l => !seenNames.has(l.name));
    newNamesThisPage.forEach(l => seenNames.add(l.name));
    if (newNamesThisPage.length === 0) {
      stalePages++;
      if (stalePages >= 3) {
        console.log(`⛔ Pagination loop detected (${stalePages} consecutive pages with no new leads). Stopping.`);
        break;
      }
    } else {
      stalePages = 0;
    }

    if (leads.length === 0) {
      console.log(`   ⏭️  All profiles on page ${pageNum} already viewed — skimming before moving on...`);
      await humanSkimViewedPage(page); // look human while deciding to go next
    } else {
      console.log(`   ✅ ${leads.length} unviewed lead(s) found.`);
      leads.forEach((l, i) => console.log(`     ${i + 1}. ${l.name} — ${l.title} @ ${l.company}`));
      console.log('');
    }

    for (let i = 0; i < leads.length && sent < CONFIG.maxRequests; i++) {
      const lead      = leads[i];
      const firstName = lead.name.split(' ')[0];
      const message   = buildMessage(firstName, lead.title, lead.company);

      // Already contacted in a previous run — skip silently
      if (sentLog.has(sentKey(lead))) {
        skipped++;
        console.log(`   ⏭️  ${lead.name} — already contacted, skipping.`);
        continue;
      }

      // Saved profile — glance at the row naturally then move on (same as humanSkimViewedPage row hover)
      if (lead.saved) {
        const savedRow = page.locator(`li.artdeco-list__item:has([data-anonymize="person-name"])`).filter({ hasText: lead.name }).first();
        const box = await savedRow.boundingBox().catch(() => null);
        if (box) {
          await humanScrollTo(page, savedRow);
          const x = Math.round(box.x + box.width  * (0.2 + Math.random() * 0.4));
          const y = Math.round(box.y + box.height * (0.3 + Math.random() * 0.4));
          await humanMoveTo(page, x, y);
          await sleep(rand(600, 1400)); // hover as if reading
        }
        skipped++;
        console.log(`   ⏭️  ${lead.name} — already saved, skipping.`);
        continue;
      }

      console.log(`\n[${sent + 1}/${CONFIG.maxRequests}] ${lead.name} — ${lead.title} @ ${lead.company}`);
      console.log(`   📝 "${message}"`);

      if (!lead.profileUrl) {
        console.log('   ⚠️  No profile URL, skipping.');
        skipped++; continue;
      }

      const result = await sendConnect(page, lead, message)
        .catch(err => ({ status: 'error', reason: err.message }));

      if (result.status === 'sent') {
        sent++;
        sentLog.add(sentKey(lead));
        saveSentLog(sentLog);
        sentLeads.push(lead);
        console.log(`   ✅ Sent! (${sent}/${CONFIG.maxRequests})`);
      } else {
        skipped++;
        console.log(`   ⚠️  ${result.reason || 'Skipped'}`);
      }

      if (sent >= CONFIG.maxRequests) break outer;

      // Human-like gap: 8–20s with occasional extra pause
      const gap = rand(8000, 20000) + (Math.random() < 0.2 ? rand(5000, 15000) : 0);
      console.log(`   ⏳ Pausing ${(gap / 1000).toFixed(0)}s...`);
      const gapStart = Date.now();
      while (Date.now() - gapStart < gap) {
        await sleep(rand(2000, 4000));
        if (Date.now() - gapStart < gap) await page.mouse.move(rand(200, 1200), rand(150, 700));
      }
    }

    if (sent >= CONFIG.maxRequests) break;

    // ── Navigate to next page via URL (button click was unreliable on Sales Nav) ──
    pageNum++;
    console.log(`\n📄 Moving to page ${pageNum}...`);

    const currentUrl = page.url();
    const nextUrl = currentUrl.includes('page=')
      ? currentUrl.replace(/([?&])page=\d+/, `$1page=${pageNum}`)
      : currentUrl + (currentUrl.includes('?') ? '&' : '?') + `page=${pageNum}`;

    await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(rand(3000, 5000));

    const foundSel2 = await waitForResults(page);
    if (!foundSel2) { console.log('❌ Next page did not load.'); break; }

  }

  // Save only successfully-sent leads to leads.json — these are the ones we'll enrich/email
  const leadsFile = path.join(__dirname, 'data', 'leads.json');
  let existing = [];
  if (fs.existsSync(leadsFile)) {
    try { existing = JSON.parse(fs.readFileSync(leadsFile, 'utf8')); } catch {}
  }
  const merged = [...existing];
  let newCount = 0;
  for (const lead of sentLeads) {
    if (!merged.find(l => l.name === lead.name)) { merged.push(lead); newCount++; }
  }
  fs.writeFileSync(leadsFile, JSON.stringify(merged, null, 2));
  console.log(`💾 Saved ${newCount} new lead(s) to leads.json (${merged.length} total)`);

  console.log('\n══════════════════════════════════════════');
  console.log(`✅ Done!  Sent: ${sent}  |  Skipped: ${skipped}  |  Pages: ${pageNum}`);
  console.log('══════════════════════════════════════════\n');

  await sleep(rand(2000, 4000));
  await context.close();
  setSleep(true);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
