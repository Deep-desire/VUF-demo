require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const net = require('net');
const xlsx = require('xlsx');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', true);

// Allow browser-based local testing even when tester page is opened via file://.
app.use((req, res, next) => {
  const requestOrigin = String(req.headers.origin || '').trim();
  const requestHeaders = String(req.headers['access-control-request-headers'] || '').trim();

  // Echoing explicit origin helps strict browsers with file:// (Origin: null) preflights.
  res.header('Access-Control-Allow-Origin', requestOrigin || '*');
  res.header('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', requestHeaders || 'Content-Type, Authorization, X-Requested-With');
  res.header('Access-Control-Max-Age', '600');

  // Needed by some Chromium-based browsers for public -> private network preflights.
  if (String(req.headers['access-control-request-private-network'] || '').toLowerCase() === 'true') {
    res.header('Access-Control-Allow-Private-Network', 'true');
  }

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  return next();
});

app.use(bodyParser.json({
  limit: '2mb'
}));
app.use(bodyParser.urlencoded({ extended: false }));

const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;
const recentEvents = [];
const activeCallsByPhone = new Map();
const activeCallsByConversationId = new Map();
const activeCallMetaBySid = new Map();
const conversationAggregateByCallSid = new Map();
const conversationAggregateByConversationId = new Map();
const TRANSFER_ELIGIBLE_STATUSES = ['in-progress', 'ringing', 'queued'];
const CONVERSATION_LOG_RETENTION_LIMIT = (() => {
  const raw = Number(process.env.CONVERSATION_LOG_RETENTION_LIMIT || 2000);
  if (!Number.isFinite(raw)) {
    return 2000;
  }

  return Math.max(50, Math.min(50000, Math.round(raw)));
})();
const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
const supabaseServiceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const supabaseConversationLogTable = String(process.env.SUPABASE_CONVERSATION_LOG_TABLE || 'conversation_logs').trim();
const supabaseCallTranscriptTable = String(process.env.SUPABASE_CALL_TRANSCRIPT_TABLE || 'call_transcripts').trim();
let supabaseClient = null;
const callQualificationWorkbookFilePath = path.isAbsolute(String(process.env.CALL_QUALIFICATION_WORKBOOK_FILE || '').trim())
  ? String(process.env.CALL_QUALIFICATION_WORKBOOK_FILE || '').trim()
  : path.join(__dirname, String(process.env.CALL_QUALIFICATION_WORKBOOK_FILE || 'data/call-qualifications.xlsx').trim());

const REQUIRED_ENV = [
  'ELEVENLABS_AGENT_ID',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER'
];

function getCompanyName() {
  return String(process.env.COMPANY_NAME || 'Vishv Umiya Foundation').trim();
}

function getMaxCallSeconds() {
  const raw = Number(process.env.MAX_CALL_SECONDS || 120);
  if (!Number.isFinite(raw)) {
    return 120;
  }

  return Math.max(30, Math.min(600, Math.round(raw)));
}

function getDialTimeoutSeconds() {
  const raw = Number(process.env.TWILIO_DIAL_TIMEOUT_SECONDS || 30);
  if (!Number.isFinite(raw)) {
    return 30;
  }

  return Math.max(5, Math.min(60, Math.round(raw)));
}

function getPublicBaseUrl() {
  const raw = process.env.PUBLIC_BASE_URL || process.env.NGROK_PUBLIC_URL || '';
  return String(raw).trim().replace(/\/+$/, '');
}

function normalizePublicBaseUrl(raw = '') {
  const trimmed = String(raw || '').trim().replace(/\/+$/, '');
  if (!trimmed) {
    return '';
  }

  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return '';
    }

    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
}

function getSupabaseClient() {
  if (!supabaseUrl || !supabaseServiceKey) {
    return null;
  }

  if (!supabaseClient) {
    supabaseClient = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
  }

  return supabaseClient;
}

function isPrivateOrLoopbackHostname(hostname = '') {
  const normalized = String(hostname || '').trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  if (normalized === 'localhost' || normalized === '::1') {
    return true;
  }

  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) {
    const octets = normalized.split('.').map((item) => Number(item));
    if (octets.length !== 4 || octets.some((item) => !Number.isFinite(item))) {
      return true;
    }

    const [a, b] = octets;
    if (a === 10 || a === 127) {
      return true;
    }

    if (a === 172 && b >= 16 && b <= 31) {
      return true;
    }

    if (a === 192 && b === 168) {
      return true;
    }

    if (a === 169 && b === 254) {
      return true;
    }

    return false;
  }

  if (ipVersion === 6) {
    return normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe80');
  }

  return false;
}

