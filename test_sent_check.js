// test_sent_check.js
// Sends one email to a test address, then verifies the Sent folder check works.
// Usage: node test_sent_check.js <testEmail>
// Example: node test_sent_check.js arun.kulkarni@cloudqa.ai

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const TEMP_PROFILE_DIR = 'C:\\Users\\arunl\\AppData\\Local\\Temp\\zohomail_playwright_ai';
const TEST_EMAIL = process.argv[2] || 'arun.kulkarni@cloudqa.ai';
const TEST_SUBJECT = `CloudQA sent-check test ${Date.now()}`;

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function checkSentToRecipient(page, recipientEmail, subject) {
  const sentItem = page.getByRole('treeitem', { name: /^sent$/i }).first();
  if (!await sentItem.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log('❌ Sent folder not visible');
    return false;
  }
  await sentItem.click();
  await sleep(rand(2000, 3000));

  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await page.evaluate((subj) => {
      const bodyText = document.body.innerText || '';
      const inBody = bodyText.includes(subj);
      // Also log what selectors exist for debugging
      const roleCounts = {
        'role=row': document.querySelectorAll('[role="row"]').length,
        'data-id': document.querySelectorAll('[data-id]').length,
        'li[id]': document.querySelectorAll('li[id]').length,
        'tr': document.querySelectorAll('tr').length,
      };
      return { inBody, roleCounts };
    }, subject).catch(() => ({ inBody: false, roleCounts: {} }));

    console.log(`   Attempt ${attempt}: in body text → ${result.inBody}, selectors: ${JSON.stringify(result.roleCounts)}`);
    if (result.inBody) return true;
    await sleep(2000);
  }
  return false;
}

async function main() {
  // Reuse existing session if present, else start fresh
  if (!fs.existsSync(TEMP_PROFILE_DIR)) {
    fs.mkdirSync(`${TEMP_PROFILE_DIR}\\Default`, { recursive: true });
    console.log('🆕 Fresh session — please log in when Chrome opens.\n');
  }

  const context = await chromium.launchPersistentContext(TEMP_PROFILE_DIR, {
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: false,
    viewport: null,
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://mail.zoho.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  if (!page.url().includes('mail.zoho.com/zm/')) {
    console.log('🔐 Please log in. Waiting up to 3 min...');
    await page.waitForFunction(() => window.location.href.includes('mail.zoho.com/zm/'), undefined, { timeout: 180000, polling: 2000 });
    await sleep(3000);
    console.log('✅ Logged in.\n');
  }

  await page.waitForSelector('[data-testid="new-btn-opt"]', { timeout: 30000 });
  console.log(`📧 Sending test email to ${TEST_EMAIL}`);
  console.log(`   Subject: "${TEST_SUBJECT}"\n`);

  // Compose and send
  await page.locator('[data-testid="new-btn-opt"]').first().click();
  await sleep(2000);

  const toField = page.getByRole('combobox', { name: 'To Recipients' });
  await toField.click();
  await toField.pressSequentially(TEST_EMAIL, { delay: 60 });
  await sleep(400);
  await page.keyboard.press('Enter');
  await sleep(800);
  await page.keyboard.press('Escape'); // dismiss any autocomplete dropdown
  await sleep(500);

  const subjectField = page.getByRole('textbox', { name: 'Subject' });
  await subjectField.click();
  await subjectField.pressSequentially(TEST_SUBJECT, { delay: 50 });
  await sleep(500);

  const activeCompose = page.locator('[id^="zmComposeEditor_"]').last();
  const bodyEditor = activeCompose.locator('iframe[title="Text editor area"]')
    .contentFrame()
    .getByLabel('Rich text editor area');
  await bodyEditor.click();
  await bodyEditor.pressSequentially('This is an automated sent-check test. You can delete this.', { delay: 40 });
  await sleep(1000);

  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await sleep(3000);

  // Now verify
  console.log('🔍 Checking Sent folder for subject...');
  const verified = await checkSentToRecipient(page, TEST_EMAIL, TEST_SUBJECT);

  if (verified) {
    console.log('\n✅ Sent folder check WORKS — subject found.');
  } else {
    console.log('\n❌ Sent folder check FAILED — subject not found after 3 attempts.');
    const screenshotPath = path.join(__dirname, 'logs', 'sent_check_debug.png');
    await page.screenshot({ path: screenshotPath });
    console.log(`   Screenshot saved: ${screenshotPath}`);
  }

  await sleep(3000);
  await context.close();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
