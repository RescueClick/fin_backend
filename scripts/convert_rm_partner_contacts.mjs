import fs from 'fs';
import path from 'path';

const inputCsvPath = 'C:\\Users\\sanja\\Downloads\\shansource contacts\\rm-partner-followups (1).csv';
const outputDir = 'C:\\Users\\sanja\\Downloads\\shansource contacts';
const downloadsDir = 'C:\\Users\\sanja\\Downloads';

function parseCSV(content) {
  const rows = [];
  let currentRow = [];
  let currentField = '';
  let insideQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (char === '"') {
      if (insideQuotes && nextChar === '"') {
        currentField += '"';
        i++; // skip escaped quote
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (char === ',' && !insideQuotes) {
      currentRow.push(currentField);
      currentField = '';
    } else if ((char === '\r' || char === '\n') && !insideQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i++;
      }
      currentRow.push(currentField);
      if (currentRow.length > 1 || currentRow[0] !== '') {
        rows.push(currentRow);
      }
      currentRow = [];
      currentField = '';
    } else {
      currentField += char;
    }
  }

  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  return rows;
}

function cleanPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return `+${digits}`;
}

function escapeCsv(val) {
  const s = String(val == null ? '' : val);
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function run() {
  console.log(`Reading CSV from: ${inputCsvPath}`);
  const csvRaw = fs.readFileSync(inputCsvPath, 'utf8');
  const rows = parseCSV(csvRaw);

  if (rows.length < 2) {
    console.error('CSV has no data rows!');
    return;
  }

  const header = rows[0].map(h => h.trim().replace(/^"|"$/g, ''));
  console.log('Detected headers:', header);

  const colPartner = header.indexOf('Partner');
  const colId = header.indexOf('Employee ID');
  const colPhone = header.indexOf('Phone');
  const colApps = header.indexOf('Apps');
  const colFilled = header.indexOf('Filled');
  const colPerf = header.indexOf('Performance');
  const colStatus = header.indexOf('Call Status');
  const colRemarks = header.indexOf('Remarks');
  const colLastCall = header.indexOf('Last Call');

  const contacts = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 3) continue;

    const partnerName = (row[colPartner] || '').trim();
    const employeeId = (row[colId] || '').trim();
    const phoneRaw = (row[colPhone] || '').trim();
    const apps = (row[colApps] || '0').trim();
    const filled = (row[colFilled] || 'No').trim();
    const perf = (row[colPerf] || '').trim();
    const callStatus = (row[colStatus] || '').trim();
    const remarks = (row[colRemarks] || '').trim();
    const lastCall = (row[colLastCall] || '').trim();

    const formattedPhone = cleanPhone(phoneRaw);
    if (!formattedPhone) continue;

    const nameParts = partnerName.split(/\s+/).filter(Boolean);
    const firstName = nameParts[0] || partnerName;
    const lastName = nameParts.slice(1).join(' ') || '';

    // Contact name with "DS " prefix: "DS Prabhakar Prasad (TLP0512)"
    const displayName = employeeId ? `DS ${partnerName} (${employeeId})` : `DS ${partnerName}`;
    const givenName = `DS ${firstName}`;
    const familyName = lastName;

    const notes = [
      `DhanSource Partner`,
      employeeId ? `Partner ID: ${employeeId}` : '',
      `Performance: ${perf === 'working' ? 'Working' : 'Non-Working'}`,
      `Applications: ${apps}`,
      `Loan Form Filled: ${filled}`,
      callStatus ? `Call Status: ${callStatus}` : '',
      lastCall ? `Last Call: ${lastCall}` : '',
      remarks ? `Remarks: ${remarks.replace(/\r?\n/g, ' ')}` : '',
    ].filter(Boolean).join(' | ');

    contacts.push({
      displayName,
      givenName,
      familyName,
      employeeId,
      phone: formattedPhone,
      partnerName,
      perf,
      apps,
      notes,
    });
  }

  console.log(`Parsed ${contacts.length} valid partner contacts with phone numbers.`);

  // 1. Google Contacts CSV
  const googleHeaders = [
    'Name',
    'Given Name',
    'Additional Name',
    'Family Name',
    'Yomi Name',
    'Given Name Yomi',
    'Additional Name Yomi',
    'Family Name Yomi',
    'Name Prefix',
    'Name Suffix',
    'Initials',
    'Nickname',
    'Short Name',
    'Maiden Name',
    'Birthday',
    'Gender',
    'Location',
    'Billing Information',
    'Directory Server',
    'Mileage',
    'Occupation',
    'Hobby',
    'Sensitivity',
    'Priority',
    'Subject',
    'Notes',
    'Group Membership',
    'E-mail 1 - Type',
    'E-mail 1 - Value',
    'Phone 1 - Type',
    'Phone 1 - Value',
    'Organization 1 - Type',
    'Organization 1 - Name',
    'Organization 1 - Title',
  ];

  const googleCsvRows = [googleHeaders.join(',')];
  for (const c of contacts) {
    const row = [
      escapeCsv(c.displayName),
      escapeCsv(c.givenName),
      '', // Additional Name
      escapeCsv(c.familyName),
      '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
      escapeCsv(c.notes),
      escapeCsv('* myContacts ::: DhanSource Partners'),
      '', '', // Email
      'Mobile',
      escapeCsv(c.phone),
      'Work',
      escapeCsv('DhanSource Capital'),
      escapeCsv(c.employeeId ? `Partner - ${c.employeeId}` : 'Partner'),
    ];
    googleCsvRows.push(row.join(','));
  }

  const googleCsvContent = googleCsvRows.join('\r\n');

  // 2. Universal vCard (.vcf)
  const vcfCards = [];
  for (const c of contacts) {
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${c.displayName}`,
      `N:${c.familyName};${c.givenName};;;`,
      `ORG:DhanSource Capital;`,
      `TITLE:Partner ${c.employeeId || ''}`,
      `TEL;TYPE=CELL,VOICE:${c.phone}`,
      `NOTE:${c.notes}`,
      `CATEGORIES:DhanSource Partners`,
      'END:VCARD',
    ].join('\r\n');
    vcfCards.push(vcard);
  }
  const vcfContent = vcfCards.join('\r\n') + '\r\n';

  // Output paths
  const googleCsvPath1 = path.join(outputDir, 'dhansource_partners_google_contacts.csv');
  const vcfPath1 = path.join(outputDir, 'dhansource_partners.vcf');

  const googleCsvPath2 = path.join(downloadsDir, 'dhansource_partners_google_contacts.csv');
  const vcfPath2 = path.join(downloadsDir, 'dhansource_partners.vcf');

  fs.writeFileSync(googleCsvPath1, googleCsvContent, 'utf8');
  fs.writeFileSync(vcfPath1, vcfContent, 'utf8');
  console.log(`Saved: ${googleCsvPath1}`);
  console.log(`Saved: ${vcfPath1}`);

  try {
    fs.writeFileSync(googleCsvPath2, googleCsvContent, 'utf8');
    fs.writeFileSync(vcfPath2, vcfContent, 'utf8');
    console.log(`Saved also to root Downloads: ${googleCsvPath2}`);
    console.log(`Saved also to root Downloads: ${vcfPath2}`);
  } catch (err) {
    console.warn('Could not write to root Downloads (may be locked), folder copy is ready:', err.message);
  }

  console.log('\n--- SUMMARY ---');
  console.log(`Total Partners Converted: ${contacts.length}`);
  console.log(`Working: ${contacts.filter(c => c.perf === 'working').length}`);
  console.log(`Non-Working: ${contacts.filter(c => c.perf === 'non_working').length}`);
  console.log('DONE!');
}

run();