function isPublicCallbackBaseUrl(baseUrl = '') {
  const normalized = normalizePublicBaseUrl(baseUrl);
  if (!normalized) {
    return false;
  }

  try {
    const parsed = new URL(normalized);
    return !isPrivateOrLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function getRequestDerivedPublicBaseUrls(req) {
  const candidates = [];
  const addCandidate = (value) => {
    const normalized = normalizePublicBaseUrl(value);
    if (!normalized) {
      return;
    }

    if (!candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  addCandidate(getPublicBaseUrl());

  const forwardedProtoRaw = String(req.headers['x-forwarded-proto'] || '').trim();
  const forwardedProto = forwardedProtoRaw ? forwardedProtoRaw.split(',')[0].trim() : '';
  const forwardedHostRaw = String(req.headers['x-forwarded-host'] || '').trim();
  const forwardedHost = forwardedHostRaw ? forwardedHostRaw.split(',')[0].trim() : '';
  const host = forwardedHost || String(req.headers.host || '').trim();
  if (host) {
    const protocol = forwardedProto || req.protocol || 'https';
    addCandidate(`${protocol}://${host}`);
  }

  const origin = String(req.headers.origin || '').trim();
  if (origin) {
    addCandidate(origin);
  }

  return candidates;
}

async function checkPublicBaseUrlHealth(baseUrlOverride = '') {
  const publicBaseUrl = normalizePublicBaseUrl(baseUrlOverride || getPublicBaseUrl());

  if (!publicBaseUrl) {
    return {
      ok: false,
      publicBaseUrl,
      statusCode: 0,
      reason: 'PUBLIC_BASE_URL is not configured.'
    };
  }

  try {
    const response = await axios.get(`${publicBaseUrl}/health`, {
      timeout: 7000,
      validateStatus: () => true,
      headers: {
        'User-Agent': 'marketing-voice-agent/public-url-health-check'
      }
    });

    const ngrokErrorCode = String(response?.headers?.['ngrok-error-code'] || '').trim();
    const bodyText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data || {});
    const isNgrokOffline = ngrokErrorCode === 'ERR_NGROK_3200' || bodyText.includes('ERR_NGROK_3200');
    const isHealthyStatus = response.status >= 200 && response.status < 300;

    if (!isHealthyStatus || isNgrokOffline) {
      return {
        ok: false,
        publicBaseUrl,
        statusCode: Number(response.status || 0),
        reason: isNgrokOffline
          ? 'PUBLIC_BASE_URL ngrok endpoint is offline (ERR_NGROK_3200).'
          : `PUBLIC_BASE_URL health probe returned HTTP ${response.status}.`
      };
    }

    return {
      ok: true,
      publicBaseUrl,
      statusCode: Number(response.status || 200),
      reason: 'ok'
    };
  } catch (error) {
    return {
      ok: false,
      publicBaseUrl,
      statusCode: 0,
      reason: error?.message || 'Could not reach PUBLIC_BASE_URL.'
    };
  }
}

async function resolveWorkingPublicBaseUrl(req, options = {}) {
  const requirePublic = options?.requirePublic !== false;
  const candidates = getRequestDerivedPublicBaseUrls(req);
  let lastHealth = {
    ok: false,
    publicBaseUrl: '',
    statusCode: 0,
    reason: 'No PUBLIC_BASE_URL candidates found.'
  };

  for (const candidate of candidates) {
    if (requirePublic && !isPublicCallbackBaseUrl(candidate)) {
      continue;
    }

    const health = await checkPublicBaseUrlHealth(candidate);
    lastHealth = health;
    if (health.ok) {
      return {
        publicBaseUrl: candidate,
        health
      };
    }
  }

  return {
    publicBaseUrl: '',
    health: lastHealth
  };
}

function getAgentPlaybook() {
  const company = getCompanyName();

  const firstMessage = `Namaste, this is ${company}. We are sharing the mission of Maa Umiya and Umiya Dham.\nWould you like to hear more and support this spiritual initiative?`;

  const systemPrompt = [
    `You are the ${company} voice assistant.`,
    '',
    'Primary goal:',
    'Introduce the foundation mission and respectfully capture if the caller is willing to join/support.',
    '',
    'Conversation flow:',
    `1) Start with a short, respectful introduction about ${company}.`,
    '2) Explain Umiya Dham and the mission: spirituality, education, healthcare, and community upliftment.',
    '3) Ask one clear follow-up at a time and keep replies concise.',
    '4) Before closing, ask: "Would you be open to joining/supporting this mission?"',
    '5) If yes, confirm and offer next-step follow-up.',
    '6) If no, thank the caller and close gracefully.',
    '',
    'Response discipline:',
    '- Keep the conversation human and concise.',
    '- Support natural Gujarati, Hindi, or English replies from callers.',
    '- Never ramble or ask multiple questions in one turn.',
    '- Make the final willingness-to-join answer unmistakable.'
  ].join('\n');

  return {
    firstMessage,
    systemPrompt
  };
}

function ensureCallQualificationWorkbookDirectory() {
  fs.mkdirSync(path.dirname(callQualificationWorkbookFilePath), { recursive: true });
}

function getWorkbookAutosavePath() {
  const dir = path.dirname(callQualificationWorkbookFilePath);
  const ext = path.extname(callQualificationWorkbookFilePath) || '.xlsx';
  const base = path.basename(callQualificationWorkbookFilePath, ext);
  return path.join(dir, `${base}.autosave${ext}`);
}

function getSpeakerRoleGroup(role = '') {
  const normalized = String(role || '').trim().toLowerCase();

  if (['assistant', 'agent', 'ai', 'bot'].includes(normalized)) {
    return 'agent';
  }

  if (['user', 'caller', 'customer', 'human', 'prospect'].includes(normalized)) {
    return 'prospect';
  }

  if (!normalized || normalized === 'participant' || normalized === 'snippet') {
    return 'unknown';
  }

  return normalized;
}

function buildTranscriptSearchText(messages = [], transcriptSnippet = '') {
  const transcriptText = buildHumanReadableTranscript(messages, transcriptSnippet);
  return normalizeFreeText(transcriptText);
}

function extractProspectMessageTexts(messages = []) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  return messages
    .map((item) => {
      const roleGroup = getSpeakerRoleGroup(item?.role || '');
      const text = normalizeTranscriptText(item?.text || '');
      if (!text) {
        return null;
      }

      if (roleGroup !== 'prospect') {
        return null;
      }

      return text;
    })
    .filter(Boolean)
    .slice();
}

function normalizeJoinDispositionLabel(value = '') {
  if (value === true) {
    return 'willing_to_join';
  }

  if (value === false) {
    return 'not_willing_to_join';
  }

  const normalized = normalizeFreeText(value);
  if (!normalized) {
    return '';
  }

  if (['yes', 'willing to join', 'interested', 'join', 'positive'].includes(normalized)) {
    return 'willing_to_join';
  }

  if (['no', 'not willing to join', 'not interested', 'negative'].includes(normalized)) {
    return 'not_willing_to_join';
  }

  if (['follow_up', 'follow up later', 'maybe later'].includes(normalized)) {
    return 'follow_up_later';
  }

  return normalized.replace(/\s+/g, '_');
}

function inferLeadDisposition(record = {}) {
  if (record?.willingToJoin === true || record?.willing_to_join === true) {
    return {
      willingToJoin: true,
      disposition: 'willing_to_join',
      responseLabel: 'Willing to join',
      evidence: String(record?.leadEvidence || record?.responseText || '').trim() || 'Captured from structured call data.'
    };
  }

  if (record?.willingToJoin === false || record?.willing_to_join === false) {
    return {
      willingToJoin: false,
      disposition: 'not_willing_to_join',
      responseLabel: 'Not willing to join',
      evidence: String(record?.leadEvidence || record?.responseText || '').trim() || 'Captured from structured call data.'
    };
  }

  const explicitCandidates = [
    record?.leadDisposition,
    record?.lead_disposition,
    record?.willingToJoin,
    record?.willing_to_join,
    record?.response,
    record?.status
  ];

  for (const candidate of explicitCandidates) {
    const normalized = normalizeJoinDispositionLabel(candidate);
    if (!normalized) {
      continue;
    }

    if (normalized === 'willing_to_join' || normalized === 'not_willing_to_join' || normalized === 'follow_up_later') {
      return {
        willingToJoin: normalized === 'willing_to_join',
        disposition: normalized,
        responseLabel: normalized === 'willing_to_join'
          ? 'Willing to join'
          : normalized === 'not_willing_to_join'
            ? 'Not willing to join'
            : 'Follow-up later',
        evidence: String(record?.leadEvidence || record?.responseText || '').trim() || 'Captured from structured call data.'
      };
    }
  }

  const messages = Array.isArray(record?.messages) ? record.messages : [];
  const prospectTexts = extractProspectMessageTexts(messages);
  const candidateTexts = prospectTexts.length > 0
    ? [...prospectTexts].reverse()
    : [buildHumanReadableTranscript(messages, String(record?.transcriptSnippet || ''))];

  const positivePatterns = [
    /\b(yes|yeah|yep|sure|absolutely|definitely|interested|sounds good|count me in|sign me up|join|willing to join|let'?s do it|okay)\b/i,
    /\b(send details|send more information|book a call|follow up|talk later)\b/i
  ];
  const negativePatterns = [
    /\b(no|nope|not interested|not now|maybe later|busy|call me later|do not call|don't call|not a fit|not looking|pass|no thanks)\b/i
  ];

  for (const text of candidateTexts) {
    const normalizedText = String(text || '').trim();
    if (!normalizedText) {
      continue;
    }

    if (negativePatterns.some((pattern) => pattern.test(normalizedText))) {
      return {
        willingToJoin: false,
        disposition: 'not_willing_to_join',
        responseLabel: 'Not willing to join',
        evidence: normalizedText.slice(0, 240)
      };
    }

    if (positivePatterns.some((pattern) => pattern.test(normalizedText))) {
      return {
        willingToJoin: true,
        disposition: 'willing_to_join',
        responseLabel: 'Willing to join',
        evidence: normalizedText.slice(0, 240)
      };
    }
  }

  const fallbackTranscript = candidateTexts[0] || '';
  return {
    willingToJoin: null,
    disposition: 'unknown',
    responseLabel: 'Unknown',
    evidence: String(fallbackTranscript || '').trim().slice(0, 240)
  };
}

function buildQualificationWorkbookRows(rows = []) {
  const orderedRows = [...rows].sort((a, b) => String(b?.lastAt || '').localeCompare(String(a?.lastAt || '')));

  return orderedRows.map((row, index) => {
    const transcriptText = String(buildHumanReadableTranscript(row?.messages || [], row?.transcriptSnippet || '') || '').trim();
    const disposition = inferLeadDisposition({ ...row, transcriptSnippet: row?.transcriptSnippet || transcriptText });
    const localizedMessages = buildLocalizedTranscriptMessages(Array.isArray(row?.messages) ? row.messages : []);
    const languageCounts = localizedMessages.reduce((acc, item) => {
      const code = String(item?.language || 'unknown').trim().toLowerCase() || 'unknown';
      acc[code] = Number(acc[code] || 0) + 1;
      return acc;
    }, {});
    const languagesPresent = Object.keys(languageCounts);
    const sortedLanguageCounts = Object.entries(languageCounts).sort((a, b) => b[1] - a[1]);
    const topLanguageCode = sortedLanguageCounts.length > 0
      ? sortedLanguageCounts[0][0]
      : String(row?.conversationLanguage || row?.language || 'unknown').trim().toLowerCase();

    return {
      record_no: index + 1,
      logged_at: String(row?.lastAt || row?.startedAt || row?.loggedAt || '').trim(),
      phone_number: String(row?.callerPhone || '').trim(),
      call_status: String(row?.callStatus || '').trim(),
      to_number: String(row?.to || '').trim(),
      from_number: String(row?.from || '').trim(),
      update_count: Number(row?.updateCount || 0),
      message_count: Array.isArray(row?.messages) ? row.messages.length : 0,
      conversation_language: languageLabelFromCode(topLanguageCode),
      conversation_language_code: topLanguageCode,
      languages_present: languagesPresent.map((code) => languageLabelFromCode(code)).join(', '),
      willing_to_join: disposition.willingToJoin === true
        ? 'Yes'
        : disposition.willingToJoin === false
          ? 'No'
          : 'Unknown',
      response: disposition.responseLabel,
      disposition: disposition.disposition,
      evidence: String(disposition.evidence || '').trim().slice(0, 500),
      call_sid: String(row?.callSid || '').trim(),
      conversation_id: String(row?.conversationId || '').trim(),
      transcript: transcriptText.slice(0, 30000)
    };
  });
}

async function syncCallQualificationWorkbook() {
  try {
    ensureCallQualificationWorkbookDirectory();
    const transcriptRows = await readCallTranscriptSnapshots(20000);
    const qualificationRows = buildQualificationWorkbookRows(buildConversationRowsFromSnapshots(transcriptRows, 5000));

    const workbook = xlsx.utils.book_new();
    const worksheet = xlsx.utils.json_to_sheet(qualificationRows);
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Leads');

    try {
      xlsx.writeFile(workbook, callQualificationWorkbookFilePath);
    } catch (writeError) {
      const code = String(writeError?.code || '').trim().toUpperCase();
      if (code !== 'EBUSY' && code !== 'EPERM') {
        throw writeError;
      }

      // When the primary workbook is open in Excel, write to autosave instead of dropping data.
      const autosavePath = getWorkbookAutosavePath();
      xlsx.writeFile(workbook, autosavePath);

      return {
        ok: true,
        file: callQualificationWorkbookFilePath,
        autosaveFile: autosavePath,
        count: qualificationRows.length,
        warning: `Primary workbook is locked (${code}). Wrote autosave workbook instead.`
      };
    }

    return {
      ok: true,
      file: callQualificationWorkbookFilePath,
      count: qualificationRows.length
    };
  } catch (error) {
    console.error('[call-qualification-export] Failed to write workbook:', error?.message || error);
    return {
      ok: false,
      file: callQualificationWorkbookFilePath,
      count: 0,
      error: error?.message || 'Unknown workbook export error'
    };
  }
}

async function checkConfig() {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.warn('[config] Missing environment variables:', missing.join(', '));
  }

  if (!supabaseUrl || !supabaseServiceKey) {
    console.warn('[config] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.');
  }

  try {
    await enforceConversationLogRetention(CONVERSATION_LOG_RETENTION_LIMIT);
  } catch (error) {
    console.warn('[config] Could not enforce conversation log retention:', error?.message || error);
  }

  console.log(`[config] Supabase URL: ${supabaseUrl || 'missing'}`);
  console.log(`[config] Conversation log table: ${supabaseConversationLogTable}`);
  console.log(`[config] Call transcript table: ${supabaseCallTranscriptTable}`);
  console.log(`[config] Conversation log retention limit: ${CONVERSATION_LOG_RETENTION_LIMIT}`);
}

function nowUkString() {
  return new Date().toLocaleString('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short'
  });
}

function pushLimited(list, item, maxItems = 30) {
  list.unshift(item);
  if (list.length > maxItems) {
    list.length = maxItems;
  }
}

function normalizePhone(raw = '') {
  const input = String(raw).replace(/^whatsapp:/i, '').trim();
  if (!input) {
    return '';
  }

  const digits = input.replace(/\D/g, '');
  if (!digits) {
    return '';
  }

  if (input.startsWith('+')) {
    return `+${digits}`;
  }

  if (input.startsWith('00')) {
    return `+${digits.slice(2)}`;
  }

  return digits;
}

function getPhoneLookupCandidates(raw = '') {
  const normalized = normalizePhone(raw);
  if (!normalized) {
    return [];
  }

  const candidates = new Set([normalized]);
  const digits = normalized.replace(/\D/g, '');

  if (digits) {
    candidates.add(digits);
    candidates.add(`+${digits}`);
  }

  if (normalized.startsWith('+') && normalized.length > 1) {
    candidates.add(normalized.slice(1));
  }

  return Array.from(candidates);
}

function rememberActiveCall(phone, callSid) {
  if (!callSid) {
    return;
  }

  for (const candidate of getPhoneLookupCandidates(phone)) {
    activeCallsByPhone.set(candidate, callSid);
  }
}

function clearActiveCall(phone) {
  for (const candidate of getPhoneLookupCandidates(phone)) {
    activeCallsByPhone.delete(candidate);
  }
}

function findActiveCallSidByPhone(phone) {
  for (const candidate of getPhoneLookupCandidates(phone)) {
    const sid = activeCallsByPhone.get(candidate);
    if (sid) {
      return sid;
    }
  }

  return '';
}

function rememberActiveCallByConversationId(conversationId, callSid) {
  const normalizedConversationId = String(conversationId || '').trim();
  const normalizedCallSid = String(callSid || '').trim();

  if (!normalizedConversationId || !normalizedCallSid) {
    return;
  }

  activeCallsByConversationId.set(normalizedConversationId, normalizedCallSid);
}

function findActiveCallSidByConversationId(conversationId) {
  const normalizedConversationId = String(conversationId || '').trim();
  if (!normalizedConversationId) {
    return '';
  }

  return String(activeCallsByConversationId.get(normalizedConversationId) || '');
}

function clearCallSidFromConversationMap(callSid) {
  if (!callSid) {
    return;
  }

  for (const [conversationId, mappedCallSid] of activeCallsByConversationId.entries()) {
    if (mappedCallSid === callSid) {
      activeCallsByConversationId.delete(conversationId);
    }
  }
}

function upsertActiveCallMeta({ callSid, to = '', from = '', status = 'unknown' }) {
  const normalizedCallSid = String(callSid || '').trim();
  if (!normalizedCallSid) {
    return;
  }

  const now = Date.now();
  const existing = activeCallMetaBySid.get(normalizedCallSid) || {};
  const normalizedStatus = String(status || 'unknown').toLowerCase();
  const startedAt = Number(existing.startedAt || now);
  const connectedAt = Number(
    existing.connectedAt
      || ((normalizedStatus === 'in-progress' || normalizedStatus === 'answered') ? now : 0)
  );

  activeCallMetaBySid.set(normalizedCallSid, {
    callSid: normalizedCallSid,
    to: normalizePhone(to || existing.to || ''),
    from: normalizePhone(from || existing.from || ''),
    status: normalizedStatus,
    startedAt,
    connectedAt,
    updatedAt: now
  });

  // Keep in-memory tracking bounded.
  if (activeCallMetaBySid.size > 300) {
    const oldest = Array.from(activeCallMetaBySid.values())
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, activeCallMetaBySid.size - 300);

    for (const item of oldest) {
      activeCallMetaBySid.delete(item.callSid);
    }
  }
}

function removeActiveCallMeta(callSid) {
  const normalizedCallSid = String(callSid || '').trim();
  if (!normalizedCallSid) {
    return;
  }

  activeCallMetaBySid.delete(normalizedCallSid);
  clearCallSidFromConversationMap(normalizedCallSid);
}

function findSingleActiveTransferCandidateCallSid() {
  const active = Array.from(activeCallMetaBySid.values())
    .filter((item) => TRANSFER_ELIGIBLE_STATUSES.includes(String(item?.status || '').toLowerCase()));

  if (active.length !== 1) {
    return '';
  }

  return String(active[0].callSid || '');
}

function ensureConversationAggregate({ callSid = '', conversationId = '', callerPhone = '' }) {
  const normalizedCallSid = String(callSid || '').trim();
  const normalizedConversationId = String(conversationId || '').trim();

  let aggregate = null;

  if (normalizedCallSid) {
    aggregate = conversationAggregateByCallSid.get(normalizedCallSid) || null;
  }

  if (!aggregate && normalizedConversationId) {
    aggregate = conversationAggregateByConversationId.get(normalizedConversationId) || null;
  }

  if (!aggregate) {
    aggregate = {
      startedAt: new Date().toISOString(),
      lastAt: new Date().toISOString(),
      callSid: normalizedCallSid,
      conversationId: normalizedConversationId,
      callerPhone: normalizePhone(callerPhone || ''),
      updateCount: 0,
      messages: [],
      transcriptSnippet: ''
    };
  }

  if (normalizedCallSid) {
    aggregate.callSid = normalizedCallSid;
    conversationAggregateByCallSid.set(normalizedCallSid, aggregate);
  }

  if (normalizedConversationId) {
    aggregate.conversationId = normalizedConversationId;
    conversationAggregateByConversationId.set(normalizedConversationId, aggregate);
  }

  const normalizedCallerPhone = normalizePhone(callerPhone || '');
  if (normalizedCallerPhone) {
    aggregate.callerPhone = normalizedCallerPhone;
  }

  return aggregate;
}

function mergeConversationMessages(existingMessages = [], incomingMessages = []) {
  const existing = Array.isArray(existingMessages) ? existingMessages : [];
  const incoming = Array.isArray(incomingMessages) ? incomingMessages : [];

  if (incoming.length === 0) {
    return existing;
  }

  if (incoming.length >= existing.length) {
    return incoming;
  }

  const merged = [...existing];
  const seen = new Set(existing.map((item) => `${item.role || 'participant'}|${item.text || ''}`));

  for (const item of incoming) {
    const key = `${item.role || 'participant'}|${item.text || ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(item);
    }
  }

  return merged;
}

function upsertConversationAggregateFromWebhook({
  callSid = '',
  conversationId = '',
  callerPhone = '',
  transcriptMessages = [],
  transcriptSnippet = ''
}) {
  if (!callSid && !conversationId) {
    return null;
  }

  const aggregate = ensureConversationAggregate({ callSid, conversationId, callerPhone });
  aggregate.lastAt = new Date().toISOString();
  aggregate.updateCount += 1;

  if (Array.isArray(transcriptMessages) && transcriptMessages.length > 0) {
    aggregate.messages = mergeConversationMessages(aggregate.messages, transcriptMessages);
  }

  const snippet = String(transcriptSnippet || '').trim();
  if (snippet && snippet.length >= String(aggregate.transcriptSnippet || '').length) {
    aggregate.transcriptSnippet = snippet;
  }

  return aggregate;
}

function deleteConversationAggregate(aggregate) {
  if (!aggregate || typeof aggregate !== 'object') {
    return;
  }

  const normalizedCallSid = String(aggregate.callSid || '').trim();
  const normalizedConversationId = String(aggregate.conversationId || '').trim();

  if (normalizedCallSid) {
    const byCallSid = conversationAggregateByCallSid.get(normalizedCallSid);
    if (byCallSid === aggregate) {
      conversationAggregateByCallSid.delete(normalizedCallSid);
    }
  }

  if (normalizedConversationId) {
    const byConversationId = conversationAggregateByConversationId.get(normalizedConversationId);
    if (byConversationId === aggregate) {
      conversationAggregateByConversationId.delete(normalizedConversationId);
    }
  }
}

function finalizeConversationAggregateForCall({ callSid = '', callStatus = '', to = '', from = '' }) {
  const normalizedCallSid = String(callSid || '').trim();
  if (!normalizedCallSid) {
    return;
  }

  const aggregate = conversationAggregateByCallSid.get(normalizedCallSid);
  if (!aggregate) {
    return;
  }

  const finalizedAt = new Date().toISOString();
  const messages = Array.isArray(aggregate.messages) ? aggregate.messages : [];
  const transcriptSnippet = String(aggregate.transcriptSnippet || '').trim();

  const leadDisposition = inferLeadDisposition({ messages, transcriptSnippet, callSid, conversationId: aggregate.conversationId, callerPhone: aggregate.callerPhone });

  appendCallTranscriptSnapshot({
    source: 'elevenlabs',
    event: 'post_call_transcription',
    loggedAt: finalizedAt,
    callSid: normalizedCallSid,
    conversationId: String(aggregate.conversationId || '').trim(),
    callerPhone: String(aggregate.callerPhone || '').trim(),
    callStatus,
    to,
    from,
    startedAt: aggregate.startedAt,
    lastAt: aggregate.lastAt,
    updateCount: aggregate.updateCount,
    messages,
    transcriptSnippet,
    leadDisposition: leadDisposition.disposition,
    willingToJoin: leadDisposition.willingToJoin,
    response: leadDisposition.responseLabel,
    leadEvidence: leadDisposition.evidence
  });

  appendConversationLog({
    source: 'conversation-store',
    event: 'full-conversation-finalized',
    callSid: normalizedCallSid,
    conversationId: String(aggregate.conversationId || '').trim(),
    callerPhone: String(aggregate.callerPhone || '').trim(),
    callStatus,
    to,
    from,
    messageCount: messages.length,
    transcriptSnippet: transcriptSnippet.slice(0, 1000),
    updateCount: aggregate.updateCount,
    leadDisposition: leadDisposition.disposition,
    willingToJoin: leadDisposition.willingToJoin,
    response: leadDisposition.responseLabel
  });

  deleteConversationAggregate(aggregate);
}

function isUnavailableTranscriptText(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized.startsWith('transcript not available:');
}

function hasRealTranscriptContent(record = {}) {
  const messages = Array.isArray(record?.messages) ? record.messages : [];
  const hasRealMessages = messages.some((item) => {
    const role = String(item?.role || '').trim().toLowerCase();
    const text = String(item?.text || '').trim();
    return Boolean(text) && role !== 'system';
  });

  const transcriptSnippet = String(record?.transcriptSnippet || '').trim();
  const hasSnippet = Boolean(transcriptSnippet) && !isUnavailableTranscriptText(transcriptSnippet);

  return hasRealMessages || hasSnippet;
}

function getTranscriptQualityScore(record = {}) {
  const messages = Array.isArray(record?.messages) ? record.messages : [];
  const transcriptSnippet = String(record?.transcriptSnippet || '').trim();
  const hasRealMessages = messages.some((item) => {
    const role = String(item?.role || '').trim().toLowerCase();
    const text = String(item?.text || '').trim();
    return Boolean(text) && role !== 'system';
  });

  const hasRealSnippet = Boolean(transcriptSnippet) && !isUnavailableTranscriptText(transcriptSnippet);

  if (!hasRealMessages && !hasRealSnippet) {
    return 0;
  }

  return (
    (hasRealMessages ? 1000 : 0)
    + (messages.filter((item) => String(item?.role || '').trim().toLowerCase() !== 'system').length * 10)
    + (hasRealSnippet ? 100 : 0)
    + transcriptSnippet.length
  );
}

function mergeCallTranscriptRecord(existing = {}, incoming = {}) {
  const existingMessages = Array.isArray(existing?.messages) ? existing.messages : [];
  const incomingMessages = Array.isArray(incoming?.messages) ? incoming.messages : [];
  const mergedMessages = incomingMessages.length > 0
    ? mergeConversationMessages(existingMessages, incomingMessages)
    : existingMessages;

  const existingSnippet = String(existing?.transcriptSnippet || '').trim();
  const incomingSnippet = String(incoming?.transcriptSnippet || '').trim();
  let mergedSnippet = existingSnippet;

  if (incomingSnippet) {
    if (
      !mergedSnippet
      || incomingSnippet.length >= mergedSnippet.length
    ) {
      mergedSnippet = incomingSnippet;
    }
  }

  const merged = {
    ...existing,
    ...incoming,
    callSid: String(incoming?.callSid || existing?.callSid || '').trim(),
    conversationId: String(incoming?.conversationId || existing?.conversationId || '').trim(),
    callerPhone: String(incoming?.callerPhone || existing?.callerPhone || '').trim(),
    messages: mergedMessages,
    transcriptSnippet: mergedSnippet,
    updateCount: Number(incoming?.updateCount || existing?.updateCount || 0)
  };

  return merged;
}

function readJsonArrayFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw.trim()) {
    return [];
  }

  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.error('[json-array] Failed to parse JSON:', error?.message || error);
      return [];
    }
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const parsed = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch (_err) {
      // Ignore malformed JSONL fallback lines.
    }
  }

  return parsed;
}

function writeJsonArrayFile(filePath, rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  fs.writeFileSync(filePath, `${JSON.stringify(safeRows, null, 2)}\n`, 'utf8');
}

function appendConversationLog(record = {}) {
  void appendConversationLogAsync(record);
}

async function appendConversationLogAsync(record = {}) {
  const client = getSupabaseClient();
  if (!client) {
    logSupabaseNotConfigured('conversation-log');
    return;
  }

  try {
    const safeRecord = {
      loggedAt: new Date().toISOString(),
      ...record
    };

    const row = buildSupabaseConversationRow(safeRecord);
    const { error } = await client
      .from(supabaseConversationLogTable)
      .insert(row);

    if (error) {
      throw error;
    }

    await enforceConversationLogRetention(CONVERSATION_LOG_RETENTION_LIMIT);
  } catch (error) {
    console.error('[conversation-log] Failed to append log:', error?.message || error);
  }
}

async function enforceConversationLogRetention(limit = CONVERSATION_LOG_RETENTION_LIMIT) {
  const client = getSupabaseClient();
  if (!client) {
    return;
  }

  if (!Number.isFinite(limit) || limit <= 0) {
    return;
  }

  const { data, error } = await client
    .from(supabaseConversationLogTable)
    .select('logged_at')
    .order('logged_at', { ascending: false })
    .range(Math.max(0, limit - 1), Math.max(0, limit - 1));

  if (error) {
    console.warn('[conversation-log] Retention lookup failed:', error?.message || error);
    return;
  }

  const cutoff = data?.[0]?.logged_at;
  if (!cutoff) {
    return;
  }

  const { error: deleteError } = await client
    .from(supabaseConversationLogTable)
    .delete()
    .lt('logged_at', cutoff);

  if (deleteError) {
    console.warn('[conversation-log] Retention cleanup failed:', deleteError?.message || deleteError);
  }
}

function appendCallTranscriptSnapshot(record = {}) {
  void appendCallTranscriptSnapshotAsync(record);
}

async function appendCallTranscriptSnapshotAsync(record = {}) {
  const client = getSupabaseClient();
  if (!client) {
    logSupabaseNotConfigured('call-transcript-log');
    return;
  }

  try {
    const safeRecord = {
      loggedAt: new Date().toISOString(),
      ...record
    };

    if (!hasRealTranscriptContent(safeRecord)) {
      return;
    }

    const incomingCallSid = String(safeRecord?.callSid || '').trim();
    const incomingConversationId = String(safeRecord?.conversationId || '').trim();
    const conflictColumn = incomingCallSid ? 'call_sid' : (incomingConversationId ? 'conversation_id' : '');
    const conflictValue = incomingCallSid || incomingConversationId;

    if (!conflictColumn || !conflictValue) {
      return;
    }

    const { data: existingRows, error: existingError } = await client
      .from(supabaseCallTranscriptTable)
      .select('id, record, logged_at')
      .eq(conflictColumn, conflictValue)
      .order('logged_at', { ascending: false })
      .limit(1);

    if (existingError) {
      throw existingError;
    }

    if (!existingRows || existingRows.length === 0) {
      const row = buildSupabaseTranscriptRow(safeRecord);
      const { error: insertError } = await client
        .from(supabaseCallTranscriptTable)
        .insert(row);

      if (insertError) {
        throw insertError;
      }

      await syncCallQualificationWorkbook();
      return;
    }

    const existing = existingRows[0] || {};
    const current = (existing?.record && typeof existing.record === 'object') ? existing.record : {};
    const keepIncoming = getTranscriptQualityScore(safeRecord) >= getTranscriptQualityScore(current);
    const merged = mergeCallTranscriptRecord(current, safeRecord);
    const nextRecord = keepIncoming
      ? { ...merged, loggedAt: safeRecord.loggedAt || merged.loggedAt }
      : { ...merged, loggedAt: current.loggedAt || merged.loggedAt };

    const updateRow = buildSupabaseTranscriptRow(nextRecord);
    const { error: updateError } = await client
      .from(supabaseCallTranscriptTable)
      .update(updateRow)
      .eq('id', existing.id);

    if (updateError) {
      throw updateError;
    }

    await syncCallQualificationWorkbook();
  } catch (error) {
    console.error('[call-transcript-log] Failed to append log:', error?.message || error);
  }
}

function logSupabaseNotConfigured(context = 'supabase') {
  if (!supabaseUrl || !supabaseServiceKey) {
    console.warn(`[${context}] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.`);
  }
}

function buildSupabaseConversationRow(record = {}) {
  return {
    logged_at: record.loggedAt || new Date().toISOString(),
    call_sid: String(record?.callSid || '').trim() || null,
    conversation_id: String(record?.conversationId || '').trim() || null,
    caller_phone: String(record?.callerPhone || '').trim() || null,
    source: String(record?.source || '').trim() || null,
    event: String(record?.event || '').trim() || null,
    webhook_type: String(record?.webhookType || '').trim() || null,
    record
  };
}

function buildSupabaseTranscriptRow(record = {}) {
  return {
    logged_at: record.loggedAt || new Date().toISOString(),
    call_sid: String(record?.callSid || '').trim() || null,
    conversation_id: String(record?.conversationId || '').trim() || null,
    caller_phone: String(record?.callerPhone || '').trim() || null,
    source: String(record?.source || '').trim() || null,
    event: String(record?.event || '').trim() || null,
    transcript_snippet: String(record?.transcriptSnippet || '').trim() || null,
    messages: Array.isArray(record?.messages) ? record.messages : null,
    update_count: Number(record?.updateCount || 0) || 0,
    record
  };
}

async function readConversationLog(limit = 100) {
  const client = getSupabaseClient();
  if (!client) {
    logSupabaseNotConfigured('conversation-log');
    return [];
  }

  const { data, error } = await client
    .from(supabaseConversationLogTable)
    .select('record, logged_at')
    .order('logged_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[conversation-log] Failed to read logs:', error?.message || error);
    return [];
  }

  return (data || []).map((row) => {
    const record = (row?.record && typeof row.record === 'object') ? row.record : {};
    if (!record.loggedAt) {
      record.loggedAt = row?.logged_at || new Date().toISOString();
    }
    return record;
  });
}

async function readCallTranscriptSnapshots(limit = 1500) {
  const client = getSupabaseClient();
  if (!client) {
    logSupabaseNotConfigured('call-transcript-log');
    return [];
  }

  const { data, error } = await client
    .from(supabaseCallTranscriptTable)
    .select('record, logged_at')
    .order('logged_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[call-transcript-log] Failed to read transcripts:', error?.message || error);
    return [];
  }

  const rows = (data || []).map((row) => {
    const record = (row?.record && typeof row.record === 'object') ? row.record : {};
    if (!record.loggedAt) {
      record.loggedAt = row?.logged_at || new Date().toISOString();
    }
    return record;
  });

  return rows.reverse();
}
async function backfillTranscriptSnapshotsFromConversationLog(limit = 6000) {
  try {
    const entries = await readConversationLog(limit);
    if (!Array.isArray(entries) || entries.length === 0) {
      return 0;
    }

    const existingRows = await readCallTranscriptSnapshots(12000);
    const existingKeys = new Set(existingRows.map((row) => buildTranscriptSnapshotDedupeKey(row)));
    const toAppend = [];

    for (const entry of entries) {
      const source = String(entry?.source || '').trim();
      const event = String(entry?.event || '').trim();
      const webhookType = String(entry?.webhookType || '').trim();
      if (!(source === 'elevenlabs' && event === 'webhook' && webhookType === 'post_call_transcription')) {
        continue;
      }

      const payload = entry?.payload || {};
      let callSid = String(entry?.callSid || extractCallSid(payload) || '').trim();
      const conversationId = String(entry?.conversationId || extractConversationId(payload, {}) || '').trim();
      const callerPhone = normalizePhone(String(entry?.callerPhone || extractCallerPhone(payload, {}) || '').trim());
      const messages = extractTranscriptMessages(payload);
      const transcriptSnippet = String(extractTranscriptSnippet(payload) || '').trim();

      if (!callSid && callerPhone) {
        callSid = await findRecentCallSidByPhoneFromLog(callerPhone);
      }

      if (!callSid && !conversationId) {
        continue;
      }

      if (messages.length === 0 && !transcriptSnippet) {
        continue;
      }

      const record = {
        loggedAt: String(entry?.loggedAt || new Date().toISOString()).trim(),
        source: 'elevenlabs',
        event: 'post_call_transcription',
        callSid,
        callerPhone,
        conversationId,
        messages,
        transcriptSnippet,
        updateCount: Number(entry?.updateCount || 1)
      };

      const dedupeKey = buildTranscriptSnapshotDedupeKey(record);
      if (existingKeys.has(dedupeKey)) {
        continue;
      }

      existingKeys.add(dedupeKey);
      toAppend.push(record);
    }

    for (const row of toAppend) {
      await appendCallTranscriptSnapshotAsync(row);
    }

    return toAppend.length;
  } catch (error) {
    console.error('[call-transcript-log] Backfill failed:', error?.message || error);
    return 0;
  }
}

function isLikelyElevenLabsWebhookRequest(req, payload = {}) {
  const signatureHeaders = [
    req.headers['x-elevenlabs-signature'],
    req.headers['x-elevenlabs-signature-v1'],
    req.headers['x-elevenlabs-request-signature']
  ];

  if (signatureHeaders.some((value) => String(value || '').trim())) {
    return true;
  }

  const eventCandidates = [
    payload?.type,
    payload?.event,
    payload?.event_type,
    payload?.webhook_event
  ];

  if (eventCandidates.some((value) => String(value || '').trim())) {
    return true;
  }

  return Boolean(
    payload?.conversation
    || payload?.messages
    || payload?.turns
    || payload?.transcript
    || payload?.agentMessage
    || payload?.assistantMessage
  );
}

function collectObjectValuesByKeys(source, keysToFind, sink) {
  if (!source || typeof source !== 'object') {
    return;
  }

  if (Array.isArray(source)) {
    for (const item of source) {
      collectObjectValuesByKeys(item, keysToFind, sink);
    }
    return;
  }

  for (const [key, value] of Object.entries(source)) {
    if (keysToFind.has(key)) {
      sink.push(value);
    }

    if (value && typeof value === 'object') {
      collectObjectValuesByKeys(value, keysToFind, sink);
    }
  }
}

function extractCallSid(payload = {}) {
  const nestedMatches = [];
  collectObjectValuesByKeys(payload, new Set([
    'callSid',
    'CallSid',
    'call_sid',
    'twilioCallSid',
    'twilio_call_sid',
    'sid'
  ]), nestedMatches);

  const candidates = [
    payload.callSid,
    payload.CallSid,
    payload.call_sid,
    payload.twilioCallSid,
    payload.twilio_call_sid,
    payload?.call?.sid,
    payload?.conversation?.call_sid,
    payload?.data?.phone_call?.call_sid,
    payload?.data?.metadata?.phone_call?.call_sid,
    payload?.data?.conversation_initiation_client_data?.dynamic_variables?.system__call_sid,
    ...nestedMatches
  ];

  for (const candidate of candidates) {
    const sid = String(candidate || '').trim();
    if (/^CA[0-9a-f]{32}$/i.test(sid)) {
      return sid;
    }
  }

  return '';
}

function extractConversationId(payload = {}, query = {}) {
  const nestedMatches = [];
  collectObjectValuesByKeys(payload, new Set([
    'conversationId',
    'conversation_id',
    'conversationid',
    'sessionId',
    'session_id',
    'sessionid',
    'chatId',
    'chat_id',
    'chatid'
  ]), nestedMatches);

  const candidates = [
    payload?.conversationId,
    payload?.conversation_id,
    payload?.conversationid,
    payload?.sessionId,
    payload?.session_id,
    payload?.chatId,
    payload?.chat_id,
    payload?.conversation?.id,
    payload?.conversation?.conversation_id,
    payload?.data?.conversation_id,
    payload?.data?.id,
    payload?.meta?.conversationId,
    payload?.metadata?.conversationId,
    query?.conversationId,
    query?.conversation_id,
    query?.sessionId,
    query?.session_id,
    ...nestedMatches
  ];

  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (value) {
      return value.slice(0, 200);
    }
  }

  return '';
}

function extractCallerPhone(payload = {}, query = {}) {
  const nestedMatches = [];
  collectObjectValuesByKeys(payload, new Set([
    'callerPhone',
    'caller_phone',
    'phone',
    'to',
    'customerPhone',
    'customer_phone',
    'from'
  ]), nestedMatches);

  const candidates = [
    payload?.callerPhone,
    payload?.caller_phone,
    payload?.phone,
    payload?.to,
    payload?.customerPhone,
    payload?.customer_phone,
    payload?.from,
    payload?.conversation?.from_number,
    payload?.data?.metadata?.phone_call?.external_number,
    payload?.data?.metadata?.phone_call?.agent_number,
    payload?.data?.conversation_initiation_client_data?.dynamic_variables?.system__called_number,
    payload?.data?.conversation_initiation_client_data?.dynamic_variables?.system__caller_id,
    payload?.data?.user_id,
    payload?.data?.phone_call?.external_number,
    payload?.data?.metadata?.phone_call?.external_number,
    query?.callerPhone,
    query?.caller_phone,
    query?.phone,
    query?.to,
    ...nestedMatches
  ];

  for (const candidate of candidates) {
    const normalized = normalizePhone(candidate || '');
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

async function findRecentCallSidByPhoneFromLog(callerPhone = '') {
  const normalizedCallerPhone = normalizePhone(callerPhone);
  if (!normalizedCallerPhone) {
    return '';
  }

  const targetCandidates = new Set(getPhoneLookupCandidates(normalizedCallerPhone));
  const entries = await readConversationLog(Math.max(500, Math.min(CONVERSATION_LOG_RETENTION_LIMIT, 3000)));

  for (const entry of entries) {
    if (String(entry?.source || '').trim() !== 'twilio' || String(entry?.event || '').trim() !== 'call-status') {
      continue;
    }

    const callSid = String(entry?.callSid || '').trim();
    if (!callSid) {
      continue;
    }

    const to = normalizePhone(String(entry?.to || entry?.payload?.To || '').trim());
    const from = normalizePhone(String(entry?.from || entry?.payload?.From || '').trim());
    const matchesTarget = [to, from]
      .flatMap((value) => getPhoneLookupCandidates(value))
      .some((candidate) => targetCandidates.has(candidate));

    if (matchesTarget) {
      return callSid;
    }
  }

  return '';
}

function extractTranscriptSnippet(payload = {}) {
  const directCandidates = [
    payload?.transcript,
    payload?.conversation?.transcript,
    payload?.data?.transcript,
    payload?.data?.analysis?.transcript_summary,
    payload?.analysis?.transcript_summary,
    payload?.message,
    payload?.text,
    payload?.data?.text
  ];

  for (const candidate of directCandidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim().slice(0, 4000);
    }
  }

  const normalizedMessages = extractTranscriptMessages(payload);
  if (normalizedMessages.length > 0) {
    const lines = normalizedMessages.map((item) => {
      const role = String(item?.role || 'participant').trim();
      const text = normalizeTranscriptText(item?.text || '');
      return text ? `${role}: ${text}` : '';
    }).filter(Boolean);

    if (lines.length > 0) {
      return lines.join('\n').slice(0, 4000);
    }
  }

  const messageCandidates = [
    payload?.messages,
    payload?.conversation?.messages,
    payload?.data?.messages,
    payload?.data?.transcript,
    payload?.transcript,
    payload?.transcript?.messages,
    payload?.turns,
    payload?.conversation?.turns
  ];

  for (const list of messageCandidates) {
    if (!Array.isArray(list) || list.length === 0) {
      continue;
    }

    const lines = list.map((item) => {
      const role = String(item?.role || item?.speaker || item?.source || 'participant').trim();
      const text = normalizeTranscriptText(item?.text || item?.content || item?.message || '');
      return text ? `${role}: ${text}` : '';
    }).filter(Boolean);

    if (lines.length > 0) {
      return lines.join('\n').slice(0, 4000);
    }
  }

  return '';
}

function normalizeTranscriptRole(rawRole = '') {
  const normalized = String(rawRole || '').trim().toLowerCase();
  if (!normalized) {
    return 'participant';
  }

  if (['assistant', 'agent', 'ai', 'bot'].includes(normalized)) {
    return 'assistant';
  }

  if (['user', 'caller', 'customer', 'human'].includes(normalized)) {
    return 'user';
  }

  return normalized;
}

function normalizeTranscriptMessageList(list = []) {
  if (!Array.isArray(list) || list.length === 0) {
    return [];
  }

  return list
    .map((item) => {
      if (typeof item === 'string') {
        const text = normalizeTranscriptText(item);
        return text
          ? {
            role: 'participant',
            text
          }
          : null;
      }

      if (!item || typeof item !== 'object') {
        return null;
      }

      const role = normalizeTranscriptRole(item?.role || item?.speaker || item?.source || '');
      const text = normalizeTranscriptText(
        item?.text
        || item?.content
        || item?.message
        || item?.original_message
        || item?.transcript
        || ''
      );

      return text
        ? {
          role,
          text
        }
        : null;
    })
    .filter(Boolean);
}

function extractConversationHistoryMessages(payload = {}) {
  const rawCandidates = [
    payload?.data?.conversation_initiation_client_data?.dynamic_variables?.system__conversation_history,
    payload?.data?.metadata?.system__conversation_history,
    payload?.data?.metadata?.conversation_history
  ];

  for (const rawCandidate of rawCandidates) {
    const raw = String(rawCandidate || '').trim();
    if (!raw) {
      continue;
    }

    try {
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
      const normalized = normalizeTranscriptMessageList(entries);
      if (normalized.length > 0) {
        return normalized;
      }
    } catch (_err) {
      // Ignore malformed dynamic conversation history payload.
    }
  }

  return [];
}

function extractTranscriptMessages(payload = {}) {
  const messageCandidates = [
    payload?.messages,
    payload?.conversation?.messages,
    payload?.data?.messages,
    payload?.data?.transcript,
    payload?.data?.analysis?.transcript,
    payload?.data?.analysis?.transcript?.messages,
    payload?.data?.analysis?.conversation?.messages,
    payload?.transcript,
    payload?.transcript?.messages,
    payload?.turns,
    payload?.conversation?.turns
  ];

  for (const list of messageCandidates) {
    if (!Array.isArray(list) || list.length === 0) {
      continue;
    }

    const normalized = normalizeTranscriptMessageList(list);

    if (normalized.length > 0) {
      return normalized;
    }
  }

  const historyMessages = extractConversationHistoryMessages(payload);
  if (historyMessages.length > 0) {
    return historyMessages;
  }

  return [];
}

function buildConversationRowsFromSnapshots(rows = [], limit = 25) {
  const grouped = new Map();
  const ordered = [...rows].sort((a, b) => String(a?.loggedAt || '').localeCompare(String(b?.loggedAt || '')));

  for (const row of ordered) {
    const callSid = String(row?.callSid || '').trim();
    const conversationId = String(row?.conversationId || '').trim();
    const callerPhone = normalizePhone(String(row?.callerPhone || '').trim());
    const transcriptSnippet = String(row?.transcriptSnippet || '').trim();
    const messages = Array.isArray(row?.messages)
      ? row.messages
        .map((item) => {
          const role = String(item?.role || 'participant').trim();
          const text = String(item?.text || '').trim();
          return text ? { role, text } : null;
        })
        .filter(Boolean)
      : [];

    const key = callSid || conversationId;
    if (!key) {
      continue;
    }

    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        callSid,
        conversationId,
        callerPhone,
        callStatus: String(row?.callStatus || '').trim(),
        to: normalizePhone(String(row?.to || '').trim()),
        from: normalizePhone(String(row?.from || '').trim()),
        conversationLanguage: String(row?.conversationLanguage || row?.language || '').trim().toLowerCase(),
        startedAt: String(row?.startedAt || row?.loggedAt || '').trim(),
        lastAt: String(row?.loggedAt || '').trim(),
        updateCount: 0,
        messages: []
      });
    }

    const target = grouped.get(key);
    if (!target.callSid && callSid) {
      target.callSid = callSid;
    }

    if (!target.conversationId && conversationId) {
      target.conversationId = conversationId;
    }

    if (!target.callerPhone && callerPhone) {
      target.callerPhone = callerPhone;
    }

    if (!target.callStatus && row?.callStatus) {
      target.callStatus = String(row.callStatus || '').trim();
    }

    if (!target.to && row?.to) {
      target.to = normalizePhone(String(row.to || '').trim());
    }

    if (!target.from && row?.from) {
      target.from = normalizePhone(String(row.from || '').trim());
    }

    if (!target.conversationLanguage && (row?.conversationLanguage || row?.language)) {
      target.conversationLanguage = String(row?.conversationLanguage || row?.language || '').trim().toLowerCase();
    }

    if (!target.startedAt && row?.startedAt) {
      target.startedAt = String(row.startedAt).trim();
    }

    if (row?.loggedAt) {
      target.lastAt = String(row.loggedAt).trim();
    }

    if (row?.lastAt) {
      const rowLastAt = String(row.lastAt).trim();
      if (rowLastAt && rowLastAt > String(target.lastAt || '')) {
        target.lastAt = rowLastAt;
      }
    }

    target.updateCount += 1;

    // ElevenLabs conversation.updated commonly sends the full conversation each time,
    // so keep the longest message list as the canonical transcript.
    if (messages.length >= target.messages.length) {
      target.messages = messages;
    }

    if (transcriptSnippet && target.messages.length === 0) {
      target.messages = [{ role: 'snippet', text: transcriptSnippet }];
    }
  }

  return Array.from(grouped.values())
    .sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')))
    .slice(0, limit);
}

function buildConversationSnapshotsFromLogEntries(entries = []) {
  const snapshots = [];

  for (const entry of entries) {
    const payload = entry?.payload || {};
    const callSid = String(entry?.callSid || extractCallSid(payload)).trim();
    const conversationId = String(entry?.conversationId || extractConversationId(payload, {})).trim();
    const callerPhone = normalizePhone(String(entry?.callerPhone || extractCallerPhone(payload, {})).trim());
    const messages = extractTranscriptMessages(payload);
    const transcriptSnippet = String(entry?.transcriptSnippet || extractTranscriptSnippet(payload) || '').trim();
    const conversationLanguage = String(
      entry?.conversationLanguage
      || entry?.language
      || payload?.data?.metadata?.main_language
      || payload?.data?.main_language
      || ''
    ).trim().toLowerCase();

    if (!callSid && !conversationId) {
      continue;
    }

    if (messages.length === 0 && !transcriptSnippet) {
      continue;
    }

    snapshots.push({
      loggedAt: entry?.loggedAt,
      callSid,
      conversationId,
      callerPhone,
      callStatus: String(entry?.callStatus || '').trim(),
      to: normalizePhone(String(entry?.to || '').trim()),
      from: normalizePhone(String(entry?.from || '').trim()),
      conversationLanguage,
      startedAt: String(entry?.startedAt || '').trim(),
      messages,
      transcriptSnippet,
      source: entry?.source || 'conversation-log'
    });
  }

  return snapshots;
}

function toHumanReadableSpeaker(role = '') {
  const normalized = String(role || '').trim().toLowerCase();
  if (!normalized) {
    return 'Participant';
  }

  if (['assistant', 'agent', 'ai', 'bot'].includes(normalized)) {
    return 'Agent';
  }

  if (['user', 'caller', 'customer', 'human'].includes(normalized)) {
    return 'Prospect';
  }

  if (normalized === 'snippet') {
    return 'Transcript';
  }

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function normalizeTranscriptText(value = '') {
  return String(value || '')
    .replace(/â€™/g, '\'')
    .replace(/â€œ/g, '"')
    .replace(/â€/g, '"')
    .replace(/\u00a0/g, ' ')
    .trim();
}

function buildHumanReadableTranscript(messages = [], transcriptSnippet = '') {
  const normalizedMessages = Array.isArray(messages)
    ? messages
      .map((item) => {
        const text = normalizeTranscriptText(item?.text || '');
        if (!text) {
          return null;
        }

        const role = toHumanReadableSpeaker(item?.role || 'participant');
        return `${role}: ${text}`;
      })
      .filter(Boolean)
    : [];

  if (normalizedMessages.length > 0) {
    return normalizedMessages.join('\n\n');
  }

  const snippetLines = String(transcriptSnippet || '')
    .split(/\r?\n/)
    .map((line) => normalizeTranscriptText(line))
    .filter(Boolean);

  if (snippetLines.length === 0) {
    return '';
  }

  const normalizedSnippet = snippetLines.map((line) => {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) {
      return line;
    }

    const role = line.slice(0, separatorIndex).trim();
    const text = line.slice(separatorIndex + 1).trim();
    if (!text) {
      return toHumanReadableSpeaker(role);
    }

    return `${toHumanReadableSpeaker(role)}: ${text}`;
  });

  return normalizedSnippet.join('\n\n');
}

function getLatestTwilioCallStatusEntry(callSid = '', entries = []) {
  const normalizedCallSid = String(callSid || '').trim();
  if (!normalizedCallSid || !Array.isArray(entries)) {
    return null;
  }

  return entries.find((entry) => {
    const source = String(entry?.source || '').trim();
    const event = String(entry?.event || '').trim();
    const entryCallSid = String(entry?.callSid || '').trim();
    return source === 'twilio' && event === 'call-status' && entryCallSid === normalizedCallSid;
  }) || null;
}

function parseTimestampMs(value) {
  if (value === null || value === undefined || value === '') {
    return NaN;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const raw = String(value).trim();
  if (!raw) {
    return NaN;
  }

  if (/^\d{10,16}$/.test(raw)) {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber)) {
      return asNumber;
    }
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function getCallStatusTimelineBySid(callSid = '', entries = []) {
  const normalizedCallSid = String(callSid || '').trim();
  const list = Array.isArray(entries) ? entries : [];
  if (!normalizedCallSid || list.length === 0) {
    return {
      firstAtMs: NaN,
      lastAtMs: NaN,
      completedAtMs: NaN,
      to: '',
      from: ''
    };
  }

  const matches = list.filter((entry) => (
    String(entry?.source || '').trim() === 'twilio'
    && String(entry?.event || '').trim() === 'call-status'
    && String(entry?.callSid || '').trim() === normalizedCallSid
  ));

  if (matches.length === 0) {
    return {
      firstAtMs: NaN,
      lastAtMs: NaN,
      completedAtMs: NaN,
      to: '',
      from: ''
    };
  }

  let firstAtMs = NaN;
  let lastAtMs = NaN;
  let completedAtMs = NaN;
  let to = '';
  let from = '';

  for (const item of matches) {
    const whenMs = parseTimestampMs(item?.loggedAt);
    if (Number.isFinite(whenMs)) {
      if (!Number.isFinite(firstAtMs) || whenMs < firstAtMs) {
        firstAtMs = whenMs;
      }

      if (!Number.isFinite(lastAtMs) || whenMs > lastAtMs) {
        lastAtMs = whenMs;
      }

      if (String(item?.callStatus || '').trim().toLowerCase() === 'completed') {
        completedAtMs = whenMs;
      }
    }

    if (!to) {
      to = normalizePhone(String(item?.to || item?.payload?.To || ''));
    }

    if (!from) {
      from = normalizePhone(String(item?.from || item?.payload?.From || ''));
    }
  }

  return {
    firstAtMs,
    lastAtMs,
    completedAtMs,
    to,
    from
  };
}

function isTimestampWithinWindow(targetMs, centerMs, beforeWindowMs, afterWindowMs) {
  if (!Number.isFinite(targetMs) || !Number.isFinite(centerMs)) {
    return false;
  }

  return targetMs >= (centerMs - beforeWindowMs) && targetMs <= (centerMs + afterWindowMs);
}

const VUF_TRANSCRIPT_KEYWORDS = [
  'vishv umiya',
  'umiya',
  'umiya dham',
  'maa umiya',
  'foundation',
  'spiritual'
];

function getTranscriptDomainRelevanceScore(candidateRow = {}) {
  const normalized = normalizeFreeText(buildHumanReadableTranscript(
    candidateRow?.messages || [],
    candidateRow?.transcriptSnippet || ''
  ));

  if (!normalized) {
    return 0;
  }

  let score = 0;
  for (const keyword of VUF_TRANSCRIPT_KEYWORDS) {
    if (normalized.includes(keyword)) {
      score += 1;
    }
  }

  return score;
}

function detectMessageLanguageCode(text = '') {
  const value = String(text || '');
  if (!value.trim()) {
    return 'unknown';
  }

  if (/[\u0A80-\u0AFF]/.test(value)) {
    return 'gu';
  }

  if (/[\u0900-\u097F]/.test(value)) {
    return 'hi';
  }

  return 'en';
}

function languageLabelFromCode(code = '') {
  const normalized = String(code || '').trim().toLowerCase();
  if (normalized === 'gu') {
    return 'Gujarati';
  }

  if (normalized === 'hi') {
    return 'Hindi';
  }

  if (normalized === 'en') {
    return 'English';
  }

  return 'Unknown';
}

function buildLocalizedTranscriptMessages(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  return list.map((item) => {
    const role = String(item?.role || '').trim();
    const text = normalizeTranscriptText(item?.text || '');
    const language = detectMessageLanguageCode(text);
    return {
      role,
      speaker: toHumanReadableSpeaker(role),
      text,
      language,
      languageLabel: languageLabelFromCode(language)
    };
  }).filter((item) => Boolean(item.text));
}

function normalizeFreeText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLatestAgentMessage(payload = {}) {
  const messageCandidates = [
    payload?.messages,
    payload?.conversation?.messages,
    payload?.data?.messages,
    payload?.turns,
    payload?.conversation?.turns
  ];

  for (const list of messageCandidates) {
    if (!Array.isArray(list) || list.length === 0) {
      continue;
    }

    for (let index = list.length - 1; index >= 0; index -= 1) {
      const item = list[index] || {};
      const role = String(item?.role || item?.speaker || item?.source || item?.participant || '').trim().toLowerCase();
      const text = String(item?.text || item?.content || item?.message || '').trim();

      if (!text) {
        continue;
      }

      if (role.includes('agent') || role.includes('assistant') || role === 'ai') {
        return text;
      }
    }
  }

  const fallbackText = String(payload?.agentMessage || payload?.assistantMessage || payload?.response || '').trim();
  return fallbackText;
}

async function getElevenLabsRegisterCallTwiml({ fromNumber, toNumber, direction = 'inbound' }) {
  const apiKey = String(process.env.ELEVENLABS_API_KEY || '').trim();
  const agentId = String(process.env.ELEVENLABS_AGENT_ID || '').trim();

  if (!apiKey || !agentId) {
    throw new Error('Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID in environment.');
  }

  const response = await axios.post(
    'https://api.elevenlabs.io/v1/convai/twilio/register-call',
    {
      agent_id: agentId,
      from_number: fromNumber,
      to_number: toNumber,
      direction
    },
    {
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      timeout: 15000,
      responseType: 'text',
      validateStatus: () => true
    }
  );

  if (response.status < 200 || response.status >= 300) {
    let details = `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(String(response.data || '{}'));
      const msg = parsed?.detail?.message || parsed?.message || parsed?.detail || '';
      if (msg) {
        details = `${details}: ${msg}`;
      }
    } catch (_err) {
      const raw = String(response.data || '').trim();
      if (raw) {
        details = `${details}: ${raw.slice(0, 240)}`;
      }
    }

    throw new Error(`ElevenLabs register-call failed. ${details}`);
  }

  const raw = String(response.data || '').trim();
  const isXmlTwiml = raw.includes('<Response');
  if (isXmlTwiml) {
    return raw;
  }

  // Some gateways may wrap TwiML in JSON (e.g. { twiml: "..." }).
  try {
    const parsed = JSON.parse(raw);
    const wrappedTwiml = String(parsed?.twiml || parsed?.data?.twiml || '').trim();
    if (wrappedTwiml.includes('<Response')) {
      return wrappedTwiml;
    }
  } catch (_err) {
    // ignore JSON parse failures and throw a clear shape error below
  }

  throw new Error('ElevenLabs register-call returned payload without TwiML <Response>.');
}

