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
import {
  SYSTEM_PROMPT,
  DEFAULT_GREETING,
  OUTBOUND_PROMPT,
  OUTBOUND_GREETING,
  INBOUND_VOICE,
  OUTBOUND_VOICE,
  TOOLS,
  OUTBOUND_TOOLS,
  runTool,
} from "./bot";
import { TwilioMediaStreamWebsocket } from "./twilio";

const { app } = ExpressWs(express());
app.use(express.urlencoded({ extended: true })).use(express.json());

// ----------------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------------

const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY || "";
const AAI_AGENT_URL = process.env.AAI_AGENT_URL || "wss://agents.assemblyai.com/v1/realtime";
const ENABLE_TOOLS = process.env.ENABLE_TOOLS !== "false";
// Outbound only: wait this long after the call connects before the agent
// greets. During this window we stream silence (below) so the callee's audio
// path opens BEFORE the greeting plays — otherwise the opening words are
// clipped. Override with OUTBOUND_GREETING_DELAY_MS.
const OUTBOUND_GREETING_DELAY_MS = Number(process.env.OUTBOUND_GREETING_DELAY_MS) || 2000;

// One 20ms frame of G.711 μ-law silence (0xFF), base64-encoded. 8 kHz * 0.02s
// = 160 samples = 160 bytes. Streamed to Twilio to prime/keep-alive the audio
// path so leading audio isn't dropped.
const MULAW_SILENCE_FRAME = Buffer.alloc(160, 0xff).toString("base64");

