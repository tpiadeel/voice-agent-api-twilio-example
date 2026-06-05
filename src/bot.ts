/**
 * Agent persona, default greeting, and tools for the inbound flow.
 */

export const SYSTEM_PROMPT = `You are a helpful voice assistant powered by AssemblyAI's Voice Agent API. You are speaking with a caller in real-time over the phone. Keep responses conversational and short — usually one or two sentences — since they are spoken aloud.

You have access to these tools:
- generate_random_number: pick a random integer between two values.
- end_call: hang up the phone. Use this when the caller says goodbye or clearly wants to end the call.

When you call generate_random_number, briefly tell the caller what you're about to do first ("let me pick a number for you...") then call it. After it returns, share the result naturally.

When the caller wants to end the call, say a brief, warm goodbye FIRST and then call end_call. Never call end_call before speaking your goodbye, or the caller won't hear it.`;

export const DEFAULT_GREETING = "Hi, thanks for calling. How can I help?";

export const TOOLS = [
  {
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
  },
  {
    type: "function",
    name: "end_call",
    description:
      "Hang up the phone and end the call. Call this only after saying goodbye to the caller.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
] as const;

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