// Health endpoint for Railway/Render
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'running', time: new Date().toISOString() });
});

app.get('/tester', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/tester/config-status', async (req, res) => {
  const resolvedPublicBase = await resolveWorkingPublicBaseUrl(req, { requirePublic: false });

  res.status(200).json({
    hasTwilioClient: Boolean(twilioClient && process.env.TWILIO_PHONE_NUMBER),
    publicBaseUrl: getPublicBaseUrl(),
    resolvedPublicBaseUrl: resolvedPublicBase.publicBaseUrl,
    resolvedPublicBaseHealth: resolvedPublicBase.health,
    twilioFromNumber: process.env.TWILIO_PHONE_NUMBER || '',
    companyName: getCompanyName(),
    supabaseUrl: supabaseUrl || '',
    conversationLogTable: supabaseConversationLogTable,
    conversationLogRetentionLimit: CONVERSATION_LOG_RETENTION_LIMIT,
    callTranscriptTable: supabaseCallTranscriptTable,
    callQualificationWorkbookFile: callQualificationWorkbookFilePath
  });
});

app.get('/tester/agent-playbook', (_req, res) => {
  return res.status(200).json(getAgentPlaybook());
});

app.get('/tester/conversation-log', async (req, res) => {
  const requestedLimit = Number(req.query?.limit || 100);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(CONVERSATION_LOG_RETENTION_LIMIT, Math.round(requestedLimit)))
    : CONVERSATION_LOG_RETENTION_LIMIT;

  const entries = await readConversationLog(limit);

  return res.status(200).json({
    table: supabaseConversationLogTable,
    total: entries.length,
    count: entries.length,
    limit,
    entries
  });
});

