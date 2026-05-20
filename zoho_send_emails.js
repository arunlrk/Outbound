const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CHROME_SRC_PROFILE = 'C:\\Users\\arunl\\AppData\\Local\\Google\\Chrome\\User Data\\Default';
const TEMP_PROFILE_BASE  = 'C:\\Users\\arunl\\AppData\\Local\\Temp\\zohomail_playwright_ai';

// Each run gets its own directory so we never conflict with a previous run's Chrome instance
const TEMP_PROFILE_DIR = `${TEMP_PROFILE_BASE}_${Date.now()}`;

function copyProfile() {
  // Clean up old run directories (older than 2 hours) without touching the current one
  try {
    const base = path.dirname(TEMP_PROFILE_BASE);
    const prefix = path.basename(TEMP_PROFILE_BASE) + '_';
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const entry of fs.readdirSync(base)) {
      if (!entry.startsWith(prefix)) continue;
      const ts = parseInt(entry.slice(prefix.length));
      if (!isNaN(ts) && ts < cutoff) {
        fs.rmSync(path.join(base, entry), { recursive: true, force: true });
      }
    }
  } catch { /* ignore cleanup errors */ }

  fs.mkdirSync(path.join(TEMP_PROFILE_DIR, 'Default'), { recursive: true });
  console.log('🆕 Fresh browser session — please log in when Chrome opens.\n');
}

// Usage: node zoho_send_emails.js <fromEmail> [maxEmails]
// Example: node zoho_send_emails.js arun.kulkarni@cloudqa.ai 5
// The user is responsible for being logged into Zoho as <fromEmail>. The
// script does NOT change Zoho's From: dropdown — it trusts the logged-in
// mailbox/alias. Follow-ups are only sent to leads whose Touch 1 was sent
// from this same email, so threading stays consistent.
if (!process.argv[2] || !/@/.test(process.argv[2])) {
  console.error('Usage: node zoho_send_emails.js <fromEmail> [maxEmails]');
  console.error('Example: node zoho_send_emails.js arun.kulkarni@cloudqa.ai 5');
  process.exit(1);
}

const CONFIG = {
  chromeUserData:  TEMP_PROFILE_DIR,
  chromeExecutable:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  csvFile:         path.join(__dirname, 'data', 'leads_with_emails.csv'),
  zohoMailUrl:     'https://mail.zoho.com',
  fromEmail:       process.argv[2],
  maxEmails:       parseInt(process.argv[3]) || 5,
  onlyVerified:    true,  // only send to reoon_verified leads
  maxTouches:      4,     // stop after 4 emails per lead
  followUpDays:    { 2: 3, 3: 7, 4: 14 },
};

const SENT_LOG_FILE = path.join(__dirname, 'data', 'sent_emails_log.json');

// ── Log format: { [email]: { sends, lastSentAt, history: [{date, subject, touch}] } }
function loadSentLog() {
  try { return JSON.parse(fs.readFileSync(SENT_LOG_FILE, 'utf8')); } catch { return {}; }
}

function saveSentLog(log) {
  fs.writeFileSync(SENT_LOG_FILE, JSON.stringify(log, null, 2));
}

function recordSend(log, email, subject, touch, senderEmail) {
  if (!log[email]) log[email] = { sends: 0, lastSentAt: null, history: [] };
  log[email].sends++;
  log[email].lastSentAt = new Date().toISOString();
  log[email].history.push({ date: new Date().toISOString().slice(0, 10), subject, touch, senderEmail });
}

function daysSince(isoDate) {
  return (Date.now() - new Date(isoDate).getTime()) / 86400000;
}

// Returns which touch to send (1–4), or null if sequence complete / too soon / replied / bounced
function nextTouch(logEntry) {
  if (!logEntry) return 1;
  if (logEntry.replied) return null;                     // replied — stop sequence
  if (logEntry.bounced) return null;                     // bounced — stop sequence
  const { sends, lastSentAt } = logEntry;
  if (sends >= CONFIG.maxTouches) return null;           // sequence complete
  const minDays = CONFIG.followUpDays[sends + 1] || 999;
  if (daysSince(lastSentAt) < minDays) return null;      // too soon
  return sends + 1;
}

