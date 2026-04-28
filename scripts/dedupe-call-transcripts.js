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

function dedupeKey(row) {
  if (String(row?.event || '') !== 'post_call_transcription') {
    return '';
  }

  const conversationId = String(row?.conversationId || '').trim();
  const callSid = String(row?.callSid || '').trim();

  if (callSid) {
    return ['post_call_transcription', 'callSid', callSid].join('|');
  }

  return ['post_call_transcription', 'conversationId', conversationId].join('|');
}

function score(row) {
  const messageCount = Array.isArray(row?.messages) ? row.messages.length : 0;
  const hasSnippet = String(row?.transcriptSnippet || '').trim() ? 1 : 0;
  const hasCallSid = String(row?.callSid || '').trim() ? 1 : 0;
  return (messageCount * 100) + (hasSnippet * 10) + hasCallSid;
}

const bestByKey = new Map();
for (const row of rows) {
  const key = dedupeKey(row);
  if (!key) {
    continue;
  }

  const existing = bestByKey.get(key);
  if (!existing || score(row) > score(existing)) {
    bestByKey.set(key, row);
  }
}

const outputRows = [];
let droppedCount = 0;

for (const row of rows) {
  const key = dedupeKey(row);
  if (!key) {
    outputRows.push(row);
    continue;
  }

  const best = bestByKey.get(key);
  if (best === row) {
    outputRows.push(row);
  } else {
    droppedCount += 1;
  }
}

fs.writeFileSync(filePath, `${JSON.stringify(outputRows, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ before: rows.length, after: outputRows.length, dropped: droppedCount }, null, 2));