app.get('/tester/all-logs', async (req, res) => {
  const requestedLimit = Number(req.query?.limit || CONVERSATION_LOG_RETENTION_LIMIT);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(CONVERSATION_LOG_RETENTION_LIMIT, Math.round(requestedLimit)))
    : CONVERSATION_LOG_RETENTION_LIMIT;

  const entries = await readConversationLog(limit);

  return res.status(200).json({
    table: supabaseConversationLogTable,
    count: entries.length,
    limit,
    entries
  });
});

app.get('/tester/call-conversations', async (req, res) => {
  const requestedLimit = Number(req.query?.limit || 25);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(200, Math.round(requestedLimit)))
    : 25;

  const transcriptSnapshots = await readCallTranscriptSnapshots(3000);
  const fallbackSnapshots = buildConversationSnapshotsFromLogEntries(await readConversationLog(3000));
  const rows = buildConversationRowsFromSnapshots([...fallbackSnapshots, ...transcriptSnapshots], limit);

  return res.status(200).json({
    conversationLogTable: supabaseConversationLogTable,
    transcriptLogTable: supabaseCallTranscriptTable,
    count: rows.length,
    rows
  });
});

app.get('/tester/call-qualifications', async (req, res) => {
  const syncResult = await syncCallQualificationWorkbook();
  const transcriptRows = await readCallTranscriptSnapshots(20000);
  const rows = buildQualificationWorkbookRows(buildConversationRowsFromSnapshots(transcriptRows, 5000));

  return res.status(syncResult.ok ? 200 : 500).json({
    file: callQualificationWorkbookFilePath,
    count: rows.length,
    workbook: syncResult,
    rows
  });
});