// Outbound only: a burst of silence queued right BEFORE the greeting audio, so
// any residual clipping eats this padding instead of the agent's first words.
const OUTBOUND_GREETING_PAD_MS = Number(process.env.OUTBOUND_GREETING_PAD_MS) || 500;

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
  tools?: readonly unknown[];
}) {
  return {
    type: "session.update",
    session: {
      system_prompt: opts.systemPrompt,
      greeting: opts.greeting,
      // Twilio sends G.711 μ-law at 8 kHz — match it on input and output
      // so the Voice Agent API doesn't need to transcode.
      input: {
        type: "audio",
        format: { encoding: "audio/pcmu" },
        // Turn detection / barge-in. interrupt_response lets the caller cut
        // the agent off mid-sentence. We lower vad_threshold (more sensitive
        // to speech) and shorten the silence windows so interruptions and
        // end-of-turn are detected quickly on 8 kHz telephony audio.
        turn_detection: {
          interrupt_response: true,
          vad_threshold: 0.3,
          min_silence: 450,
          max_silence: 1500,
        },
      },
      output: {
        type: "audio",
        voice: opts.voice ?? INBOUND_VOICE,
        format: { encoding: "audio/pcmu" },
      },
      ...(opts.tools && opts.tools.length ? { tools: opts.tools } : {}),
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
    voice: INBOUND_VOICE,
    tools: ENABLE_TOOLS ? TOOLS : [],
  });
  aaiWs.send(JSON.stringify(sessionUpdate));
  log(callId, "aai.session.update sent");

  let sessionReady = false;
  let turnCount = 0;
  let turnActive = false;

  // Tool results are buffered and only sent when `reply.done` is the latest
  // event (the safe window per the tool-calling guidelines). `toolWindowOpen`
  // tracks that window so a tool that resolves *after* reply.done still flushes.
  let pendingToolResults: PendingToolResult[] = [];
  let toolWindowOpen = false;

  const sendToolResult = (p: PendingToolResult) => {
    aaiWs.send(
      JSON.stringify({ type: "tool.result", call_id: p.call_id, result: p.result, is_error: false }),
    );
    // end_call: once the result is acknowledged, queue a mark behind any
    // goodbye audio and hang up when Twilio echoes it back.
    if (p.name === "end_call") {
      if (tw.streamSid) {
        tw.send({ event: "mark", streamSid: tw.streamSid, mark: { name: "hangup" } });
      } else {
        hangup();
      }
    }
  };

  const flushToolResults = () => {
    const items = pendingToolResults;
    pendingToolResults = [];
    for (const p of items) sendToolResult(p);
  };

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
        toolWindowOpen = false; // a turn is in progress — not safe to send tool results
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
        // Raw voice activity — fires for back-channels ("uh-huh") too, so we
        // do NOT flush here. The agent only stops when the API semantically
        // confirms a real interruption (reply.done with status "interrupted").
        break;

      case "transcript.user":
        if (event.text) console.log(`[${callId}] User: "${event.text}"`);
        break;

      case "transcript.agent":
        if (event.text) console.log(`[${callId}] Agent: "${event.text}"`);
        break;

      case "tool.call":
        handleToolCall(callId, event)
          .then((pending) => {
            pendingToolResults.push(pending);
            // If the tool finished after reply.done already arrived, we're in
            // the safe window — flush now. Otherwise reply.done will flush.
            if (toolWindowOpen) flushToolResults();
          })
          .catch((e) => console.error(`[${callId}] tool error`, e));
        break;

      case "reply.done":
        turnActive = false;
        if (event.status === "interrupted") {
          // Barge-in: flush Twilio's buffered audio so the agent goes quiet,
          // and discard any pending tool results — a fresh turn has begun.
          if (tw.streamSid) tw.send({ event: "clear", streamSid: tw.streamSid });
          pendingToolResults = [];
          toolWindowOpen = false;
        } else {
          // Safe window: reply.done is now the latest event, so deliver any
          // tool results we buffered during the transition phrase.
          toolWindowOpen = true;
          flushToolResults();
        }
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

export type PendingToolResult = { call_id: string; name: string; result: string };

// Run the requested tool and return the result to be sent back. We do NOT send
// it here: per the Voice Agent API tool-calling guidelines, `tool.result` must
// be delivered only once `reply.done` is the latest event (the agent has
// finished its transition phrase). The caller buffers this and flushes it then.
async function handleToolCall(callId: string, event: any): Promise<PendingToolResult> {
  const name: string = event.name ?? "";
  // The API sends parameters as `arguments`; accept `args` too for safety.
  const rawArgs = event.arguments ?? event.args;
  const args: Record<string, any> =
    typeof rawArgs === "string"
      ? safeParse(rawArgs)
      : rawArgs && typeof rawArgs === "object"
      ? rawArgs
      : {};

  console.log(`[${callId}] tool.call ${name}(${JSON.stringify(args)})`);
  const result = await runTool(name, args);
  console.log(`[${callId}] tool.result ${result}`);

  return { call_id: event.call_id, name, result };
}

function safeParse(s: string): Record<string, any> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// ----------------------------------------------------------------------------
// Outbound: agent speaks first. The persona lives in bot.ts
// (OUTBOUND_PROMPT / OUTBOUND_GREETING).
// ----------------------------------------------------------------------------

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

  // Tool-result buffering + hangup (same approach as the inbound flow).
  let pendingToolResults: PendingToolResult[] = [];
  let toolWindowOpen = false;

  // Stream silence to Twilio until the agent's real audio starts, so the
  // callee's audio path is open before the greeting plays (no clipped words).
  let silenceTimer: ReturnType<typeof setInterval> | null = null;
  const startSilence = () => {
    if (silenceTimer) return;
    silenceTimer = setInterval(() => {
      if (ws.readyState === ws.OPEN && streamSid) {
        ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: MULAW_SILENCE_FRAME } }));
      }
    }, 20);
  };
  const stopSilence = () => {
    if (silenceTimer) {
      clearInterval(silenceTimer);
      silenceTimer = null;
    }
  };

  // Queue a fixed burst of silence frames before the greeting (a playback
  // cushion). Sent once, right before the agent's first audio.
  let greetingPadded = false;
  const sendGreetingPad = () => {
    if (greetingPadded) return;
    greetingPadded = true;
    const frames = Math.round(OUTBOUND_GREETING_PAD_MS / 20);
    for (let i = 0; i < frames; i++) {
      if (ws.readyState === ws.OPEN && streamSid) {
        ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: MULAW_SILENCE_FRAME } }));
      }
    }
  };

  const hangup = () => {
    log(`OUT ${callId}`, "hangup");
    stopSilence();
    if (aaiWs && aaiWs.readyState === WebSocket.OPEN) aaiWs.close();
    if (ws.readyState === ws.OPEN) ws.close();
  };

  const sendToolResult = (p: PendingToolResult) => {
    if (aaiWs && aaiWs.readyState === WebSocket.OPEN) {
      aaiWs.send(
        JSON.stringify({ type: "tool.result", call_id: p.call_id, result: p.result, is_error: false }),
      );
    }
    // end_call: drain any goodbye audio (mark echoes back), then hang up.
    if (p.name === "end_call") {
      if (streamSid) {
        ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "hangup" } }));
      } else {
        hangup();
      }
    }
  };

  const flushToolResults = () => {
    const items = pendingToolResults;
    pendingToolResults = [];
    for (const p of items) sendToolResult(p);
  };

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

      // Start priming the audio path with silence immediately, before the
      // greeting. Stopped once the agent's first real audio arrives.
      startSilence();

      aaiWs = new WebSocket(AAI_AGENT_URL, {
        headers: { Authorization: `Bearer ${ASSEMBLYAI_API_KEY}` },
      });

      aaiWs.on("open", () => {
        log(`OUT ${callId}`, "aai.open");
        // Hold the session.update briefly. It triggers session.ready and the
        // auto-greeting, so delaying it lets the callee's audio path settle —
        // otherwise the opening words get clipped on outbound calls.
        setTimeout(() => {
          if (!aaiWs || aaiWs.readyState !== WebSocket.OPEN) return;
          aaiWs.send(
            JSON.stringify(
              buildSessionUpdate({
                systemPrompt: OUTBOUND_PROMPT,
                greeting: OUTBOUND_GREETING,
                voice: OUTBOUND_VOICE,
                tools: ENABLE_TOOLS ? OUTBOUND_TOOLS : [],
              }),
            ),
          );
          log(`OUT ${callId}`, `aai.session.update sent (after ${OUTBOUND_GREETING_DELAY_MS}ms)`);
        }, OUTBOUND_GREETING_DELAY_MS);
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
          case "reply.started":
            toolWindowOpen = false; // a turn is active — not safe to send tool results
            break;
          case "reply.audio":
            if (event.data) {
              stopSilence(); // real audio is starting — stop priming
              sendGreetingPad(); // one-time silence cushion before first words
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
            // Raw VAD (fires on back-channels too) — don't flush here; wait
            // for the semantic interruption signal on reply.done below.
            break;
          case "tool.call":
            handleToolCall(`OUT ${callId}`, event)
              .then((pending) => {
                pendingToolResults.push(pending);
                if (toolWindowOpen) flushToolResults();
              })
              .catch((e) => console.error(`[OUT ${callId}] tool error`, e));
            break;
          case "reply.done":
            if (event.status === "interrupted") {
              // Semantic barge-in: flush Twilio's buffered audio and drop any
              // pending tool results — a fresh turn has begun.
              ws.send(JSON.stringify({ event: "clear", streamSid }));
              pendingToolResults = [];
              toolWindowOpen = false;
            } else {
              // Safe window: deliver buffered tool results now.
              toolWindowOpen = true;
              flushToolResults();
            }
            log(`OUT ${callId}`, `reply.done status=${event.status ?? "completed"}`);
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
    } else if (msg.event === "mark") {
      // Twilio finished playing audio up to this mark. If it's our hangup
      // mark, the goodbye has played — end the call now.
      if (msg.mark?.name === "hangup") hangup();
    } else if (msg.event === "stop") {
      log(`OUT ${callId}`, "twilio.stop");
      stopSilence();
      aaiWs?.close();
    }
  });

  ws.on("close", () => {
    log(`OUT ${callId}`, "twilio.close");
    stopSilence();
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
    ["INBOUND_VOICE", INBOUND_VOICE],
    ["OUTBOUND_VOICE", OUTBOUND_VOICE],
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