function recordReply(log, email) {
  if (!log[email]) log[email] = { sends: 0, lastSentAt: null, history: [] };
  log[email].replied   = true;
  log[email].repliedAt = new Date().toISOString();
}

function recordBounce(log, email) {
  if (!log[email]) log[email] = { sends: 0, lastSentAt: null, history: [] };
  log[email].bounced   = true;
  log[email].bouncedAt = new Date().toISOString();
}

// ── CSV parser (handles quoted fields with commas inside) ─────────────────────
function parseCSV(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
  const headers = splitCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const fields = splitCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => obj[h] = (fields[i] || '').trim());
    return obj;
  }).filter(l => l.Email && l.Confidence !== 'no_domain');
}

function splitCSVLine(line) {
  const fields = [];
  let inQuote = false, cur = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') { inQuote = !inQuote; continue; }
    if (line[i] === ',' && !inQuote) { fields.push(cur); cur = ''; continue; }
    cur += line[i];
  }
  fields.push(cur);
  return fields;
}

// ── Zoho Mail search box ──────────────────────────────────────────────────────
// Zoho's search input (#wms_menu_search) is hidden until its container is clicked.
// Strategy: try visible candidates first; if none, click the input's visible ancestor
// to activate the search area, then retry.
async function getZohoSearchBox(page) {
  const candidates = [
    () => page.getByPlaceholder(/search/i),
    () => page.getByRole('textbox', { name: /search/i }),
    () => page.getByRole('searchbox'),
    () => page.getByRole('combobox', { name: /search/i }),
    () => page.locator('input[type="search"]'),
    () => page.locator('input[id*="search" i]'),
    () => page.locator('input[type="text"]'),
  ];

  // Fast path: already visible
  for (const getter of candidates) {
    const loc = getter().first();
    if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) return loc;
  }

  // Slow path: click the input's visible parent container to activate it
  await page.evaluate(() => {
    const selectors = ['#wms_menu_search', 'input[id*="search" i]', 'input[type="search"]'];
    for (const sel of selectors) {
      const input = document.querySelector(sel);
      if (!input) continue;
      let el = input.parentElement;
      for (let i = 0; i < 8 && el && el !== document.body; i++) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 50 && rect.height > 10) { el.click(); input.focus(); return; }
        el = el.parentElement;
      }
    }
  }).catch(() => {});
  await sleep(rand(600, 1200));

  // Retry after activation
  for (const getter of candidates) {
    const loc = getter().first();
    if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) return loc;
  }

  // Diagnostic: dump visible top-bar elements so we can identify the correct selector
  const found = await page.evaluate(() =>
    [...document.querySelectorAll('*')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 30 && r.height > 10 && r.top >= 0 && r.top < 120;
    }).slice(0, 20).map(el =>
      `${el.tagName}[id=${el.id}][placeholder=${el.getAttribute('placeholder')||''}][role=${el.getAttribute('role')||''}][aria=${el.getAttribute('aria-label')||''}][contenteditable=${el.getAttribute('contenteditable')||''}]`
    ).join(' | ')
  ).catch(() => 'evaluate failed');
  console.warn(`[getZohoSearchBox] still not found. Top-bar elements: ${found}`);
  return null;
}

// ── Human-like timing helpers ────────────────────────────────────────────────
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function sleep(ms, jitter = 0) { return new Promise(r => setTimeout(r, ms + rand(0, jitter))); }
function thinkDelay() { return sleep(rand(800, 2200)); }
function readDelay()  { return sleep(rand(1500, 3500)); }
function microDelay() { return sleep(rand(80, 220)); }

// ── Human-like mouse movement (curved arc) ───────────────────────────────────
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