app.get('/tester/call-qualifications.xlsx', async (req, res) => {
  const syncResult = await syncCallQualificationWorkbook();

  if (!syncResult.ok || !fs.existsSync(callQualificationWorkbookFilePath)) {
    return res.status(500).json(syncResult);
  }

  return res.download(callQualificationWorkbookFilePath, path.basename(callQualificationWorkbookFilePath));
});

app.get('/tester/call-transcript', async (req, res) => {
  const requestedCallSid = String(req.query?.callSid || '').trim();
  const requestedCallerPhone = normalizePhone(String(req.query?.callerPhone || req.query?.to || '').trim());
  if (!requestedCallSid && !requestedCallerPhone) {
    return res.status(400).json({
      error: 'Missing callSid or callerPhone query parameter.'
    });
  }

  const logEntries = await readConversationLog(5000);
  const transcriptSnapshots = await readCallTranscriptSnapshots(5000);
  const fallbackSnapshots = buildConversationSnapshotsFromLogEntries(logEntries);
  const rows = buildConversationRowsFromSnapshots([...fallbackSnapshots, ...transcriptSnapshots], 5000);
  const getRowTranscriptText = (candidateRow) => buildHumanReadableTranscript(
    candidateRow?.messages || [],
    candidateRow?.transcriptSnippet || ''
  );
  const hasRowTranscript = (candidateRow) => Boolean(String(getRowTranscriptText(candidateRow) || '').trim());
  const collectRowsByPhones = (phones = []) => {
    const normalized = phones
      .map((value) => normalizePhone(String(value || '').trim()))
      .filter(Boolean);

    if (normalized.length === 0) {
      return [];
    }

    const candidatePhones = new Set(normalized.flatMap((phone) => getPhoneLookupCandidates(phone)));

    return rows.filter((item) => {
      const rowPhone = normalizePhone(String(item?.callerPhone || '').trim());
      if (!rowPhone) {
        return false;
      }

      return getPhoneLookupCandidates(rowPhone).some((candidate) => candidatePhones.has(candidate));
    });
  };
  const chooseBestTranscriptRow = (candidates = []) => {
    const list = Array.isArray(candidates) ? candidates : [];
    if (list.length === 0) {
      return null;
    }

    return [...list]
      .sort((a, b) => {
        const aHasTranscript = hasRowTranscript(a) ? 1 : 0;
        const bHasTranscript = hasRowTranscript(b) ? 1 : 0;
        if (bHasTranscript !== aHasTranscript) {
          return bHasTranscript - aHasTranscript;
        }

        const aMessageCount = Array.isArray(a?.messages) ? a.messages.length : 0;
        const bMessageCount = Array.isArray(b?.messages) ? b.messages.length : 0;
        if (bMessageCount !== aMessageCount) {
          return bMessageCount - aMessageCount;
        }

        const relevanceDiff = getTranscriptDomainRelevanceScore(b) - getTranscriptDomainRelevanceScore(a);
        if (relevanceDiff !== 0) {
          return relevanceDiff;
        }

        return String(b?.lastAt || '').localeCompare(String(a?.lastAt || ''));
      })[0] || null;
  };
  let row = requestedCallSid
    ? (rows.find((item) => String(item?.callSid || '').trim() === requestedCallSid) || null)
    : null;
  const latestStatusEntry = getLatestTwilioCallStatusEntry(requestedCallSid, logEntries);
  const inMemoryMeta = activeCallMetaBySid.get(requestedCallSid) || null;

  if (!row && requestedCallerPhone) {
    row = chooseBestTranscriptRow(collectRowsByPhones([requestedCallerPhone]));
  }

  if (!row && requestedCallSid) {
    const inferredPhones = [
      normalizePhone(String(latestStatusEntry?.to || '')),
      normalizePhone(String(latestStatusEntry?.from || '')),
      normalizePhone(String(inMemoryMeta?.to || '')),
      normalizePhone(String(inMemoryMeta?.from || ''))
    ].filter(Boolean);

    if (inferredPhones.length > 0) {
      const timeline = getCallStatusTimelineBySid(requestedCallSid, logEntries);
      const candidates = collectRowsByPhones(inferredPhones)
        .filter((candidate) => {
          const candidateMs = parseTimestampMs(candidate?.lastAt || candidate?.startedAt || '');

          // Accept only transcripts close to this call lifecycle to avoid stale same-phone matches.
          if (Number.isFinite(timeline.completedAtMs)) {
            return isTimestampWithinWindow(candidateMs, timeline.completedAtMs, 30 * 60 * 1000, 3 * 60 * 60 * 1000);
          }

          if (Number.isFinite(timeline.lastAtMs)) {
            return isTimestampWithinWindow(candidateMs, timeline.lastAtMs, 45 * 60 * 1000, 3 * 60 * 60 * 1000);
          }

          return false;
        });

      row = chooseBestTranscriptRow(candidates);
    }
  }

  const transcriptCandidatePhones = [
    requestedCallerPhone,
    normalizePhone(String(row?.callerPhone || '').trim()),
    normalizePhone(String(latestStatusEntry?.to || '').trim()),
    normalizePhone(String(latestStatusEntry?.from || '').trim()),
    normalizePhone(String(inMemoryMeta?.to || '').trim()),
    normalizePhone(String(inMemoryMeta?.from || '').trim())
  ].filter(Boolean);
  const requestedTimeline = requestedCallSid
    ? getCallStatusTimelineBySid(requestedCallSid, logEntries)
    : null;
  const transcriptByPhoneCandidates = collectRowsByPhones(transcriptCandidatePhones)
    .filter((candidate) => {
      if (!requestedCallSid || !requestedTimeline) {
        return true;
      }

      const candidateMs = parseTimestampMs(candidate?.lastAt || candidate?.startedAt || '');

      if (Number.isFinite(requestedTimeline.completedAtMs)) {
        return isTimestampWithinWindow(candidateMs, requestedTimeline.completedAtMs, 30 * 60 * 1000, 3 * 60 * 60 * 1000);
      }

      if (Number.isFinite(requestedTimeline.lastAtMs)) {
        return isTimestampWithinWindow(candidateMs, requestedTimeline.lastAtMs, 45 * 60 * 1000, 3 * 60 * 60 * 1000);
      }

      return false;
    });
  const transcriptByPhoneRow = chooseBestTranscriptRow(transcriptByPhoneCandidates);

  if ((!row || !hasRowTranscript(row)) && transcriptByPhoneRow) {
    row = {
      ...(row || {}),
      ...transcriptByPhoneRow,
      callSid: String(row?.callSid || transcriptByPhoneRow?.callSid || requestedCallSid || '').trim() || requestedCallSid,
      callerPhone: String(row?.callerPhone || transcriptByPhoneRow?.callerPhone || requestedCallerPhone || '').trim()
    };
  }

  const callStatus = String(latestStatusEntry?.callStatus || inMemoryMeta?.status || 'unknown').trim().toLowerCase();
  const terminalStatuses = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);
  const normalizeDateOutput = (value) => {
    if (!value && value !== 0) {
      return '';
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return new Date(value).toISOString();
    }

    const asText = String(value || '').trim();
    if (!asText) {
      return '';
    }

    if (/^\d{10,16}$/.test(asText)) {
      const asNumber = Number(asText);
      if (Number.isFinite(asNumber)) {
        return new Date(asNumber).toISOString();
      }
    }

    return asText;
  };
  const transcriptText = getRowTranscriptText(row);
  const transcriptMessages = Array.isArray(row?.messages) ? row.messages : [];
  const localizedMessages = buildLocalizedTranscriptMessages(transcriptMessages);
  const languagesPresent = Array.from(new Set(localizedMessages.map((item) => item.language).filter(Boolean)));
  const conversationLanguageCode = String(
    row?.conversationLanguage
    || row?.language
    || (languagesPresent[0] || 'unknown')
  ).trim().toLowerCase();
  const leadDisposition = inferLeadDisposition({
    ...(row || {}),
    messages: transcriptMessages,
    transcriptSnippet: String(row?.transcriptSnippet || '').trim()
  });

  return res.status(200).json({
    callSid: requestedCallSid || String(row?.callSid || '').trim(),
    callStatus,
    isEnded: terminalStatuses.has(callStatus),
    startedAt: normalizeDateOutput(row?.startedAt || inMemoryMeta?.startedAt || ''),
    lastAt: normalizeDateOutput(row?.lastAt || latestStatusEntry?.loggedAt || ''),
    updateCount: Number(row?.updateCount || 0),
    conversationId: String(row?.conversationId || '').trim(),
    callerPhone: String(row?.callerPhone || requestedCallerPhone || '').trim(),
    messageCount: transcriptMessages.length,
    conversationLanguage: conversationLanguageCode,
    conversationLanguageLabel: languageLabelFromCode(conversationLanguageCode),
    leadDisposition: leadDisposition.disposition,
    willingToJoin: leadDisposition.willingToJoin,
    response: leadDisposition.responseLabel,
    evidence: leadDisposition.evidence,
    transcriptText,
    transcriptMessages,
    transcriptMessagesLocalized: localizedMessages,
    languagesPresent,
    hasTranscript: Boolean(transcriptText)
  });
});

