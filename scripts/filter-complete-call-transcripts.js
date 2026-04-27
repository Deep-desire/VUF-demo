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

const hasRealTranscript = (row) => {
  const snippet = String(row?.transcriptSnippet || '').trim();
  const isUnavailable = snippet.toLowerCase().startsWith('transcript not available:');
  const messages = Array.isArray(row?.messages) ? row.messages : [];
  const realMessage = messages.some((item) => {
    const role = String(item?.role || '').trim().toLowerCase();
    const text = String(item?.text || '').trim();
    return Boolean(text) && role !== 'system';
  });

  return realMessage || (Boolean(snippet) && !isUnavailable);
};

const filtered = rows.filter((row) => String(row?.event || '').trim() === 'post_call_transcription' && hasRealTranscript(row));

fs.writeFileSync(filePath, `${filtered.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
console.log(JSON.stringify({ before: rows.length, after: filtered.length, removed: rows.length - filtered.length }, null, 2));
