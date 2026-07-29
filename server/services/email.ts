// Sends email via a Google Apps Script Web App instead of SMTP or Resend.
// The hospital firewall blocks outbound SMTP ports (465/587) and this
// avoids depending on a paid API (Resend) — it uses the free quota of a
// personal/shared Gmail account through Apps Script's MailApp service.

interface SendMailArgs {
  to: string; // comma-separated list, same shape as before
  subject: string;
  html: string;
}

interface SendMailResult {
  messageId: string;
}

const GAS_EMAIL_URL = process.env.GAS_EMAIL_URL;

/**
 * Drop-in replacement for the old `transporter.sendMail(...)` call.
 * POSTs { to, subject, html } to the deployed Apps Script Web App,
 * which sends the mail via MailApp.sendEmail(...).
 */
export async function sendMail(args: SendMailArgs): Promise<SendMailResult> {
  if (!GAS_EMAIL_URL) {
    throw new Error("GAS_EMAIL_URL is not set");
  }

  const res = await fetch(GAS_EMAIL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to: args.to,
      subject: args.subject,
      html: args.html,
    }),
  });

  let result: { status?: string; message?: string } | null = null;
  try {
    result = await res.json();
  } catch {
    // GAS sometimes returns non-JSON on redirect/auth errors — surface raw text below
  }

  if (!res.ok || !result || result.status !== "success") {
    const detail = result?.message || `HTTP ${res.status}`;
    throw new Error(`Failed to send email via GAS: ${detail}`);
  }

  return { messageId: "" };
}

// Alias — some route files (e.g. routes/email.ts) import this as `sendEmail`
export { sendMail as sendEmail };

/**
 * Escape HTML special characters to prevent XSS in email templates.
 */
export function escapeHtml(str: string): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Basic email format validation
 */
export function isValidEmail(email: string): boolean {
  if (!email) return false;
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(String(email).toLowerCase());
}
