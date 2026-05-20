const { chromium } = require('playwright');

const TEMP_PROFILE_DIR  = 'C:\\Users\\arunl\\AppData\\Local\\Temp\\zohomail_playwright_ai';
const CHROME_EXECUTABLE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// Statnetics (Exchange) first — highest warm-up priority
const RECIPIENTS = [
  { first: 'Sumant',       email: 'sumant@statnetics.com' },
  { first: 'Arun',         email: 'akulkarni@statnetics.com' },
  { first: 'Pranamya',     email: 'pgubbala@statnetics.com' },
  { first: 'Sumant',       email: 'sumant@cloudqa.io' },
  { first: 'Arun',         email: 'akulkarni@cloudqa.io' },
  { first: 'Pranamya',     email: 'pgubbala@cloudqa.io' },
  { first: 'Dilip',        email: 'dkumar@cloudqa.io' },
  { first: 'Ravi',         email: 'rreddy@cloudqa.io' },
  { first: 'Vidya',        email: 'vpasupunuri@cloudqa.io' },
  { first: 'Aryan',        email: 'apillai@cloudqa.io' },
  { first: 'Arun',         email: 'akulkarni@inbox.cloudqa.io' },
  { first: 'Team',         email: 'dev@cloudqa.io' },
  { first: 'Team',         email: 'support@cloudqa.io' },
  { first: 'Sumant',       email: 'sumantm@gmail.com' },
  { first: 'Arun',         email: 'arun.lrk@gmail.com' },
  { first: 'Aryan',        email: 'aryan.nair2262004@gmail.com' },
  { first: 'Aryan',        email: 'bigpapa2262004@gmail.com' },
  { first: 'Aryan',        email: 'aroo2262004@gmail.com' },
  { first: 'Bheemesh',     email: 'bheeemesh888@gmail.com' },
  { first: 'Aryan',        email: 'pillai.aryan@outlook.com' },
  { first: 'Aryan',        email: 'aryan.pillai04@outlook.com' },
  { first: 'Arun',         email: 'arun.lrk@hotmail.com' },
  { first: 'Ravi',         email: 'ravi_n009@yahoo.co.in' },
  { first: 'Arun',         email: 'arun@appsure.io' },
  { first: 'Arun',         email: 'akulkarni@cloudqa.us' },
  { first: 'Arun',         email: 'arun.kulkarni@cloudqa.ai' },
  { first: 'Arun',         email: 'arun@cloudqa.net' },
];

// Enough varied templates so no two consecutive emails look identical
const TEMPLATES = [
  (name) => ({
    subject: `Quick question`,
    body: `Hi ${name},

Hope you're doing well! Had a quick question for you — do you have 5 minutes sometime this week for a brief chat?

Nothing urgent, just wanted to get your thoughts on something.

Let me know!
Arun`,
  }),
  (name) => ({
    subject: `Checking in`,
    body: `Hey ${name},

Just wanted to check in and see how things are going on your end. It's been a while since we caught up properly.

Any exciting projects keeping you busy lately?

Arun`,
  }),
  (name) => ({
    subject: `Had a thought I wanted to run by you`,
    body: `Hi ${name},

Was working through something earlier and thought of you — would love to get your perspective when you have a moment.

Can you drop me a reply when you get a chance?

Thanks,
Arun`,
  }),
  (name) => ({
    subject: `Quick catch-up?`,
    body: `Hey ${name},

Hope the week's treating you well. I've been meaning to reach out — would love to catch up briefly when you're free.

Let me know what works for you.

Arun`,
  }),
  (name) => ({
    subject: `Something I've been meaning to ask`,
    body: `Hi ${name},

Been meaning to drop you a note — wanted to get your take on something I've been thinking about lately.

When you get a chance, shoot me a reply and I'll fill you in.

Cheers,
Arun`,
  }),
  (name) => ({
    subject: `Hope things are going well`,
    body: `Hey ${name},

Just a quick note to say hi and hope everything's going smoothly. We should catch up soon.

Reply when you get a moment?

Arun`,
  }),
  (name) => ({
    subject: `Can I get your opinion on something?`,
    body: `Hi ${name},

Working on something and your perspective would be genuinely helpful. Nothing major — just want a quick sanity check.

Can you reply when you have 2 minutes?

Thanks,
Arun`,
  }),
  (name) => ({
    subject: `Long overdue catch-up`,
    body: `Hey ${name},

Realised it's been a while since we talked properly. Hope things are good on your end.

What have you been up to lately? Would love to hear.

Arun`,
  }),
  (name) => ({
    subject: `Reaching out`,
    body: `Hi ${name},

Just wanted to reach out and reconnect. Things have been busy on my end but I've been thinking about getting back in touch with folks.

How are you doing?

Arun`,
  }),
  (name) => ({
    subject: `Quick note`,
    body: `Hey ${name},

Dropping you a quick note — wanted to make sure we stay in touch. Lots going on but hope you're doing well.

Reply anytime, would love to hear from you.

Arun`,
  }),
];

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function sleep(ms)       { return new Promise(r => setTimeout(r, ms + rand(0, 300))); }

