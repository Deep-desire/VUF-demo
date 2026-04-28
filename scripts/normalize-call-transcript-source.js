const fs = require('fs');

const filePath = 'data/call-transcripts.json';

if (!fs.existsSync(filePath)) {
  console.log('File not found:', filePath);
  process.exit(0);
}

const raw = fs.readFileSync(filePath, 'utf8');
const trimmed = raw.trim();
let rows = [];

if (trimmed.startsWith('[')) {
  const parsed = JSON.parse(trimmed);
  rows = Array.isArray(parsed) ? parsed : [];
} else {
  rows = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

let changed = 0;

const updated = rows.map((row) => {
  if (String(row?.source || '') === 'elevenlabs') {
    return row;
  }

  changed += 1;
  return {
    ...row,
    source: 'elevenlabs'
  };
});

fs.writeFileSync(filePath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ total: rows.length, changed }, null, 2));
