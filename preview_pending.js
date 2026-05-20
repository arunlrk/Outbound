// Read-only preview: replicates zoho_send_emails.js's pending-list logic
// to show which leads would be sent next for a given sender email.
// Usage: node preview_pending.js <fromEmail> [count]

const fs = require('fs');
const path = require('path');

const FROM = process.argv[2];
const COUNT = parseInt(process.argv[3]) || 10;
if (!FROM) { console.error('Usage: node preview_pending.js <fromEmail> [count]'); process.exit(1); }

const CSV = path.join(__dirname, 'data', 'leads_with_emails.csv');
const LOG = path.join(__dirname, 'data', 'sent_emails_log.json');
const followUpDays = { 2: 3, 3: 7, 4: 14 };
const maxTouches = 4;

function splitCSVLine(line) {
  const fields = []; let inQuote = false, cur = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') { inQuote = !inQuote; continue; }
    if (line[i] === ',' && !inQuote) { fields.push(cur); cur = ''; continue; }
    cur += line[i];
  }
  fields.push(cur);
  return fields;
}
function parseCSV(p) {
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
  const headers = splitCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const fields = splitCSVLine(line);
    const obj = {}; headers.forEach((h, i) => obj[h] = (fields[i] || '').trim());
    return obj;
  }).filter(l => l.Email && l.Confidence !== 'no_domain');
}
function daysSince(iso) { return (Date.now() - new Date(iso).getTime()) / 86400000; }
function nextTouch(e) {
  if (!e) return 1;
  if (e.replied || e.bounced) return null;
  if (e.sends >= maxTouches) return null;
  const minDays = followUpDays[e.sends + 1] || 999;
  if (daysSince(e.lastSentAt) < minDays) return null;
  return e.sends + 1;
}

const leads = parseCSV(CSV).filter(l => l.Confidence === 'reoon_verified');
const log = JSON.parse(fs.readFileSync(LOG, 'utf8'));

const pending = [];
for (const lead of leads) {
  const entry = log[lead.Email];
  const touch = nextTouch(entry);
  if (!touch) continue;
  let lastSender = null;
  if (touch > 1) {
    lastSender = entry?.history?.slice(-1)[0]?.senderEmail;
    if (lastSender && lastSender !== FROM) continue;
  }
  pending.push({ lead, touch, lastSender, sends: entry?.sends || 0 });
}

// Follow-ups first (Touch 4 → 1)
pending.sort((a, b) => b.touch - a.touch);

const breakdown = pending.reduce((acc, { touch }) => { acc[touch] = (acc[touch] || 0) + 1; return acc; }, {});
console.log(`\nSender: ${FROM}`);
console.log(`Total eligible pending: ${pending.length}`);
console.log(`Breakdown: T1=${breakdown[1]||0}  T2=${breakdown[2]||0}  T3=${breakdown[3]||0}  T4=${breakdown[4]||0}`);
console.log(`\nNext ${Math.min(COUNT, pending.length)} (in send order):\n`);
console.log('#'.padEnd(3) + 'T  ' + 'Name'.padEnd(24) + 'Title'.padEnd(28) + 'Company'.padEnd(26) + 'Email'.padEnd(38) + 'Prev sender');
console.log('-'.repeat(150));
pending.slice(0, COUNT).forEach((p, i) => {
  const row = String(i+1).padEnd(3)
    + String(p.touch).padEnd(3)
    + (p.lead.Name || '').slice(0,23).padEnd(24)
    + (p.lead.Title || '').slice(0,27).padEnd(28)
    + (p.lead.Company || '').slice(0,25).padEnd(26)
    + (p.lead.Email || '').slice(0,37).padEnd(38)
    + (p.lastSender || '—');
  console.log(row);
});
console.log('');
