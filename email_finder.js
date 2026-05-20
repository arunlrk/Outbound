// email_finder.js
// Reads leads.json → finds company domain → generates email patterns → Reoon-verifies → outputs CSV

const dns  = require('dns').promises;
const fs   = require('fs');
const https = require('https');
const path = require('path');

const LEADS_FILE  = path.join(__dirname, 'data', 'leads.json');
const OUTPUT_FILE = path.join(__dirname, 'data', 'leads_with_emails.csv');

// ── Config — replace key if you regenerate it in Reoon dashboard ──────────────
const REOON_API_KEY = '';
const REOON_MODE    = 'power'; // 'power' uses ~5 credits but catches catch-all and invalid accurately

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const CREDENTIAL_PATTERN = /\b(PhD|MBA|MD|JD|CPA|CFA|CFP|CISSP|CPHIMS|FHIMSS|CISM|PMP|ATC|CHC|DPT|PT|QKA|QPFC|CRPC|CIMA|CEBS|CBP|SHRM|SPHR|PHR|CAPM|CSM|CSPO|AWS|GCP|CTP|CRP|CAIA|FRM|CPFA|ERPA|AIFA|AIF|RPA|CFA®|MBA\/TM|CFP®|®)\b/gi;

function splitName(fullName) {
  let name = fullName.split(',')[0].trim();
  name = name.replace(CREDENTIAL_PATTERN, '').replace(/\s+/g, ' ').trim();
  const parts = name.split(' ').filter(p => p.length > 0);
  if (parts.length === 0) return { firstName: fullName, lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts[parts.length - 1] };
}

// ── Reoon verification with global rate limiter ───────────────────────────────
// Returns: 'valid' | 'safe' | 'invalid' | 'catch_all' | 'unknown' | 'error'

const REOON_INTERVAL = 250; // ms minimum between any two Reoon calls
let lastReoonCall = 0;

