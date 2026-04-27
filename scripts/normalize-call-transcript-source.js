const fs = require('fs');

const filePath = 'data/call-transcripts.jsonl';

if (!fs.existsSync(filePath)) {
  console.log('File not found:', filePath);
  process.exit(0);
}

const rows = fs.readFileSync(filePath, 'utf8')
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

fs.writeFileSync(filePath, `${updated.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
console.log(JSON.stringify({ total: rows.length, changed }, null, 2));
