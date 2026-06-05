# Twilio Voice Agent (AssemblyAI Voice Agent API)

A minimal example showing how to bridge Twilio Programmable Voice with AssemblyAI's Voice Agent API. Caller ↔ Twilio Media Streams ↔ this server ↔ `wss://agents.assemblyai.com/v1/realtime`.

> Example only — not hardened for production. No retry logic, rate limiting, or call-state persistence.

## How it works

1. A caller dials your Twilio number.
2. Twilio hits `POST /twiml` on this server. The server returns TwiML containing a `<Stream>` pointed at `wss://<your-hostname>/media-stream/<callId>`.
3. Twilio opens a Media Streams WebSocket and starts sending the caller's audio (G.711 μ-law, 8 kHz).
4. The server opens a parallel WebSocket to the Voice Agent API and sends a `session.update` with the system prompt, voice, greeting, tools, and audio format set to `audio/pcmu`.
5. Once `session.ready` fires, the server forwards μ-law payloads in both directions:
   - `Twilio → AssemblyAI`: each Twilio `media` event becomes an `input.audio` event.
   - `AssemblyAI → Twilio`: each `reply.audio` event becomes a Twilio `media` action.
6. When the user barges in (`input.speech.started`), the server sends a Twilio `clear` action so the bot stops talking immediately.

Because Twilio's native format and the Voice Agent API's `audio/pcmu` are byte-compatible, audio is forwarded as base64 with **zero transcoding**.

## Get started

### Prerequisites

- A Twilio account with a phone number ([buy one](https://www.twilio.com/console/phone-numbers/search))
- An AssemblyAI API key with Voice Agent access ([dashboard](https://www.assemblyai.com/app))
- [ngrok](https://ngrok.com/docs/getting-started/) (for local development)
- Node.js 20+

### 1. Install

```bash
git clone <this-repo>
cd twilio-voice-agent
npm install
```

### 2. Start an ngrok tunnel

Twilio needs a public URL to send webhooks and open the Media Streams WebSocket against. ngrok exposes your local server on a public HTTPS endpoint.

```bash
ngrok http 3000
```

Copy the `https://...ngrok.app` URL.

### 3. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in:

```bash
ASSEMBLYAI_API_KEY=your-assemblyai-api-key
PUBLIC_HOSTNAME=https://your-ngrok-domain.ngrok.app
```

### 4. Run the server

```bash
npm run dev
```

You should see `Server running on http://localhost:3000`.

### 5. Point Twilio at it

In the [Twilio Console](https://console.twilio.com/), open your phone number's Voice configuration and set:

- **A call comes in** → Webhook → `POST` → `https://<your-hostname>/twiml`
- **Call status changes** (optional) → Webhook → `POST` → `https://<your-hostname>/call-status`

### 6. Call your number

Dial your Twilio number from any phone. You should hear the greeting, then have a normal back-and-forth conversation. Watch the server logs to see the event stream.

## Outbound calls

Set the Twilio credentials in `.env`:

```bash
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your-twilio-auth-token
TWILIO_PHONE_NUMBER=+15551234567
TARGET_PHONE_NUMBER=+15557654321
```

With the server still running, in a new terminal:

```bash
npm run outbound
```

This places a call from your Twilio number to the target. Twilio fetches `/outbound-twiml`, which connects the call to `/outbound-stream`. The agent uses the `OUTBOUND_PROMPT` and speaks first via the `greeting` field — no extra signaling required because the Voice Agent API plays the configured greeting automatically when `session.ready` fires.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Express server, inbound + outbound flows, Twilio ↔ Voice Agent API bridge |
| `src/twilio.ts` | Typed wrapper around the Twilio Media Streams WebSocket |
| `src/bot.ts` | System prompt, default greeting, tool definitions, tool dispatch |
| `src/outbound.ts` | Standalone script that places a call via the Twilio REST API |

## Tool calls

The example registers one tool, `generate_random_number`. When the model decides to call it:

1. Voice Agent API → server: `tool.call` event with `call_id`, `name`, `args`.
2. Server runs the tool (in `bot.ts → runTool`) and returns a JSON string.
3. Server → Voice Agent API: `tool.result` event with the same `call_id`.
4. The model continues the conversation, naturally working the result into its next reply.

Add new tools by extending the `TOOLS` array and adding a `case` to `runTool`.

## Audio format

Both directions use **`audio/pcmu`** (G.711 μ-law, 8 kHz, mono). This is Twilio's native phone-call codec, so no resampling or transcoding is needed — the server forwards base64 payloads as-is. The full audio path on the call has only one encoding step (the caller's mic → μ-law on Twilio's edge) and one decoding step (μ-law → speaker at the listener's end).

If you adapt this example to a non-telephony transport (e.g. browser via WebRTC), switch to `audio/pcm` at 24 kHz on both sides.

## Troubleshooting

- **Twilio call connects but you hear nothing.** Check `PUBLIC_HOSTNAME` matches your ngrok domain and that your server is reachable. Watch ngrok's request log for the incoming Media Streams WebSocket.
- **`session.error` with code `invalid_value` on the `voice` field.** Voice names are case-sensitive — use lowercase (`ivy`, `claire`, `dawn`, etc.).
- **Greeting plays but later replies don't.** Make sure your tool handler always sends a `tool.result` back. The model waits for it before continuing.
- **Audio is choppy or echoey.** Twilio echo cancellation runs on the carrier side, so software AEC isn't needed on this server. If you're hearing echo locally during testing, it's likely your speakerphone — use a headset.

## Reference

- [AssemblyAI Voice Agent API docs](https://www.assemblyai.com/docs/voice-agents/speech-to-speech)
- [Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams)
- [Twilio Programmable Voice](https://www.twilio.com/docs/voice)