async function reoonVerify(email) {
  const wait = REOON_INTERVAL - (Date.now() - lastReoonCall);
  if (wait > 0) await sleep(wait);
  lastReoonCall = Date.now();

  return new Promise((resolve) => {
    const url = `https://emailverifier.reoon.com/api/v1/verify?email=${encodeURIComponent(email)}&key=${REOON_API_KEY}&mode=${REOON_MODE}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data).status || 'unknown'); }
        catch { resolve('error'); }
      });
    }).on('error', () => resolve('error'));
  });
}

// ── Domain discovery ──────────────────────────────────────────────────────────

const STRIP_WORDS = /\b(inc|llc|ltd|corp|corporation|co|company|group|solutions|services|technologies|technology|systems|health|healthcare|partners|consulting|international|global|the|and|of|for|a|an)\b/gi;

function companyToDomainCandidates(company) {
  const base = company
    .replace(STRIP_WORDS, '')
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .trim();

  const noSpace    = base.replace(/\s+/g, '').toLowerCase();
  const hyphenated = base.replace(/\s+/g, '-').toLowerCase();

  const candidates = [];
  const tlds = ['.com', '.io', '.co', '.org', '.net', '.health', '.ai', '.us', '.bank', '.app'];
  for (const stem of [...new Set([noSpace, hyphenated])]) {
    if (stem.length < 2) continue;
    for (const tld of tlds) candidates.push(`${stem}${tld}`);
  }
  return candidates;
}

async function resolveDomain(domain) {
  try { await dns.resolveMx(domain); return true; } catch {}
  try { await dns.resolve4(domain);  return true; } catch {}
  return false;
}

async function findDomain(company) {
  const candidates = companyToDomainCandidates(company);
  for (const candidate of candidates) {
    if (await resolveDomain(candidate)) return candidate;
  }
  return null;
}

// ── Email pattern generation ──────────────────────────────────────────────────

function emailPatterns(firstName, lastName, domain) {
  const f = firstName.toLowerCase().replace(/[^a-z]/g, '');
  const l = lastName.toLowerCase().replace(/[^a-z]/g, '');
  if (!f || !l) return [`${f || l}@${domain}`];
  return [
    `${f}.${l}@${domain}`,   // most common: john.smith
    `${f}@${domain}`,         // john
    `${f[0]}${l}@${domain}`,  // jsmith
    `${f[0]}.${l}@${domain}`, // j.smith
    `${f}${l}@${domain}`,     // johnsmith
    `${l}@${domain}`,         // smith
  ];
}

// ── Core enrichment ───────────────────────────────────────────────────────────

async function enrichLead(lead) {
  const { firstName, lastName } = splitName(lead.name);
  const f = firstName.toLowerCase().replace(/[^a-z]/g, '');
  const l = lastName.toLowerCase().replace(/[^a-z]/g, '');

  // Use domain scraped by profile_enricher.js, or fall back to DNS discovery
  const domain = lead.domain || await findDomain(lead.company);
  if (!domain) return { ...lead, domain: '', email: '', confidence: 'no_domain' };

  // 2. Try each email pattern with Reoon (power mode detects catch-all)
  const patterns = emailPatterns(firstName, lastName, domain);
  for (const email of patterns) {
    const status = await reoonVerify(email);
    if (status === 'valid' || status === 'safe') {
      return { ...lead, domain, email, confidence: 'reoon_verified' };
    }
    if (status === 'catch_all') {
      const guess = `${f}.${l}@${domain}`;
      return { ...lead, domain, email: guess, confidence: 'catch_all_guessed' };
    }
    // 'invalid', 'unknown', 'error' → try next pattern
  }

  // 3. Nothing verified — best-guess fallback
  const guess = `${f}.${l}@${domain}`;
  return { ...lead, domain, email: guess, confidence: 'guessed' };
}

// ── CSV helpers ───────────────────────────────────────────────────────────────

const CSV_HEADER = 'FirstName,LastName,Name,Title,Company,Domain,Email,Confidence,ProfileUrl';

function toCSVRow(r) {
  const { firstName, lastName } = splitName(r.name);
  return [firstName, lastName, r.name, r.title, r.company, r.domain, r.email, r.confidence, r.profileUrl || '']
    .map(v => `"${(v || '').replace(/"/g, '""')}"`)
    .join(',');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (REOON_API_KEY === 'PASTE_NEW_KEY_HERE') {
    console.error('\n❌ Please update REOON_API_KEY in email_finder.js before running.\n');
    process.exit(1);
  }

  if (!fs.existsSync(LEADS_FILE)) {
    console.error(`\n❌ ${LEADS_FILE} not found.\n   Run linkedin_connect.js first — it saves leads.json automatically.\n`);
    process.exit(1);
  }

  const leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));

  // Load already-processed names from existing CSV so we skip them
  const alreadyDone = new Set();
  if (fs.existsSync(OUTPUT_FILE)) {
    const lines = fs.readFileSync(OUTPUT_FILE, 'utf8').split('\n').slice(1); // skip header
    for (const line of lines) {
      if (!line.trim()) continue;
      // Name is now the 3rd column (index 2) after FirstName, LastName
      const fields = [...line.matchAll(/"([^"]*)"/g)].map(m => m[1]);
      const name = fields[2];
      if (name) alreadyDone.add(name);
    }
  }

  // Only process leads enriched by profile_enricher.js (have scraped domain).
  // DNS-guessed domains lead to high bounce rates.
  const newLeads = leads.filter(l => l.domain && !alreadyDone.has(l.name));
  const skippedNoDomain = leads.filter(l => !l.domain && !alreadyDone.has(l.name)).length;
  console.log(`\n📋 ${leads.length} total leads — ${alreadyDone.size} already done — processing ${newLeads.length} enriched (skipping ${skippedNoDomain} not yet enriched)...\n`);

  if (newLeads.length === 0) {
    console.log('✅ Nothing new to process.\n');
    return;
  }

  // Write header only if file is new
  if (!fs.existsSync(OUTPUT_FILE)) {
    fs.writeFileSync(OUTPUT_FILE, CSV_HEADER + '\n');
  }

  const counts = { reoon_verified: 0, catch_all_guessed: 0, guessed: 0, no_domain: 0, error: 0 };
  const CONCURRENCY = 3;
  let completed = 0;

  for (let i = 0; i < newLeads.length; i += CONCURRENCY) {
    const batch = newLeads.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(lead =>
      enrichLead(lead).catch(err => ({ ...lead, domain: '', email: '', confidence: 'error', _err: err.message }))
    ));
    for (const enriched of results) {
      completed++;
      const icon = enriched.confidence === 'reoon_verified'    ? '✅'
                 : enriched.confidence === 'catch_all_guessed' ? '⚠️ '
                 : enriched.confidence === 'no_domain'         ? '❌'
                 : enriched.confidence === 'error'             ? '💥'
                 :                                               '🤔';
      console.log(`[${completed}/${newLeads.length}] ${icon} ${enriched.name} — ${enriched.email || 'no email'} (${enriched.confidence})`);
      counts[enriched.confidence] = (counts[enriched.confidence] || 0) + 1;
      fs.appendFileSync(OUTPUT_FILE, toCSVRow(enriched) + '\n');
    }
  }

  console.log('\n══════════════════════════════════════════════════');
  console.log('✅ Done!');
  console.log(`   Reoon verified:   ${counts.reoon_verified    || 0}  (power mode — valid/safe)`);
  console.log(`   Catch-all guess:  ${counts.catch_all_guessed || 0}`);
  console.log(`   Pattern guess:    ${counts.guessed           || 0}`);
  console.log(`   No domain found:  ${counts.no_domain         || 0}`);
  console.log(`   Output:           ${OUTPUT_FILE}`);
  console.log('══════════════════════════════════════════════════\n');
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
