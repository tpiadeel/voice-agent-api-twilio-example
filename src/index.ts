/**
 * Twilio ↔ AssemblyAI Voice Agent API bridge.
 *
 * - POST /twiml          — Twilio incoming-call webhook. Returns a <Stream/> TwiML response
 *                           that points the call at /media-stream/<callId>.
 * - WS   /media-stream/* — Twilio Media Streams WebSocket. Bridges the caller's μ-law
 *                           audio to a WebSocket connection to the Voice Agent API.
 *
 * Both sides use audio/pcmu (G.711 μ-law) at 8 kHz. Twilio's native format matches
 * the Voice Agent API's `audio/pcmu` encoding exactly, so we forward base64 payloads
 * with no transcoding.
 *
 * - POST /outbound-twiml — TwiML for outbound calls placed by `npm run outbound`.
 * - WS   /outbound-stream — Outbound flow. Agent speaks first.
 */

import "dotenv-flow/config";
import express from "express";
import ExpressWs from "express-ws";
import * as crypto from "crypto";
import WebSocket from "ws";
import { SYSTEM_PROMPT, DEFAULT_GREETING, TOOLS, runTool } from "./bot";
import { TwilioMediaStreamWebsocket } from "./twilio";

const { app } = ExpressWs(express());
app.use(express.urlencoded({ extended: true })).use(express.json());

// ----------------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------------

const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY || "";
const AAI_AGENT_URL = process.env.AAI_AGENT_URL || "wss://agents.assemblyai.com/v1/realtime";
const ENABLE_TOOLS = process.env.ENABLE_TOOLS !== "false";

if (!ASSEMBLYAI_API_KEY) {
  console.error("Missing ASSEMBLYAI_API_KEY");
  process.exit(1);
}

const log = (callId: string, event: string, extra?: string) => {
  if (extra) console.log(`[${callId}] ${event}\n  ${extra}`);
  else console.log(`[${callId}] ${event}`);
};

const newCallId = () => `call_${crypto.randomBytes(8).toString("hex")}`;

// ----------------------------------------------------------------------------
// Voice Agent API session config (Twilio-friendly defaults)
// ----------------------------------------------------------------------------

function buildSessionUpdate(opts: {
  systemPrompt: string;
  greeting: string;
  voice?: string;
  withTools?: boolean;
}) {
  return {
    type: "session.update",
    session: {
      system_prompt: opts.systemPrompt,
      greeting: opts.greeting,
      // Twilio sends G.711 μ-law at 8 kHz — match it on input and output
      // so the Voice Agent API doesn't need to transcode.
      input: { type: "audio", format: { encoding: "audio/pcmu" } },
      output: {
        type: "audio",
        voice: opts.voice ?? "winter",
        format: { encoding: "audio/pcmu" },
      },
      ...(opts.withTools ? { tools: TOOLS } : {}),
    },
  };
}

// ----------------------------------------------------------------------------
// HTTP endpoints
// ----------------------------------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.post("/twiml", (req, res) => {
  if (!process.env.PUBLIC_HOSTNAME) {
    res.status(500).send("PUBLIC_HOSTNAME env var not set");
    return;
  }

  const callId = newCallId();
  const hostname = process.env.PUBLIC_HOSTNAME.replace(/^https?:\/\//, "");
  const streamUrl = `wss://${hostname}/media-stream/${callId}`;

  res.type("text/xml").status(200).send(
    `<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`,
  );
});

app.post("/call-status", (_req, res) => {
  res.status(200).send();
});

// ----------------------------------------------------------------------------
// Inbound: /media-stream/:callId
// ----------------------------------------------------------------------------