// ── Human-like typing (character by character, handles newlines) ──────────────
async function humanType(locator, text) {
  await sleep(rand(200, 500));
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\n') {
      await locator.press('Enter');
      await sleep(rand(80, 220));
    } else {
      await locator.pressSequentially(char, { delay: rand(45, 155) });
    }
    if (Math.random() < 0.04) await sleep(rand(400, 950));  // thinking pause
    if ([',', '.', '!', '?'].includes(char)) await sleep(rand(80, 260)); // post-punct pause
  }
}

// ── Browse inbox naturally at session start / during gaps ─────────────────────
async function browseInboxNaturally(page) {
  // Scroll down through inbox as if skimming subject lines
  const scrolls = rand(2, 4);
  for (let i = 0; i < scrolls; i++) {
    await page.mouse.wheel(0, rand(120, 320));
    await sleep(rand(700, 1900));
    if (Math.random() < 0.5) {
      await page.mouse.move(rand(250, 950), rand(200, 600));
      await sleep(rand(300, 800));
    }
  }
  // Hover over 1–2 email rows as if reading subject lines
  const rows = await page.locator('[role="row"]').all().catch(() => []);
  const targets = rows.sort(() => Math.random() - 0.5).slice(0, rand(1, 3));
  for (const row of targets) {
    const box = await row.boundingBox().catch(() => null);
    if (!box) continue;
    await humanMoveTo(page,
      Math.round(box.x + box.width * (0.2 + Math.random() * 0.4)),
      Math.round(box.y + box.height * 0.5)
    );
    await sleep(rand(500, 1500));
  }
  // Scroll back to top
  await page.mouse.wheel(0, -9999);
  await sleep(rand(500, 1000));
}

// ── Check inbox for a reply from a lead (inbox scan — no search box) ─────────
async function checkForReply(page, email) {
  // Navigate to Inbox first so we're scanning inbox rows, not search results
  const inboxItem = page.getByRole('treeitem', { name: /^inbox$/i }).first();
  if (await inboxItem.isVisible({ timeout: 2000 }).catch(() => false)) {
    await humanClick(page, inboxItem);
    await sleep(rand(1200, 2000));
  }
  const found = await page.evaluate((addr) => {
    const rows = [...document.querySelectorAll('[role="row"][aria-rowindex], [data-id]')];
    return rows.some(r => (r.innerText || r.textContent || '').toLowerCase().includes(addr.toLowerCase()));
  }, email).catch(() => false);
  return found;
}

// ── Check inbox for a bounce notification for this address (inbox scan — no search box) ──
async function checkForBounce(page, email) {
  // Navigate to Inbox first so we're scanning inbox rows, not search results
  const inboxItem = page.getByRole('treeitem', { name: /^inbox$/i }).first();
  if (await inboxItem.isVisible({ timeout: 2000 }).catch(() => false)) {
    await humanClick(page, inboxItem);
    await sleep(rand(1200, 2000));
  }
  const domain = email.split('@')[1] || '';
  const found = await page.evaluate((dom) => {
    const rows = [...document.querySelectorAll('[role="row"][aria-rowindex], [data-id]')];
    return rows.some(r => {
      const text = (r.innerText || r.textContent || '').toLowerCase();
      return /mailer-daemon|postmaster|undeliverable|delivery failed/.test(text) && text.includes(dom);
    });
  }, domain).catch(() => false);
  return found;
}

// ── Derive a friendly first name from an email address ───────────────────────
function nameFromEmail(email) {
  const local = email.split('@')[0].toLowerCase();
  if (/\barun\b|^akulkarni$/.test(local)) return 'Arun';
  if (/\bpaige\b|^ptrigg$/.test(local))   return 'Paige';
  // Generic fallback: capitalise first segment before . or _
  return local.split(/[._]/)[0].charAt(0).toUpperCase() + local.split(/[._]/)[0].slice(1);
}

// (Sender is taken from CONFIG.fromEmail — no detection, no rotation.)