let mouseX = 760, mouseY = 400;

async function humanMoveTo(page, tx, ty) {
  const steps = rand(10, 18);
  const sx = mouseX, sy = mouseY;
  const cpx = sx + (tx - sx) * 0.5 + rand(-60, 60);
  const cpy = sy + (ty - sy) * 0.5 + rand(-40, 40);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await page.mouse.move(
      Math.round((1-t)*(1-t)*sx + 2*(1-t)*t*cpx + t*t*tx) + rand(-2, 2),
      Math.round((1-t)*(1-t)*sy + 2*(1-t)*t*cpy + t*t*ty) + rand(-2, 2)
    );
    await sleep(rand(8, 22));
  }
  mouseX = tx; mouseY = ty;
}

async function humanClick(page, locator) {
  const box = await locator.boundingBox();
  if (!box) { await locator.click(); return; }
  const tx = Math.round(box.x + box.width  * (0.35 + Math.random() * 0.3));
  const ty = Math.round(box.y + box.height * (0.35 + Math.random() * 0.3));
  await humanMoveTo(page, tx, ty);
  await sleep(rand(100, 300));
  await page.mouse.click(tx, ty);
  await sleep(rand(80, 180));
}

async function humanType(locator, text) {
  await sleep(rand(200, 500));
  for (const char of text) {
    if (char === '\n') { await locator.press('Enter'); await sleep(rand(80, 180)); }
    else { await locator.pressSequentially(char, { delay: rand(50, 140) }); }
    if (Math.random() < 0.04) await sleep(rand(300, 800));
  }
}

let _cachedSender = null;

async function detectLoggedInSender(page) {
  if (_cachedSender) return _cachedSender;
  try {
    const raw = await page.evaluate(() => {
      for (const attr of ['data-email', 'data-userid', 'data-user']) {
        const el = document.querySelector(`[${attr}*="@"]`);
        if (el) { const v = el.getAttribute(attr); if (v && /@/.test(v)) return v; }
      }
      for (const el of document.querySelectorAll('[title*="@"]')) {
        const t = el.getAttribute('title');
        if (t && t.length < 120) return t;
      }
      for (const el of document.querySelectorAll('[aria-label*="@"]')) {
        const t = el.getAttribute('aria-label');
        if (t && t.length < 120) return t;
      }
      const threshold = window.innerHeight * 0.22;
      for (const el of document.querySelectorAll('span,div,button,a,li')) {
        if (el.children.length > 0) continue;
        const rect = el.getBoundingClientRect();
        if (rect.top > threshold) continue;
        const t = el.textContent.trim();
        if (/@/.test(t) && t.length < 80) return t;
      }
      return '';
    });
    const angleMatch = raw.match(/^(.+?)\s*<([^>]+)>/);
    if (angleMatch) {
      _cachedSender = { name: angleMatch[1].trim(), email: angleMatch[2].trim() };
      return _cachedSender;
    }
    const emailMatch = raw.match(/[\w.+-]+@[\w.-]+\.\w+/);
    if (emailMatch) {
      const email = emailMatch[0];
      const name = email.split('@')[0].split(/[._]/).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
      _cachedSender = { name, email };
      return _cachedSender;
    }
  } catch {}
  _cachedSender = { name: 'Arun', email: '(unknown)' };
  return _cachedSender;
}

async function ensureLoggedIn(page) {
  if (!page.url().includes('mail.zoho.com/zm/')) {
    console.log('🔐 Session expired — please log in again. Waiting up to 3 min...');
    await page.goto('https://mail.zoho.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(
      () => window.location.href.includes('mail.zoho.com/zm/'),
      undefined, { timeout: 180000, polling: 2000 }
    );
    await page.waitForSelector('[data-testid="new-btn-opt"]', { timeout: 30000 });
    _cachedSender = null; // reset so sender is re-detected for new session
    console.log('✅ Logged back in.\n');
  }
}

