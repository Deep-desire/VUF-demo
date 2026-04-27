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

let dropped = 0;
let changed = 0;

const normalized = rows
  .filter((row) => {
    const event = String(row?.event || '').trim();
    const keep = event === 'full-conversation-finalized' || event === 'post_call_transcription';
    if (!keep) {
      dropped += 1;
    }
    return keep;
  })
  .map((row) => {
    const next = { ...row };

    if (String(next.source || '') !== 'elevenlabs') {
      next.source = 'elevenlabs';
      changed += 1;
    }

    if (String(next.event || '') !== 'post_call_transcription') {
      next.event = 'post_call_transcription';
      changed += 1;
    }

    const messages = Array.isArray(next.messages) ? next.messages : [];
    const transcriptSnippet = String(next.transcriptSnippet || '').trim();

    if (messages.length === 0) {
      next.messages = [{ role: 'system', text: transcriptSnippet || placeholder }];
      changed += 1;
    }

    if (!transcriptSnippet) {
      next.transcriptSnippet = placeholder;
      changed += 1;
    }

    return next;
  });

fs.writeFileSync(filePath, `${normalized.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
console.log(JSON.stringify({ before: rows.length, after: normalized.length, dropped, changed }, null, 2));
