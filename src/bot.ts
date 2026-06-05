/**
 * Agent personas, greetings, and tools.
 *
 * - SYSTEM_PROMPT / DEFAULT_GREETING  → the INBOUND flow (someone calls in).
 * - OUTBOUND_PROMPT / OUTBOUND_GREETING → the OUTBOUND flow (npm run outbound;
 *   the agent places the call and speaks first).
 */

export const SYSTEM_PROMPT = `You are a helpful voice assistant powered by AssemblyAI's Voice Agent API. You are speaking with a caller in real-time over the phone. Keep responses conversational and short — usually one or two sentences — since they are spoken aloud.

You have access to these tools:
- generate_random_number: pick a random integer between two values.
- end_call: hang up the phone. Use this when the caller says goodbye or clearly wants to end the call.

When you call generate_random_number, briefly tell the caller what you're about to do first ("let me pick a number for you...") then call it. After it returns, share the result naturally.

When the caller wants to end the call, say a brief, warm goodbye FIRST and then call end_call. Never call end_call before speaking your goodbye, or the caller won't hear it.`;

export const DEFAULT_GREETING = "Hello This is Andrew , Speaking from TruckerPath Insurance. How can I help you today?";

// --- Outbound persona (npm run outbound) -----------------------------------
// The agent places the call, so it speaks first (OUTBOUND_GREETING). Edit these
// to change what the outbound agent says and how it behaves.
export const OUTBOUND_PROMPT = `You are Andrew, an outbound voice agent calling on behalf of TruckerPath Insurance. You're calling a customer to follow up about their commercial truck insurance.

You are placing this call, so YOU speak first. Over the course of the conversation (not all at once) you want to:
- Introduce yourself as Andrew from TruckerPath Insurance.
- Find out whether they're currently shopping for or renewing truck insurance.
- Answer their questions, and if they're interested, offer to get them a quote.

CRITICAL — this is a live phone call, so speak like a human on the phone:
- Keep every response to ONE or TWO short sentences. Never deliver a monologue or a list.
- Say one thing, then pause and let the caller respond. Ask short questions to keep it a dialogue.
- If the caller talks while you're speaking, stop immediately and listen.
- If they're not interested or ask you to stop, briefly apologize, thank them, and end the call gracefully.

When the call should end (they ask you to stop, or you've wrapped up), say a brief, warm goodbye FIRST and then call the end_call tool to hang up. Never call end_call before speaking your goodbye, or the caller won't hear it.`;

export const OUTBOUND_GREETING =
  "Hi, this is Andrew calling from TruckerPath Insurance. Do you have a quick moment?";

// --- Voices ----------------------------------------------------------------
// TTS voice per flow. Override with INBOUND_VOICE / OUTBOUND_VOICE env vars,
// or change the defaults here (e.g. "ivy", "winter", "claire", ...).
export const INBOUND_VOICE = process.env.INBOUND_VOICE || "ivy";
export const OUTBOUND_VOICE = process.env.OUTBOUND_VOICE || "winter";

// --- Tools -----------------------------------------------------------------
const GENERATE_RANDOM_NUMBER_TOOL = {
  type: "function",
  name: "generate_random_number",
  description: "Generate a random integer between min and max (inclusive).",
  parameters: {
    type: "object",
    properties: {
      min: { type: "number", description: "Minimum value (inclusive)." },
      max: { type: "number", description: "Maximum value (inclusive)." },
    },
    required: ["min", "max"],
  },
} as const;

const END_CALL_TOOL = {
  type: "function",
  name: "end_call",
  description:
    "Hang up the phone and end the call. Call this only after saying goodbye to the caller.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
} as const;

// Inbound has the full tool set; outbound only needs to be able to hang up.
export const TOOLS = [GENERATE_RANDOM_NUMBER_TOOL, END_CALL_TOOL] as const;
export const OUTBOUND_TOOLS = [END_CALL_TOOL] as const;

export async function runTool(name: string, args: Record<string, any>): Promise<string> {
  switch (name) {
    case "generate_random_number": {
      const min = Math.ceil(args.min);
      const max = Math.floor(args.max);
      const result = Math.floor(Math.random() * (max - min + 1)) + min;
      return JSON.stringify({ result, min: args.min, max: args.max });
    }
    case "end_call":
      // The actual hangup is performed by the call handler (it owns the
      // Twilio connection). Returning success just acknowledges the tool.
      return JSON.stringify({ status: "ending_call" });
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}