function buildBrowserDemoReplyText(userText = '', preferredLanguage = 'en') {
  const normalized = normalizeFreeText(userText);
  const lang = ['en', 'hi', 'gu'].includes(preferredLanguage) ? preferredLanguage : 'en';

  if (/\b(no|not interested|stop|busy|later|no thanks)\b/i.test(normalized)) {
    if (lang === 'hi') {
      return 'Dhanyavaad. Aapka samay dene ke liye shukriya. Maa Umiya aapko ashirwad de.';
    }

    if (lang === 'gu') {
      return 'Aabhar. Tamara samay mate khub khub aabhar. Maa Umiya na aashirvad sathe.';
    }

    return 'Thank you for your time. Maa Umiya bless you. We can reconnect later if you wish.';
  }

  if (/\b(yes|interested|join|support|donate|how|details)\b/i.test(normalized)) {
    if (lang === 'hi') {
      return 'Bahut accha. Vishv Umiya Foundation adhyatmikta, shiksha, swasthya aur samaj seva par kaam karta hai. Kya aap judne ke liye tayyar hain?';
    }

    if (lang === 'gu') {
      return 'Saras. Vishv Umiya Foundation adhyatmikta, shikshan, aarogya ane samaj seva ma karya kare chhe. Shu tame aa mission ma jodava ichho cho?';
    }

    return 'Wonderful. Vishv Umiya Foundation serves through spirituality, education, healthcare, and community upliftment. Would you be open to joining this mission?';
  }

  if (lang === 'hi') {
    return 'Namaste. Hum Vishv Umiya Foundation se hain. Hum Umiya Dham aur samaj sewa ke liye kaam karte hain. Kya aap is mission ke baare mein aur sunna chahenge?';
  }

  if (lang === 'gu') {
    return 'Namaste. Ame Vishv Umiya Foundation mathi bolie chhiye. Ame Umiya Dham ane samaj seva na mission par kaam kariye chhiye. Shu tame vadhare sambhalva ichho cho?';
  }

  return 'Namaste. We are calling from Vishv Umiya Foundation. We are building Umiya Dham and serving communities through spiritual and social initiatives. Would you like to know more?';
}