app.ws("/media-stream/:callId", async (ws, req) => {
  // Express types req.params as `string | string[]`; in practice this route
  // gives a string but TypeScript can't tell.
  const callId = String(req.params.callId);
  console.log(`\n[${callId}] === CALL STARTED ===`);

  const tw = new TwilioMediaStreamWebsocket(ws);
  let twilioCallSid = "";

  tw.on("start", (msg) => {
    tw.streamSid = msg.start.streamSid;
    twilioCallSid = msg.start.callSid;
    log(callId, "twilio.start", `callSid=${twilioCallSid}`);
  });

  // Hang up the call. Closing the Twilio media-stream WebSocket ends the
  // <Connect> verb; with no further TwiML the PSTN call terminates.
  const hangup = () => {
    log(callId, "hangup");
    if (aaiWs.readyState === WebSocket.OPEN) aaiWs.close();
    if (ws.readyState === ws.OPEN) ws.close();
  };

  // The agent's goodbye audio is buffered inside Twilio. We send a mark after
  // it and only hang up once Twilio echoes the mark back — i.e. playback is
  // done — so the goodbye isn't cut off.
  tw.on("mark", (msg) => {
    if (msg.mark.name === "hangup") hangup();
  });

  // Connect to Voice Agent API
  const aaiWs = new WebSocket(AAI_AGENT_URL, {
    headers: { Authorization: `Bearer ${ASSEMBLYAI_API_KEY}` },
  });

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      aaiWs.close();
      reject(new Error("Voice Agent API connection timeout"));
    }, 10_000);
    aaiWs.once("open", () => {
      clearTimeout(t);
      log(callId, "aai.open");
      resolve();
    });
    aaiWs.once("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });

  // Send the session config immediately. The server only fires session.ready after
  // it receives a session.update, and `greeting` / `output` are immutable after
  // the first update, so we set them now.
  const sessionUpdate = buildSessionUpdate({
    systemPrompt: SYSTEM_PROMPT,
    greeting: DEFAULT_GREETING,
    withTools: ENABLE_TOOLS,
  });
  aaiWs.send(JSON.stringify(sessionUpdate));
  log(callId, "aai.session.update sent");

  let sessionReady = false;
  let turnCount = 0;
  let turnActive = false;

  // ---- Voice Agent API → Twilio ----
  aaiWs.on("message", (data) => {
    let event: any;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }

    // Server-side error events come without a `type` field.
    if (event.type === undefined && event.code) event.type = "session.error";

    // Quiet for the high-volume audio events
    if (event.type !== "reply.audio") log(callId, event.type ?? "?");

    switch (event.type) {
      case "session.ready":
        sessionReady = true;
        log(callId, "aai.session.ready", `id=${event.session_id}`);
        break;

      case "reply.started":
        if (turnActive) log(callId, `=== TURN ${turnCount} INTERRUPTED ===`);
        turnCount++;
        turnActive = true;
        log(callId, `=== START TURN ${turnCount} ===`);
        break;

      case "reply.audio":
        // Server sends base64 μ-law bytes — pass straight through to Twilio.
        if (tw.streamSid && event.data) {
          tw.send({
            event: "media",
            streamSid: tw.streamSid,
            media: { payload: event.data },
          });
        }
        break;

      case "input.speech.started":
        // User barged in — drop any audio Twilio has buffered so the bot
        // stops talking immediately.
        if (tw.streamSid) {
          tw.send({ event: "clear", streamSid: tw.streamSid });
        }
        break;

      case "transcript.user":
        if (event.text) console.log(`[${callId}] User: "${event.text}"`);
        break;

      case "transcript.agent":
        if (event.text) console.log(`[${callId}] Agent: "${event.text}"`);
        break;

      case "tool.call":
        handleToolCall(callId, event, aaiWs)
          .then(() => {
            if (event.name !== "end_call") return;
            // Queue a mark behind any goodbye audio; hang up when it echoes
            // back. If the stream isn't up, hang up immediately.
            if (tw.streamSid) {
              tw.send({ event: "mark", streamSid: tw.streamSid, mark: { name: "hangup" } });
            } else {
              hangup();
            }
          })
          .catch((e) => console.error(`[${callId}] tool error`, e));
        break;

      case "reply.done":
        turnActive = false;
        log(callId, `=== END TURN ${turnCount} (status=${event.status ?? "completed"}) ===`);
        break;

      case "session.error":
      case "error":
        console.error(
          `[${callId}] ERROR ${event.code ?? ""} ${event.message ?? JSON.stringify(event)}`,
        );
        break;
    }
  });

  // ---- Twilio → Voice Agent API ----
  tw.on("media", (msg) => {
    if (!sessionReady) return;
    if (msg.media.track !== "inbound") return;
    if (aaiWs.readyState !== WebSocket.OPEN) return;
    aaiWs.send(JSON.stringify({ type: "input.audio", audio: msg.media.payload }));
  });

  // ---- Cleanup ----
  aaiWs.on("close", (code) => log(callId, "aai.close", `code=${code}`));
  aaiWs.on("error", (e) => log(callId, "aai.error", String(e)));

  ws.on("close", () => {
    log(callId, "twilio.close");
    if (aaiWs.readyState === WebSocket.OPEN || aaiWs.readyState === WebSocket.CONNECTING) {
      aaiWs.close();
    }
  });
});

// ----------------------------------------------------------------------------
// Tool dispatch
// ----------------------------------------------------------------------------

async function handleToolCall(callId: string, event: any, aaiWs: WebSocket) {
  const name: string = event.name ?? "";
  const args: Record<string, any> =
    typeof event.args === "string"
      ? safeParse(event.args)
      : event.args && typeof event.args === "object"
      ? event.args
      : {};

  console.log(`[${callId}] tool.call ${name}(${JSON.stringify(args)})`);
  const result = await runTool(name, args);
  console.log(`[${callId}] tool.result ${result}`);

  aaiWs.send(
    JSON.stringify({
      type: "tool.result",
      call_id: event.call_id,
      result, // already a JSON string
      is_error: false,
    }),
  );
}

function safeParse(s: string): Record<string, any> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// ----------------------------------------------------------------------------
// Outbound: agent speaks first
// ----------------------------------------------------------------------------

