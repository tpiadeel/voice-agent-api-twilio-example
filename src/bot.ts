/**
 * Agent persona, default greeting, and tools for the inbound flow.
 */

export const SYSTEM_PROMPT = `You are a helpful voice assistant powered by AssemblyAI's Voice Agent API. You are speaking with a caller in real-time over the phone. Keep responses conversational and short — usually one or two sentences — since they are spoken aloud.

You have access to one tool:
- generate_random_number: pick a random integer between two values.

When you call a tool, briefly tell the caller what you're about to do first ("let me pick a number for you...") then call it. After it returns, share the result naturally.`;

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
] as const;

export async function runTool(name: string, args: Record<string, any>): Promise<string> {
  switch (name) {
    case "generate_random_number": {
      const min = Math.ceil(args.min);
      const max = Math.floor(args.max);
      const result = Math.floor(Math.random() * (max - min + 1)) + min;
      return JSON.stringify({ result, min: args.min, max: args.max });
    }
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}