// ── 4-touch email sequence — 3 variants per touch ────────────────────────────
const OPT_OUT_LINE = 'P.S. If you\'d rather not hear from me again, just reply "unsubscribe" and I\'ll remove you immediately.';

// Append the opt-out as a P.S. below the signature block.
function appendOptOut(body) {
  return body + '\n\n' + OPT_OUT_LINE;
}

function buildEmail(lead, touch, sender, prevSubject) {
  const firstName = lead.FirstName || lead.Name.split(' ')[0] || 'there';
  const company   = lead.Company || 'your company';
  const name      = sender.name;
  const v         = rand(0, 2); // pick variant 0, 1, or 2

  switch (touch) {
    case 1: return [
      {
        subject: `What if AI made QA less fragile at ${company}?`,
        body:
`Hi ${firstName},

Many engineering leaders I talk to are still wrestling with flaky test automation and long regression cycles.

CloudQA is an AI-powered, codeless automation platform that helps teams create and run end-to-end tests up to 10x faster than manual or scripted methods. Our smart recorder and self-healing automation keep tests stable so engineers spend less time fixing automation and more time shipping.

Curious if ${company} could use a faster, more reliable way to validate releases?

Best,
${name}
CloudQA | cloudqa.io`,
      },
      {
        subject: `Why QA still feels hard at ${company}`,
        body:
`Hi ${firstName},

QA should accelerate releases, not slow them down.

CloudQA removes the script maintenance burden with codeless regression automation. Teams get AI-powered reliability, visual-first playback, and diagnostics that make failures easy to fix.

Is 15 minutes worth it to see if ${company} can take QA off the critical path?

Best,
${name}
CloudQA | cloudqa.io`,
      },
      {
        subject: `Does QA automation still feel like a project?`,
        body:
`Hi ${firstName},

If your team is spending more time babysitting tests than shipping code, there is a better way.

CloudQA helps engineering teams build and run tests with no code, parallel execution, and smarter stability. The result is less manual testing, fewer flaky runs, and faster releases.

Would you be open to a quick 15-minute review?

Best,
${name}
CloudQA | cloudqa.io`,
      },
    ][v];

    case 2: {
      const reSubject = prevSubject ? `Re: ${prevSubject}` : `Still thinking about AI-driven QA at ${company}`;
      return [
        {
          subject: reSubject,
          body:
`Hi ${firstName},

Circling back on my note — inboxes get busy.

CloudQA lets teams create tests in minutes, run them in parallel, and use AI diagnostics to resolve failures faster.

Does that sound worth a quick call for ${company}?

Best,
${name}
CloudQA | cloudqa.io`,
        },
        {
          subject: `A question about your regression process`,
          body:
`Hi ${firstName},

Quick question: is QA automation causing more rework than it solves?

CloudQA's recorder and self-healing engine are built so tests stay stable as your app changes, instead of breaking every sprint.

Could we review whether ${company} can move faster with this?

Best,
${name}
CloudQA | cloudqa.io`,
        },
        {
          subject: reSubject,
          body:
`Hi ${firstName},

Most engineering leaders I speak with say automation is only worth it if it stops being a full-time project.

CloudQA makes regression testing easier with no scripts to maintain, detailed video playback, and one portal for web, mobile, API, and performance testing.

If you're open, I can send over a quick 15-minute slot.

Best,
${name}
CloudQA | cloudqa.io`,
        },
      ][v];
    }

    case 3: {
      const reSubject = prevSubject ? `Re: ${prevSubject}` : `Still thinking about AI-driven QA at ${company}`;
      return [
      {
        subject: `What if tests stayed stable as the app changes?`,
        body:
`Hi ${firstName},

One more note: teams using CloudQA are moving from slow regression cycles to continuous test execution without hiring more QA.

If ${company} needs a more sustainable way to keep quality high, this might be worth 15 minutes.

Best,
${name}
CloudQA | cloudqa.io`,
      },
      {
        subject: reSubject,
        body:
`Hi ${firstName},

CloudQA's goal is simple: let engineering teams automate end-to-end testing without writing or babysitting tests.

The platform includes AI-assisted test creation, parallel run schedules, and clear diagnostics so failures are easy to fix.

Would you like a short demo?

Best,
${name}
CloudQA | cloudqa.io`,
      },
      {
        subject: reSubject,
        body:
`Hi ${firstName},

If regression testing is still a recurring drag at ${company}, CloudQA can make it a reliable part of your release process.

No code, full coverage, faster execution, and a cleaner handoff between engineering and QA.

Open to a short call?

Best,
${name}
CloudQA | cloudqa.io`,
      },
    ][v];
    }

    case 4: {
      const reSubject = prevSubject ? `Re: ${prevSubject}` : `Last quick thought on AI for QA at ${company}`;
      return [
      {
        subject: `Last quick note about QA at ${company}`,
        body:
`Hi ${firstName},

This is my final note — no more emails from me.

If ${company} ever wants a faster, maintenance-free way to automate regression tests, CloudQA is built for exactly that.

Best,
${name}
CloudQA | cloudqa.io`,
      },
      {
        subject: reSubject,
        body:
`Hi ${firstName},

Quick final follow-up: if QA automation still feels like too much overhead, I’d be happy to show how CloudQA simplifies it with no code and stable tests.

Feel free to reach out anytime.

Best,
${name}
CloudQA | cloudqa.io`,
      },
      {
        subject: reSubject,
        body:
`Hi ${firstName},

I'll stop here, but wanted to leave the door open: CloudQA helps teams create tests quickly, keep them reliable, and reduce QA maintenance.

If that becomes relevant, I'm available.

Best,
${name}
CloudQA | cloudqa.io`,
      },
    ][v];
    }
  }
}