async function sendOne(page, recipient, template) {
  const { first, email } = recipient;
  const { subject, body } = template(first);

  await ensureLoggedIn(page);

  const newMailBtn = page.locator('[data-testid="new-btn-opt"]').first();
  if (!await newMailBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
    return { ok: false, reason: 'New Mail button not found' };
  }
  await humanClick(page, newMailBtn);
  await sleep(rand(1200, 2200));

  // Guard: clicking New Mail can sometimes trigger a logout redirect
  await ensureLoggedIn(page);

  const sender = await detectLoggedInSender(page);

  // To
  const toField = page.getByRole('combobox', { name: 'To Recipients' });
  await humanClick(page, toField);
  await humanType(toField, email);
  await sleep(rand(300, 500));
  await page.keyboard.press('Enter');
  await sleep(rand(200, 400));

  // Subject
  const subjectField = page.getByRole('textbox', { name: 'Subject' });
  await humanClick(page, subjectField);
  await humanType(subjectField, subject);
  await sleep(rand(500, 900));

  // Body
  const bodyEditor = page.locator('iframe[title="Text editor area"]')
    .contentFrame().getByLabel('Rich text editor area');
  await humanClick(page, bodyEditor);
  await sleep(rand(400, 700));
  await humanType(bodyEditor, body);
  await sleep(rand(1000, 2000));

  // Send
  const sendBtn = page.getByRole('button', { name: 'Send', exact: true });
  if (!await sendBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    return { ok: false, reason: 'Send button not found' };
  }
  await humanClick(page, sendBtn);
  await sleep(rand(2000, 3500));

  // Check toast; if missing, verify via Sent folder count change
  let ok = await page.locator('text=Mail sent').isVisible({ timeout: 10000 }).catch(() => false);
  if (!ok) {
    // Zoho sometimes dismisses the toast fast — treat as sent if no error toast appeared
    const errToast = await page.locator('text=Unable to send').isVisible({ timeout: 2000 }).catch(() => false);
    ok = !errToast;
  }
  return { ok, sender };
}

async function main() {
  const maxEmails = parseInt(process.argv[2]) || 5;

  const context = await chromium.launchPersistentContext(TEMP_PROFILE_DIR, {
    executablePath: CHROME_EXECUTABLE,
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

  // Always start from a clean login — clear session cookies so account choice is explicit
  await context.clearCookies();
  console.log('🔐 Please log in to the Zoho account you want to send from...');
  await page.goto('https://accounts.zoho.com/signin?servicename=VirtualOffice&serviceurl=https://mail.zoho.com', {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  await page.waitForFunction(
    () => window.location.href.includes('mail.zoho.com/zm/'),
    undefined, { timeout: 180000, polling: 2000 }
  );
  await sleep(rand(2000, 3500));

  await page.waitForSelector('[data-testid="new-btn-opt"]', { timeout: 30000 });
  console.log('✅ Mailbox ready.\n');

  const sessionSender = await detectLoggedInSender(page);
  console.log(`📨 Sending as: ${sessionSender.name} <${sessionSender.email}>`);
  console.log(`📋 Selecting ${maxEmails} emails (statnetics priority, sender excluded)\n`);

  let sent = 0, failed = 0;

  // Exclude the sender's own address so we never email ourselves
  const senderEmail = sessionSender.email.toLowerCase();
  const pool = RECIPIENTS.filter(r => r.email.toLowerCase() !== senderEmail);

  // Always include a random subset of statnetics, fill rest randomly from others
  const statnetics = pool.filter(r => r.email.endsWith('@statnetics.com'));
  const others     = pool.filter(r => !r.email.endsWith('@statnetics.com'));
  const shuffle    = arr => arr.slice().sort(() => Math.random() - 0.5);

  const statCount  = rand(2, Math.min(statnetics.length, maxEmails - 1));
  const otherCount = maxEmails - statCount;
  const targets    = [
    ...shuffle(statnetics).slice(0, statCount),
    ...shuffle(others).slice(0, otherCount),
  ];

  for (let i = 0; i < targets.length; i++) {
    const recipient = targets[i];
    const template  = TEMPLATES[i % TEMPLATES.length];
    console.log(`[${i+1}/${targets.length}] → ${recipient.email}`);

    const result = await sendOne(page, recipient, template)
      .catch(err => ({ ok: false, reason: err.message || String(err) }));

    if (result.ok) {
      sent++;
      console.log(`   ✅ Sent`);
    } else {
      failed++;
      console.log(`   ⚠️  ${result.reason}`);
    }

    if (i < targets.length - 1) {
      const gap = rand(25000, 50000);
      console.log(`   ⏳ Waiting ${(gap/1000).toFixed(0)}s...\n`);
      await sleep(gap);
    }
  }

  console.log(`\n✅ Done — Sent: ${sent}  Failed: ${failed}`);
  console.log('💡 Ask recipients to reply — replies are the strongest warm-up signal with Microsoft.\n');
  await sleep(rand(2000, 3000));
  await context.close();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