app.post('/tester/browser-demo-reply', (req, res) => {
  const userText = normalizeTranscriptText(String(req.body?.text || '').trim());
  const language = String(req.body?.language || detectMessageLanguageCode(userText)).trim().toLowerCase();
  const preferredLanguage = ['en', 'hi', 'gu'].includes(language) ? language : 'en';
  const reply = buildBrowserDemoReplyText(userText, preferredLanguage);

  appendConversationLog({
    source: 'browser-demo',
    event: 'demo-turn',
    language: preferredLanguage,
    userText,
    reply
  });

  return res.status(200).json({
    language: preferredLanguage,
    reply
  });
});

app.get('/tester/public-url-health', async (_req, res) => {
  const health = await checkPublicBaseUrlHealth();
  return res.status(health.ok ? 200 : 503).json(health);
});

app.post('/twilio/call-status', (req, res) => {
  const callSid = String(req.body?.CallSid || 'unknown');
  const callStatus = String(req.body?.CallStatus || 'unknown').toLowerCase();
  const to = normalizePhone(String(req.body?.To || 'unknown'));
  const from = normalizePhone(String(req.body?.From || 'unknown'));
  const duration = String(req.body?.CallDuration || req.body?.Duration || '');
  const sipResponseCode = String(req.body?.SipResponseCode || '');
  const answeredBy = String(req.body?.AnsweredBy || '');

  const detailsParts = [`CallSid=${callSid}`, `from=${from}`, `to=${to}`];

  if (duration) {
    detailsParts.push(`duration=${duration}s`);
  }

  if (sipResponseCode) {
    detailsParts.push(`sip=${sipResponseCode}`);
  }

  if (answeredBy) {
    detailsParts.push(`answeredBy=${answeredBy}`);
  }

  if (callStatus === 'no-answer') {
    detailsParts.push('hint=phone_not_answered_or_not_reachable');
  }

  if (['initiated', 'ringing', 'answered', 'in-progress'].includes(callStatus)) {
    rememberActiveCall(to, callSid);
    rememberActiveCall(from, callSid);
    upsertActiveCallMeta({ callSid, to, from, status: callStatus });

    if (['answered', 'in-progress'].includes(callStatus)) {
      appendConversationLog({
        source: 'conversation-store',
        event: 'caller-picked-up',
        callSid,
        callStatus,
        to,
        from
      });

      ensureConversationAggregate({
        callSid,
        callerPhone: to || from
      });
    }

  }

  if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(callStatus)) {
    clearActiveCall(to);
    clearActiveCall(from);
    finalizeConversationAggregateForCall({ callSid, callStatus, to, from });
    removeActiveCallMeta(callSid);
  }

  appendConversationLog({
    source: 'twilio',
    event: 'call-status',
    callSid,
    callStatus,
    to,
    from,
    duration,
    sipResponseCode,
    answeredBy,
    payload: req.body
  });

  pushLimited(recentEvents, {
    id: `evt-${Date.now()}`,
    type: `twilio-call-${callStatus}`,
    time: nowUkString(),
    details: detailsParts.join(' ')
  });

  return res.status(200).json({ status: 'ok' });
});

