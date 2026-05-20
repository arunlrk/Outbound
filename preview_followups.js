// Show all pending follow-ups (Touch 2-4), grouped by the sender that owns them.
const fs = require('fs');
const path = require('path');

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
  }).filter(l => l.Email);
}
function daysSince(iso) { return (Date.now() - new Date(iso).getTime()) / 86400000; }
function nextTouch(e) {
  if (!e || e.replied || e.bounced) return e ? null : 1;
  if (e.sends >= maxTouches) return null;
  const minDays = followUpDays[e.sends + 1] || 999;
  if (daysSince(e.lastSentAt) < minDays) return null;
  return e.sends + 1;
}

const leadsByEmail = {};
for (const l of parseCSV(CSV)) leadsByEmail[l.Email] = l;
const log = JSON.parse(fs.readFileSync(LOG, 'utf8'));

// Group pending follow-ups by owning sender
const groups = {};   // sender -> [{lead, touch, daysSinceLast}]
const notDue = {};   // sender -> count of in-sequence leads not yet due

for (const [email, entry] of Object.entries(log)) {
  if (entry.replied || entry.bounced) continue;
  if (entry.sends === 0 || entry.sends >= maxTouches) continue;
  const lastSender = entry.history?.slice(-1)[0]?.senderEmail || '(unknown)';
  const touch = nextTouch(entry);
  const lead = leadsByEmail[email] || { Name: '(not in CSV)', Title: '', Company: '', Email: email };
  const since = daysSince(entry.lastSentAt);
  if (touch) {
    (groups[lastSender] = groups[lastSender] || []).push({ lead, touch, since, lastAt: entry.lastSentAt });
  } else {
    notDue[lastSender] = (notDue[lastSender] || 0) + 1;
  }
}

console.log('\n── Pending follow-ups (Touch 2-4), grouped by sender ──\n');
const senders = Object.keys({ ...groups, ...notDue }).sort();
if (senders.length === 0) { console.log('No leads in active sequences.\n'); process.exit(0); }

for (const sender of senders) {
  const due = groups[sender] || [];
  const waiting = notDue[sender] || 0;
  console.log(`▸ ${sender}`);
  console.log(`  Due now: ${due.length}   |   In sequence but not yet due: ${waiting}`);
  if (due.length === 0) { console.log(''); continue; }
  due.sort((a, b) => b.touch - a.touch);
  console.log('  ' + 'T  ' + 'Name'.padEnd(22) + 'Company'.padEnd(24) + 'Email'.padEnd(38) + 'Last sent');
  console.log('  ' + '-'.repeat(110));
  for (const p of due) {
    console.log('  '
      + String(p.touch).padEnd(3)
      + (p.lead.Name || '').slice(0,21).padEnd(22)
      + (p.lead.Company || '').slice(0,23).padEnd(24)
      + (p.lead.Email || '').slice(0,37).padEnd(38)
      + `${p.since.toFixed(1)}d ago`);
  }
  console.log('');
}