// ── Wait for mailbox to be ready ─────────────────────────────────────────────
async function waitForMailbox(page) {
  await page.waitForSelector('[data-testid="new-btn-opt"]', { timeout: 30000 });
}

// ── Close any leftover compose windows ───────────────────────────────────────
async function closeStuckComposeWindows(page) {
  const discardBtns = page.locator('button[title="Discard"], button[aria-label="Discard"]');
  const count = await discardBtns.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    await discardBtns.first().click().catch(() => {});
    await sleep(500);
    const confirm = page.locator('button:has-text("Discard"), button:has-text("OK")').first();
    if (await confirm.isVisible({ timeout: 1000 }).catch(() => false)) {
      await confirm.click().catch(() => {});
      await sleep(500);
    }
  }
}

// ── Select From address in an open compose window ────────────────────────────
// ── Send one email (Touch 1 and all follow-ups use the same compose flow) ────
// The user is responsible for being logged into Zoho as CONFIG.fromEmail —
// the script doesn't touch the From: dropdown. Whatever Zoho's default From
// is for the logged-in mailbox is what gets sent.
async function sendEmail(page, lead, touch, sender, prevSubject) {

  // Close any stuck compose windows from previous failed attempts
  await closeStuckComposeWindows(page);

  // Click New Mail
  const newMailBtn = page.locator('[data-testid="new-btn-opt"]').first();
  if (!await newMailBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    return { status: 'error', reason: 'New Mail button not found' };
  }
  await humanClick(page, newMailBtn);
  await thinkDelay();
  await sleep(rand(1000, 2000));

  const { subject, body: rawBody } = buildEmail(lead, touch, sender, prevSubject);
  const body = appendOptOut(rawBody);
  console.log(`   ✉️  Sending as: ${sender.name} <${sender.email}>`);

  // Fill To — typed, not pasted
  const toField = page.getByRole('combobox', { name: 'To Recipients' });
  await humanClick(page, toField);
  await humanType(toField, lead.Email);
  await sleep(rand(300, 600));
  await page.keyboard.press('Enter');
  await microDelay();

  // Fill Subject — typed
  await thinkDelay();
  const subjectField = page.getByRole('textbox', { name: 'Subject' });
  await humanClick(page, subjectField);
  await humanType(subjectField, subject);

  // Fill Body — scope iframe to the active compose panel to avoid strict mode violation
  await thinkDelay();
  const activeCompose = page.locator('[id^="zmComposeEditor_"]').last();
  const bodyEditor = activeCompose.locator('iframe[title="Text editor area"]')
    .contentFrame()
    .getByLabel('Rich text editor area');
  await humanClick(page, bodyEditor);
  await sleep(rand(400, 800));
  await humanType(bodyEditor, body);

  await readDelay(); // "reviewing" the draft before sending

  // Send
  const sendBtn = page.getByRole('button', { name: 'Send', exact: true });
  if (!await sendBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    return { status: 'error', reason: 'Send button not found' };
  }
  await humanClick(page, sendBtn);
  await sleep(rand(2000, 3500));

  const confirmed = await checkSentToRecipient(page, lead.Email, subject);
  return confirmed
    ? { status: 'sent', subject }
    : { status: 'error', reason: `Subject "${subject}" not found in Sent folder after sending` };
}

