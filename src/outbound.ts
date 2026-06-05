/**
 * Place an outbound call from your Twilio number to TARGET_PHONE_NUMBER.
 * Twilio calls /outbound-twiml on this server, which connects the call to
 * /outbound-stream. The agent speaks first.
 *
 * Usage:
 *   npm run outbound
 *
 * Required env vars (in .env):
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_PHONE_NUMBER  — your Twilio number (E.164, e.g. +14155550100)
 *   TARGET_PHONE_NUMBER  — the number to call
 *   PUBLIC_HOSTNAME      — public URL of this server (https://abc.ngrok.app)
 *
 * The main server (npm run dev) must be running.
 */

import "dotenv-flow/config";
import Twilio from "twilio";

const {
  TWILIO_ACCOUNT_SID = "",
  TWILIO_AUTH_TOKEN = "",
  TWILIO_PHONE_NUMBER = "",
  TARGET_PHONE_NUMBER = "",
  PUBLIC_HOSTNAME = "",
} = process.env;

for (const [name, value] of [
  ["TWILIO_ACCOUNT_SID", TWILIO_ACCOUNT_SID],
  ["TWILIO_AUTH_TOKEN", TWILIO_AUTH_TOKEN],
  ["TWILIO_PHONE_NUMBER", TWILIO_PHONE_NUMBER],
  ["TARGET_PHONE_NUMBER", TARGET_PHONE_NUMBER],
  ["PUBLIC_HOSTNAME", PUBLIC_HOSTNAME],
] as const) {
  if (!value) {
    console.error(`Missing env var: ${name}`);
    process.exit(1);
  }
}

const twilio = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

(async () => {
  const url = `${PUBLIC_HOSTNAME.replace(/\/$/, "")}/outbound-twiml`;
  console.log(`Calling ${TARGET_PHONE_NUMBER} from ${TWILIO_PHONE_NUMBER}`);
  console.log(`TwiML URL: ${url}`);

  try {
    const call = await twilio.calls.create({
      to: TARGET_PHONE_NUMBER,
      from: TWILIO_PHONE_NUMBER,
      url,
    });
    console.log(`Call SID: ${call.sid}`);
    console.log("Watch the main server logs for progress.");
  } catch (e: any) {
    console.error("Failed:", e.message);
    process.exit(1);
  }
})();
