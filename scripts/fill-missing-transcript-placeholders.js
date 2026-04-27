const fs = require('fs');

const filePath = 'data/call-transcripts.jsonl';
const placeholder = 'Transcript not available: no ElevenLabs transcript webhook was received for this call.';

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

let updated = 0;

const nextRows = rows.map((row) => {
  if (String(row?.event || '') !== 'full-conversation-finalized') {
    return row;
  }

  const messages = Array.isArray(row?.messages) ? row.messages : [];
  const snippet = String(row?.transcriptSnippet || '').trim();
  if (messages.length > 0 || snippet) {
    return row;
  }

  updated += 1;
  return {
    ...row,
    messages: [{ role: 'system', text: placeholder }],
    transcriptSnippet: placeholder
  };
});

fs.writeFileSync(filePath, `${nextRows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
console.log(JSON.stringify({ total: rows.length, updated }, null, 2));