app.post('/twilio/stream-status', (req, res) => {
  const streamSid = String(req.body?.StreamSid || req.body?.StreamSid || 'unknown');
  const streamEvent = String(req.body?.StreamEvent || 'unknown');
  const streamError = String(req.body?.StreamError || '');
  const callSid = String(req.body?.CallSid || 'unknown');

  pushLimited(recentEvents, {
    id: `evt-${Date.now()}`,
    type: `twilio-stream-${streamEvent}`,
    time: nowUkString(),
    details: `CallSid=${callSid} StreamSid=${streamSid}${streamError ? ` Error=${streamError}` : ''}`
  });

  appendConversationLog({
    source: 'twilio',
    event: 'stream-status',
    callSid,
    streamSid,
    streamEvent,
    streamError,
    payload: req.body
  });

  return res.status(200).json({ status: 'ok' });
});

async function handleTesterStartCall(req, res) {
  try {
    const to = String(req.body?.to || req.query?.to || '').trim();
    const dialTimeoutSeconds = getDialTimeoutSeconds();
    const maxCallSeconds = getMaxCallSeconds();
    const { publicBaseUrl: callbackBaseUrl, health: publicUrlHealth } = await resolveWorkingPublicBaseUrl(req, { requirePublic: true });

    if (!callbackBaseUrl || !publicUrlHealth.ok) {
      appendConversationLog({
        source: 'tester',
        event: 'start-call-blocked-public-url-unhealthy',
        to,
        publicBaseUrl: publicUrlHealth.publicBaseUrl,
        statusCode: publicUrlHealth.statusCode,
        reason: publicUrlHealth.reason
      });

      return res.status(400).json({
        error: 'Cannot start call because PUBLIC_BASE_URL is unreachable for callbacks.',
        publicBaseUrl: publicUrlHealth.publicBaseUrl,
        callbackHealth: publicUrlHealth,
        fix: 'Start ngrok (or your public host), update PUBLIC_BASE_URL, then retry.'
      });
    }

    appendConversationLog({
      source: 'tester',
      event: 'start-call-requested',
      to,
      payload: req.body
    });

    if (!/^\+\d{8,15}$/.test(to)) {
      return res.status(400).json({
        error: 'Invalid phone number. Use E.164 format, for example +27871234567.'
      });
    }

    if (!twilioClient || !process.env.TWILIO_PHONE_NUMBER) {
      return res.status(400).json({
        error: 'Twilio credentials or TWILIO_PHONE_NUMBER are missing in .env.'
      });
    }

    let twiml;
    try {
      twiml = await getElevenLabsRegisterCallTwiml({
        fromNumber: process.env.TWILIO_PHONE_NUMBER,
        toNumber: to,
        direction: 'outbound'
      });
    } catch (registerError) {
      const message = registerError?.message || 'Unknown register-call error';

      pushLimited(recentEvents, {
        id: `evt-${Date.now()}`,
        type: 'elevenlabs-register-call-error',
        time: nowUkString(),
        details: message
      });

      return res.status(400).json({
        error: message,
        fix:
          'Create/update ElevenLabs API key with convai_write permission and verify ELEVENLABS_AGENT_ID points to a published agent.'
      });
    }

    const call = await twilioClient.calls.create({
      to,
      from: process.env.TWILIO_PHONE_NUMBER,
      twiml,
      timeout: dialTimeoutSeconds,
      timeLimit: maxCallSeconds,
      statusCallback: `${callbackBaseUrl}/twilio/call-status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
    });

    // Record immediately so webhook processing can resolve caller phone quickly.
    rememberActiveCall(to, call.sid);
    upsertActiveCallMeta({
      callSid: call.sid,
      to,
      from: process.env.TWILIO_PHONE_NUMBER,
      status: 'queued'
    });

    appendConversationLog({
      source: 'tester',
      event: 'start-call-queued',
      callSid: call.sid,
      to,
      from: process.env.TWILIO_PHONE_NUMBER,
      callbackBaseUrl,
      dialTimeoutSeconds,
      maxCallSeconds
    });

    pushLimited(recentEvents, {
      id: `evt-${Date.now()}`,
      type: 'outbound-call-started',
      time: nowUkString(),
      details: `Call ${call.sid} started to ${to}`
    });

    return res.status(200).json({
      status: 'queued',
      callSid: call.sid,
      to,
      from: process.env.TWILIO_PHONE_NUMBER,
      callbackBaseUrl,
      dialTimeoutSeconds,
      maxCallSeconds
    });
  } catch (error) {
    console.error('[tester] start-call error:', error);

    appendConversationLog({
      source: 'tester',
      event: 'start-call-error',
      to: String(req.body?.to || req.query?.to || '').trim(),
      error: error?.message || 'Unknown start-call error'
    });

    pushLimited(recentEvents, {
      id: `evt-${Date.now()}`,
      type: 'outbound-call-error',
      time: nowUkString(),
      details: error?.message || 'Unknown start-call error'
    });

    return res.status(500).json({
      error: error.message
    });
  }
}

app.post('/tester/start-call', handleTesterStartCall);
app.get('/tester/start-call', handleTesterStartCall);
app.post('/tester/launch-outbound', handleTesterStartCall);
app.get('/tester/launch-outbound', handleTesterStartCall);

app.get('/_meta/endpoints', (_req, res) => {
  res.status(200).json({
    name: 'Marketing Voice Agent',
    endpoints: [
      '/elevenlabs/webhook',
      '/health',
      '/tester',
      '/tester/agent-playbook'
    ]
  });
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function handleElevenLabsWebhook(req, res, receivedVia = '/elevenlabs/webhook') {
  const payload = req.body || {};
  const query = req.query || {};
  const extractedCallSid = extractCallSid(payload);
  const callerPhone = extractCallerPhone(payload, query);
  const conversationId = extractConversationId(payload, query);
  const webhookType = String(payload?.type || payload?.event || payload?.event_type || payload?.webhook_event || 'unknown').trim();
  const transcriptSnippet = extractTranscriptSnippet(payload);
  const transcriptMessages = extractTranscriptMessages(payload);
  const conversationLanguage = String(
    payload?.data?.metadata?.main_language
    || payload?.data?.main_language
    || payload?.language
    || payload?.lang
    || ''
  ).trim().toLowerCase();
  const leadDisposition = inferLeadDisposition({ messages: transcriptMessages, transcriptSnippet, payload, conversationId, callerPhone, callSid: extractedCallSid });

  let callSid = extractedCallSid
    || findActiveCallSidByConversationId(conversationId)
    || findActiveCallSidByPhone(callerPhone)
    || findSingleActiveTransferCandidateCallSid();

  if (!callSid && callerPhone) {
    callSid = await findRecentCallSidByPhoneFromLog(callerPhone);
  }

  if (callSid && callerPhone) {
    rememberActiveCall(callerPhone, callSid);
    upsertActiveCallMeta({ callSid, to: callerPhone, status: 'in-progress' });
  }

  if (conversationId && callSid) {
    rememberActiveCallByConversationId(conversationId, callSid);
  }

  const aggregate = upsertConversationAggregateFromWebhook({
    callSid,
    conversationId,
    callerPhone,
    transcriptMessages,
    transcriptSnippet
  });

  appendConversationLog({
    source: 'elevenlabs',
    event: 'webhook',
    receivedVia,
    webhookType,
    callSid,
    callerPhone,
    conversationId,
    transcriptSnippet,
    transcriptMessageCount: transcriptMessages.length,
    aggregateMessageCount: aggregate?.messages?.length || 0,
    conversationLanguage,
    leadDisposition: leadDisposition.disposition,
    willingToJoin: leadDisposition.willingToJoin,
    response: leadDisposition.responseLabel,
    payload
  });

  if (
    webhookType === 'post_call_transcription'
    && (callSid || conversationId || transcriptMessages.length > 0 || transcriptSnippet)
  ) {
    appendCallTranscriptSnapshot({
      source: 'elevenlabs',
      event: 'post_call_transcription',
      callSid,
      callerPhone,
      conversationId,
      conversationLanguage,
      messages: aggregate?.messages || transcriptMessages,
      transcriptSnippet: aggregate?.transcriptSnippet || transcriptSnippet,
      updateCount: aggregate?.updateCount || 0,
      leadDisposition: leadDisposition.disposition,
      willingToJoin: leadDisposition.willingToJoin,
      response: leadDisposition.responseLabel,
      leadEvidence: leadDisposition.evidence
    });
  }

  pushLimited(recentEvents, {
    id: `evt-${Date.now()}`,
    type: `elevenlabs-webhook-${webhookType || 'unknown'}`,
    time: nowUkString(),
    details: `path=${receivedVia} conversation=${conversationId || 'unknown'} callSid=${callSid || 'unknown'} caller=${callerPhone || 'unknown'}`
  });

  return res.status(200).json({
    status: 'ok'
  });
}

app.post('/elevenlabs/webhook', (req, res) => handleElevenLabsWebhook(req, res, '/elevenlabs/webhook'));
app.post('/elevenlabs/post-call', (req, res) => handleElevenLabsWebhook(req, res, '/elevenlabs/post-call'));
app.post('/elevenlabs', (req, res) => handleElevenLabsWebhook(req, res, '/elevenlabs'));
app.post('/', (req, res) => {
  const payload = req.body || {};

  if (!isLikelyElevenLabsWebhookRequest(req, payload)) {
    return res.status(404).json({
      error: 'Unknown POST path. For ElevenLabs use /elevenlabs/webhook.'
    });
  }

  return handleElevenLabsWebhook(req, res, '/');
});


app.get('/tester/recent-events', (_req, res) => {
  res.status(200).json({ events: recentEvents });
});

const requestedPort = Number(process.env.PORT || 3000);

function startServer(initialPort) {
  let activePort = Number(initialPort || 3000);
  const maxAttempts = 5;
  let attempts = 0;

  const tryListen = () => {
    attempts += 1;
    const server = app.listen(activePort, () => {
      (async () => {
        const backfilledCount = await backfillTranscriptSnapshotsFromConversationLog();
        if (backfilledCount > 0) {
          console.log(`[call-transcript-log] Backfilled ${backfilledCount} transcript snapshot(s) from conversation history.`);
        }
        const workbookSync = await syncCallQualificationWorkbook();
        if (workbookSync.ok) {
          console.log(`[call-qualification-export] Workbook updated: ${workbookSync.file}`);
        }
        await checkConfig();
        console.log(`Marketing Voice Agent running on port ${activePort}`);
        if (activePort !== requestedPort) {
          console.log(`[startup] Requested port ${requestedPort} was unavailable. Using fallback port ${activePort}.`);
        }
      })().catch((error) => {
        console.error('[startup] Post-start tasks failed:', error?.message || error);
      });
    });

    server.on('error', (error) => {
      if (error?.code === 'EADDRINUSE' && attempts < maxAttempts) {
        console.warn(`[startup] Port ${activePort} is already in use. Trying ${activePort + 1}...`);
        activePort += 1;
        setTimeout(tryListen, 150);
        return;
      }

      console.error('[startup] Failed to start server:', error?.message || error);
      process.exit(1);
    });
  };

  tryListen();
}

if (process.env.VERCEL) {
  module.exports = app;
} else {
  startServer(requestedPort);
}
