// verify_existing.js
// Re-checks all reoon_verified rows in leads_with_emails.csv
// Uses Reoon power mode to detect catch-all domains and updates confidence accordingly

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const CSV_FILE      = path.join(__dirname, 'data', 'leads_with_emails.csv');
const REOON_API_KEY = '';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Reoon power-mode verification ─────────────────────────────────────────────
// Returns: { status, is_catchall } or { status: 'error' }
function reoonPowerVerify(email) {
  return new Promise((resolve) => {
    const url = `https://emailverifier.reoon.com/api/v1/verify?email=${encodeURIComponent(email)}&key=${REOON_API_KEY}&mode=power`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: json.status || 'unknown', is_catchall: json.is_catchall || false });
        } catch { resolve({ status: 'error', is_catchall: false }); }
      });
    }).on('error', () => resolve({ status: 'error', is_catchall: false }));
  });
}

// ── CSV parser (handles quoted fields) ───────────────────────────────────────
function parseCSVLine(line) {
  const fields = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      fields.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function toCSVField(val) {
  return `"${(val || '').replace(/"/g, '""')}"`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(CSV_FILE)) {
    console.error(`❌ ${CSV_FILE} not found.`);
    process.exit(1);
  }

  const raw   = fs.readFileSync(CSV_FILE, 'utf8');
  const lines = raw.split('\n');
  const header = lines[0];
  const rows   = lines.slice(1).filter(l => l.trim());

  // Parse all rows
  const parsed = rows.map(l => parseCSVLine(l));
  // Header: FirstName,LastName,Name,Title,Company,Domain,Email,Confidence,ProfileUrl
  const COL = { domain: 5, email: 6, confidence: 7 };

  // Collect rows that need re-checking
  const rowsToCheck = parsed
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r[COL.confidence] === 'reoon_verified' && r[COL.email]);

  console.log(`\n📋 ${parsed.length} total rows`);
  console.log(`🔍 ${rowsToCheck.length} reoon_verified email(s) to re-check with power mode\n`);

  if (rowsToCheck.length === 0) {
    console.log('✅ Nothing to re-check.\n');
    return;
  }

  // Re-verify each email with power mode
  let updated = 0;
  for (let i = 0; i < rowsToCheck.length; i++) {
    const { r, i: rowIdx } = rowsToCheck[i];
    const email = r[COL.email];
    process.stdout.write(`  [${i + 1}/${rowsToCheck.length}] ${email.padEnd(50)}`);

    const { status, is_catchall } = await reoonPowerVerify(email);

    if (is_catchall || status === 'catch_all') {
      parsed[rowIdx][COL.confidence] = 'catch_all_guessed';
      updated++;
      console.log(`⚠️  catch-all`);
    } else if (status === 'invalid') {
      parsed[rowIdx][COL.confidence] = 'invalid';
      updated++;
      console.log(`❌ invalid`);
    } else if (status === 'valid') {
      console.log(`✅ valid`);
    } else {
      console.log(`❓ ${status}`);
    }

    await sleep(400); // stay within Reoon rate limits
  }

  const newRows = parsed.map(r => r.map(toCSVField).join(','));
  fs.writeFileSync(CSV_FILE, header + '\n' + newRows.join('\n') + '\n');

  console.log(`\n✅ Done — ${updated} row(s) updated`);
  console.log(`💾 Saved to ${CSV_FILE}\n`);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
