const twilio = require("twilio");
require("dotenv").config();

/**
 * Sends an outbound WhatsApp message via Twilio.
 * @param {string} phone - Recipient phone number with country code (e.g. 573001234567)
 * @param {string} message - Plain text body (leyenda / caption)
 * @param {{ mediaUrl?: string|string[] }} [options] - Etapa 5: una o varias URLs HTTPS públicas (p. ej. signed URL de Supabase)
 */
async function sendWhatsAppMessage(phone, message, options = {}) {
  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  // Normalize phone: ensure whatsapp: prefix
  const to = phone.startsWith("whatsapp:") ? phone : `whatsapp:+${phone}`;
  const from = process.env.TWILIO_WHATSAPP_NUMBER.startsWith("whatsapp:")
    ? process.env.TWILIO_WHATSAPP_NUMBER
    : `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;

  const payload = {
    from,
    to,
    body: message ?? "",
  };

  if (options.mediaUrl) {
    payload.mediaUrl = Array.isArray(options.mediaUrl)
      ? options.mediaUrl
      : [options.mediaUrl];
  }

  await client.messages.create(payload);
}

module.exports = sendWhatsAppMessage;