const OUTBOUND_PROMPT = `You are an outbound voice agent powered by the AssemblyAI Voice Agent API. You're calling the user to introduce them to this technology and answer any questions.

You are making an OUTBOUND call, so YOU speak first. Greet the caller warmly and tell them:
- You're calling from AssemblyAI to share information about the Voice Agent API.
- It's a single WebSocket endpoint for real-time voice agents — speech in, speech out.
- It supports telephony via Twilio, browser apps, and direct WebSocket connections.

Be friendly and concise. Answer questions naturally. If they're not interested, thank them and end the call gracefully.`;

const OUTBOUND_GREETING =
  "Hi! This is the AssemblyAI Voice Agent API calling. Got a moment to chat?";

app.post("/outbound-twiml", (_req, res) => {
  const hostname = (process.env.PUBLIC_HOSTNAME || "").replace(/^https?:\/\//, "");
  res.type("text/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${hostname}/outbound-stream" />
  </Connect>
</Response>`,
  );
});

app.ws("/outbound-stream", (ws) => {
  const callId = newCallId();
  let streamSid = "";
  let aaiWs: WebSocket | null = null;
  let sessionReady = false;
  console.log(`\n[OUTBOUND ${callId}] === CALL STARTED ===`);

  ws.on("message", (data) => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      log(`OUT ${callId}`, "twilio.start");

      aaiWs = new WebSocket(AAI_AGENT_URL, {
        headers: { Authorization: `Bearer ${ASSEMBLYAI_API_KEY}` },
      });

      aaiWs.on("open", () => {
        log(`OUT ${callId}`, "aai.open");
        aaiWs!.send(
          JSON.stringify(
            buildSessionUpdate({
              systemPrompt: OUTBOUND_PROMPT,
              greeting: OUTBOUND_GREETING,
              voice: "winter",
              withTools: false,
            }),
          ),
        );
      });

      aaiWs.on("message", (chunk) => {
        let event: any;
        try {
          event = JSON.parse(chunk.toString());
        } catch {
          return;
        }
        if (event.type === undefined && event.code) event.type = "session.error";
        if (event.type !== "reply.audio") log(`OUT ${callId}`, event.type ?? "?");

        switch (event.type) {
          case "session.ready":
            sessionReady = true;
            // The greeting field is set in session.update, so the server will
            // start speaking as soon as session.ready fires — no `reply.create`
            // needed.
            break;
          case "reply.audio":
            if (event.data) {
              ws.send(
                JSON.stringify({
                  event: "media",
                  streamSid,
                  media: { payload: event.data },
                }),
              );
            }
            break;
          case "input.speech.started":
            ws.send(JSON.stringify({ event: "clear", streamSid }));
            break;
          case "transcript.agent":
            if (event.text) console.log(`[OUT ${callId}] Agent: "${event.text}"`);
            break;
          case "transcript.user":
            if (event.text) console.log(`[OUT ${callId}] Caller: "${event.text}"`);
            break;
          case "session.error":
          case "error":
            console.error(`[OUT ${callId}] ERROR ${event.code} ${event.message ?? ""}`);
            break;
        }
      });

      aaiWs.on("close", () => log(`OUT ${callId}`, "aai.close"));
    } else if (msg.event === "media" && msg.media?.track === "inbound") {
      if (aaiWs && sessionReady && aaiWs.readyState === WebSocket.OPEN) {
        aaiWs.send(JSON.stringify({ type: "input.audio", audio: msg.media.payload }));
      }
    } else if (msg.event === "stop") {
      log(`OUT ${callId}`, "twilio.stop");
      aaiWs?.close();
    }
  });

  ws.on("close", () => {
    log(`OUT ${callId}`, "twilio.close");
    aaiWs?.close();
  });
});

// ----------------------------------------------------------------------------
// Server
// ----------------------------------------------------------------------------

const port = process.env.PORT || 3000;

// Mask secrets so they're visible enough to verify without leaking the full value.
const mask = (value?: string) => {
  if (!value) return "(not set)";
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}…${value.slice(-4)} (${value.length} chars)`;
};

function printConfig() {
  const rows: [string, string][] = [
    ["ASSEMBLYAI_API_KEY", mask(process.env.ASSEMBLYAI_API_KEY)],
    ["AAI_AGENT_URL", AAI_AGENT_URL],
    ["ENABLE_TOOLS", ENABLE_TOOLS ? "enabled" : "disabled"],
    ["PUBLIC_HOSTNAME", process.env.PUBLIC_HOSTNAME || "(not set)"],
    ["PORT", String(port)],
    ["TWILIO_ACCOUNT_SID", process.env.TWILIO_ACCOUNT_SID || "(not set)"],
    ["TWILIO_AUTH_TOKEN", mask(process.env.TWILIO_AUTH_TOKEN)],
    ["TWILIO_PHONE_NUMBER", process.env.TWILIO_PHONE_NUMBER || "(not set)"],
    ["TARGET_PHONE_NUMBER", process.env.TARGET_PHONE_NUMBER || "(not set)"],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  console.log("Configuration:");
  for (const [key, value] of rows) {
    console.log(`  ${key.padEnd(width)}  ${value}`);
  }
}

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  printConfig();
});