// ── Verify send by checking the Sent folder for the subject of the email just sent ─
async function checkSentToRecipient(page, recipientEmail, subject) {
  try {
    // Wait for Zoho to process the send before navigating to Sent
    await sleep(rand(2500, 4000));
    await page.mouse.move(rand(200, 600), rand(300, 600));
    await sleep(rand(600, 1200));

    // Click Sent folder naturally
    const sentItem = page.getByRole('treeitem', { name: /^sent$/i }).first();
    if (!await sentItem.isVisible({ timeout: 3000 }).catch(() => false)) return false;
    await humanClick(page, sentItem);
    await sleep(rand(2000, 3000));

    // Skim the Sent list like a human — scroll slightly, move mouse over rows
    await page.mouse.wheel(0, rand(60, 150));
    await sleep(rand(400, 900));
    await page.mouse.move(rand(300, 900), rand(250, 500));
    await sleep(rand(500, 1000));

    // Check for the subject — up to 3 attempts with increasing waits
    for (let attempt = 0; attempt < 3; attempt++) {
      const found = await page.evaluate((subj) => {
        return (document.body.innerText || '').includes(subj);
      }, subject).catch(() => false);

      if (found) {
        await sleep(rand(800, 1600));
        await page.mouse.move(rand(200, 700), rand(300, 550));
        await sleep(rand(400, 800));
        const inboxItem = page.getByRole('treeitem', { name: /^inbox$/i }).first();
        if (await inboxItem.isVisible({ timeout: 2000 }).catch(() => false)) {
          await humanClick(page, inboxItem);
          await sleep(rand(1000, 2000));
        }
        return true;
      }
      // Reload the Sent folder on retries to pick up newly arrived items
      await humanClick(page, sentItem);
      await sleep(rand(2500, 4000));
    }

    // Return to Inbox even on failure
    const inboxItem = page.getByRole('treeitem', { name: /^inbox$/i }).first();
    if (await inboxItem.isVisible({ timeout: 2000 }).catch(() => false)) {
      await humanClick(page, inboxItem);
      await sleep(rand(800, 1500));
    }
    return false;
  } catch { return false; }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  copyProfile();

  console.log('\n📂 Loading leads from CSV...');
  const allLeads = parseCSV(CONFIG.csvFile);
  const leads = CONFIG.onlyVerified
    ? allLeads.filter(l => l.Confidence === 'reoon_verified')
    : allLeads;
  console.log(`📋 ${leads.length} ${CONFIG.onlyVerified ? 'reoon_verified' : 'total'} leads loaded.`);

  const sentLog = loadSentLog();
  const totalLogged = Object.keys(sentLog).length;
  console.log(`📋 Sent log: ${totalLogged} lead(s) in sequence.\n`);

  const { spawn } = require('child_process');
  let _caffeinate = null;
  const setSleep = (enable) => {
    if (!enable) {
      _caffeinate = spawn('powershell', ['-noprofile', '-Command',
        `Add-Type -Name W -Member '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);' -Namespace W; while($true){[W.W]::SetThreadExecutionState(0x80000003); Start-Sleep 60}`
      ], { detached: false, stdio: 'ignore' });
    } else if (_caffeinate) {
      _caffeinate.kill();
      _caffeinate = null;
    }
  };
  setSleep(false);

  console.log('\n🚀 Launching Chrome...');
  const context = await chromium.launchPersistentContext(CONFIG.chromeUserData, {
    executablePath: CONFIG.chromeExecutable,
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

  console.log('📂 Navigating to Zoho Mail...');
  await page.goto(CONFIG.zohoMailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(rand(2500, 4000));

  if (!page.url().includes('mail.zoho.com/zm/')) {
    console.log('\n🔐 Please log in in the Chrome window. Waiting up to 3 min...\n');
    await page.waitForFunction(
      () => window.location.href.includes('mail.zoho.com/zm/'),
      undefined,
      { timeout: 180000, polling: 2000 }
    );
    await sleep(rand(3000, 5000));
    console.log('✅ Logged in!\n');
  }

  await waitForMailbox(page);
  console.log('✅ Mailbox ready.\n');

  const sessionSender = { name: nameFromEmail(CONFIG.fromEmail), email: CONFIG.fromEmail };
  console.log(`📨 Sending as: ${sessionSender.name} <${sessionSender.email}>\n`);

  // Build pending list. For follow-ups: only include leads where Touch 1 was
  // sent from this same email — keeps threading consistent across touches.
  const pending = [];
  for (const lead of leads) {
    const logEntry = sentLog[lead.Email];
    const touch = nextTouch(logEntry);
    if (!touch) continue;
    if (touch > 1) {
      const lastSenderEmail = logEntry?.history?.slice(-1)[0]?.senderEmail;
      // If a previous touch recorded a different sender, skip — belongs to that sender's run
      if (lastSenderEmail && lastSenderEmail !== CONFIG.fromEmail) continue;
    }
    pending.push({ lead, touch });
  }

  // Prioritize follow-ups over new cold sends: Touch 4 → 3 → 2 → 1
  pending.sort((a, b) => b.touch - a.touch);

  const bTouch = pending.reduce((acc, { touch }) => { acc[touch] = (acc[touch] || 0) + 1; return acc; }, {});
  console.log(`📬 ${pending.length} email(s) ready to send:`);
  Object.entries(bTouch).forEach(([t, n]) => console.log(`   Touch ${t}: ${n} lead(s)`));
  console.log('');

  if (pending.length === 0) {
    console.log('✅ Nothing due for this sender. Run again with the correct sender or when follow-up windows open.');
    await context.close(); return;
  }

  // Glance at inbox before doing anything — like a real person would
  console.log('👀 Browsing inbox naturally before starting...');
  await browseInboxNaturally(page);
  await sleep(rand(1500, 3000));

  let sent = 0, skipped = 0;

  for (const { lead, touch } of pending) {
    if (sent >= CONFIG.maxEmails) break;

    const touchLabels = { 1: 'Initial', 2: 'Follow-up 1', 3: 'Follow-up 2', 4: 'Breakup' };
    console.log(`\n[${sent + 1}/${CONFIG.maxEmails}] ${lead.Name} — ${lead.Title} @ ${lead.Company}`);
    console.log(`   📧 ${lead.Email}  |  Touch ${touch}: ${touchLabels[touch]}  |  From: ${CONFIG.fromEmail}`);

    // Before every follow-up, check for bounces and replies
    if (touch > 1) {
      // Always start from Inbox so the search box is in a clean, consistent state
      const inboxReset = page.getByRole('treeitem', { name: /^inbox$/i }).first();
      if (await inboxReset.isVisible({ timeout: 3000 }).catch(() => false)) {
        await humanClick(page, inboxReset);
        await sleep(rand(1000, 2000));
      }

      console.log(`   🔍 Checking for bounce...`);
      const bounced = await checkForBounce(page, lead.Email).catch(() => null);
      if (bounced === null) {
        console.log(`   ⚠️  Bounce check inconclusive — skipping ${lead.Name} to be safe.`);
        skipped++;
        continue;
      }
      if (bounced) {
        console.log(`   ⛔ Bounce detected — stopping sequence for ${lead.Name}.`);
        recordBounce(sentLog, lead.Email);
        saveSentLog(sentLog);
        skipped++;
        continue;
      }
      console.log(`   🔍 Checking for replies...`);
      const replied = await checkForReply(page, lead.Email).catch(() => null);
      if (replied === null) {
        console.log(`   ⚠️  Reply check inconclusive — skipping ${lead.Name} to be safe.`);
        skipped++;
        continue;
      }
      if (replied) {
        console.log(`   💬 Reply detected — stopping sequence for ${lead.Name}.`);
        recordReply(sentLog, lead.Email);
        saveSentLog(sentLog);
        skipped++;
        continue;
      }
      console.log(`   ✓ No bounce or reply — proceeding.`);
    }

    const prevSubject = sentLog[lead.Email]?.history?.find(h => h.touch === 1)?.subject;
    const result = await sendEmail(page, lead, touch, sessionSender, prevSubject)
      .catch(err => ({ status: 'error', reason: err.message }));

    if (result.status === 'sent') {
      sent++;
      recordSend(sentLog, lead.Email, result.subject, touch, CONFIG.fromEmail);
      saveSentLog(sentLog);
      console.log(`   ✅ Sent! (${sent}/${CONFIG.maxEmails})`);
      if (touch === CONFIG.maxTouches) console.log(`   🏁 Sequence complete for ${lead.Name}.`);
    } else {
      skipped++;
      console.log(`   ⚠️  ${result.reason || 'Failed'}`);
    }

    if (sent >= CONFIG.maxEmails) break;

    // Human-like gap: 15–45s, occasional longer pause
    const gap = rand(15000, 45000) + (Math.random() < 0.15 ? rand(10000, 30000) : 0);
    console.log(`   ⏳ Pausing ${(gap / 1000).toFixed(0)}s...`);
    const gapStart = Date.now();
    // 40% chance to browse inbox during the gap instead of just idling
    if (Math.random() < 0.4) await browseInboxNaturally(page);
    // Fill remaining time with natural idle behaviour
    while (Date.now() - gapStart < gap) {
      const idle = rand(1500, 5000);
      await sleep(idle);
      if (Date.now() - gapStart < gap) {
        // Occasionally drift mouse, occasionally do nothing
        if (Math.random() < 0.6) await page.mouse.move(rand(200, 1200), rand(150, 700));
      }
    }
  }

  // Print sequence status summary
  console.log('\n── Sequence status ───────────────────────────────');
  const updatedLog = loadSentLog();
  const byTouch = [0, 0, 0, 0, 0];
  let repliedCount = 0;
  for (const entry of Object.values(updatedLog)) {
    if (entry.replied) { repliedCount++; continue; }
    byTouch[Math.min(entry.sends, 4)]++;
  }
  console.log(`  Touch 1 sent, awaiting follow-up : ${byTouch[1]}`);
  console.log(`  Touch 2 sent, awaiting follow-up : ${byTouch[2]}`);
  console.log(`  Touch 3 sent, awaiting breakup   : ${byTouch[3]}`);
  console.log(`  Sequence complete (4 touches)    : ${byTouch[4]}`);
  console.log(`  Replied — removed from sequence  : ${repliedCount}`);
  console.log('──────────────────────────────────────────────────');

  console.log('\n══════════════════════════════════════════');
  console.log(`✅ Done!  Sent: ${sent}  |  Skipped: ${skipped}`);
  console.log('══════════════════════════════════════════\n');

  await sleep(rand(2000, 4000));
  await context.close();
  setSleep(true);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
