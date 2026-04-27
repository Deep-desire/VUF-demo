# Vishv Umiya Foundation Voice Agent (Twilio + ElevenLabs)

This project runs a VUF outreach voice conversation flow:

- Start outbound calls from the local tester UI.
- Introduce Vishv Umiya Foundation and capture willingness to join/support.
- Capture call/webhook conversation history in logs.
- Keep each call bounded by `MAX_CALL_SECONDS`.

## 1) Prerequisites

- Node.js 18+
- Twilio account with a voice-enabled number
- ElevenLabs Conversational AI agent
- Optional: ngrok for local public callbacks

## 2) Local setup

```bash
npm install
npm start
```

Open:

- `http://localhost:3000/tester`
- `http://localhost:3000/health`

## 3) Environment variables

Copy `.env.example` to `.env` and set values.

Important keys:

- `ELEVENLABS_API_KEY`
- `ELEVENLABS_AGENT_ID`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER`
- `COMPANY_NAME`
- `MAX_CALL_SECONDS`
- `TWILIO_DIAL_TIMEOUT_SECONDS`
- `PUBLIC_BASE_URL`
- `CONVERSATION_LOG_FILE`
- `CALL_TRANSCRIPT_LOG_FILE`
- `CALL_QUALIFICATION_WORKBOOK_FILE`
- `ELEVENLABS_WEBHOOK_REQUIRE_SIGNATURE`
- `ELEVENLABS_WEBHOOK_SECRET`

## 4) ngrok setup (optional)

1. Run app on port 3000.
2. Start tunnel: `ngrok http 3000`
3. Set `PUBLIC_BASE_URL` to the HTTPS tunnel URL.

## 5) ElevenLabs setup

- Configure webhook URL to `POST https://<your-domain>/elevenlabs/webhook`.
- You can fetch the prompt/playbook JSON from `GET /tester/agent-playbook`.

## 6) Browser testing

Use `http://localhost:3000/tester`:

1. Enter prospect number.
2. Click `Start Real Call`.
3. Monitor call logs and transcript endpoints.

## 7) Endpoints

- `GET /health`
- `GET /tester`
- `GET /tester/config-status`
- `GET /tester/agent-playbook`
- `GET /tester/conversation-log`
- `GET /tester/public-url-health`
- `GET /tester/call-conversations`
- `GET /tester/call-qualifications`
- `GET /tester/call-qualifications.xlsx`
- `GET /tester/call-transcript`
- `POST /tester/start-call`
- `POST /elevenlabs/webhook`
- `POST /elevenlabs/post-call`
- `POST /elevenlabs`
- `GET /tester/recent-events`
