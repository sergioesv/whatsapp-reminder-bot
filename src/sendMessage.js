const twilio = require("twilio");
require("dotenv").config();

/**
 * Sends an outbound WhatsApp message via Twilio.
 * @param {string} phone - Recipient phone number with country code (e.g. 573001234567)
 * @param {string} message - Plain text message to send
 */
async function sendWhatsAppMessage(phone, message) {
  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  // Normalize phone: ensure whatsapp: prefix
  const to = phone.startsWith("whatsapp:") ? phone : `whatsapp:+${phone}`;
  const from = process.env.TWILIO_WHATSAPP_NUMBER.startsWith("whatsapp:")
    ? process.env.TWILIO_WHATSAPP_NUMBER
    : `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;

  await client.messages.create({
    from,
    to,
    body: message,
  });
}

module.exports = sendWhatsAppMessage;
