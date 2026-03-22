/**
 * HSS Contact Form & Job Application — Lambda Handler (Node.js)
 * Sends emails via AWS SES for contact form submissions and job applications.
 */

import { SESClient, SendEmailCommand, SendRawEmailCommand } from "@aws-sdk/client-ses";

// ─── CONFIG ───
const TO_EMAIL = "heinrichssoftwaresolutions@gmail.com";
const FROM_EMAIL = "contact@heinrichstech.com"; // SES-verified domain
const REGION = "us-east-2";

const ses = new SESClient({ region: REGION });

const ALLOWED_ORIGINS = [
  "https://heinrichstech.com",
  "https://www.heinrichstech.com",
];

function getCorsHeaders(origin) {
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Credentials": "true",
  };
}

// ─── HTML SANITIZER (prevent XSS in email bodies) ───
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── INPUT VALIDATION ───
function validateInput(body) {
  const errors = [];
  if (body.name && body.name.length > 200) errors.push('Name too long (max 200 chars)');
  if (body.email && body.email.length > 320) errors.push('Email too long');
  if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) errors.push('Invalid email format');
  if (body.message && body.message.length > 10000) errors.push('Message too long (max 10,000 chars)');
  if (body.coverLetter && body.coverLetter.length > 10000) errors.push('Cover letter too long');
  if (body.organization && body.organization.length > 200) errors.push('Organization name too long');
  if (body.position && body.position.length > 200) errors.push('Position too long');
  if (body.phone && body.phone.length > 30) errors.push('Phone number too long');
  // Limit base64 attachments to ~7MB (accounts for base64 overhead of 5MB file)
  if (body.resumeBase64 && body.resumeBase64.length > 7 * 1024 * 1024) errors.push('Resume file too large (max 5MB)');
  if (body.coverLetterBase64 && body.coverLetterBase64.length > 7 * 1024 * 1024) errors.push('Cover letter file too large (max 5MB)');
  return errors;
}

export const handler = async (event) => {
  // Determine origin for CORS headers (per-request, not module-level)
  const origin = event.headers?.origin || event.headers?.Origin || "";
  const requestOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: getCorsHeaders(requestOrigin), body: "" };
  }

  // Parse request body — supports both proxy and non-proxy integration
  let body;
  try {
    const rawBody = event.body;
    if (typeof rawBody === "string") {
      body = JSON.parse(rawBody);
    } else if (typeof rawBody === "object" && rawBody !== null) {
      body = rawBody;
    } else {
      // Non-proxy mode: data might be directly in event
      const exclude = new Set([
        "httpMethod", "headers", "queryStringParameters",
        "pathParameters", "stageVariables", "requestContext",
        "resource", "path", "isBase64Encoded",
        "multiValueHeaders", "multiValueQueryStringParameters",
      ]);
      body = {};
      for (const [key, value] of Object.entries(event)) {
        if (!exclude.has(key)) body[key] = value;
      }
    }
  } catch {
    return {
      statusCode: 400,
      headers: getCorsHeaders(requestOrigin),
      body: JSON.stringify({ error: "Invalid JSON" }),
    };
  }

  // Validate input
  const validationErrors = validateInput(body);
  if (validationErrors.length > 0) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(requestOrigin),
      body: JSON.stringify({ error: validationErrors[0] }),
    };
  }

  // Minimal logging (no PII/attachments)
  console.log(`Contact form: type=${body.formType || 'contact'} subject=${body.subject || 'N/A'}`);

  const formType = body.formType || "contact";
  const name = body.name || "Unknown";
  const email = body.email || "No email provided";

  // ── JOB APPLICATION ──
  if (formType === "application") {
    const position = body.position || "Not specified";
    const phone = body.phone || "Not provided";
    const coverLetter = body.coverLetter || "None";
    const resumeB64 = body.resumeBase64 || null;
    const resumeFilename = body.resumeFilename || "resume.pdf";
    const coverLetterB64 = body.coverLetterBase64 || null;
    const coverLetterFilename = body.coverLetterFilename || "cover_letter.pdf";
    const organization = body.organization || "";

    const subject = `HSS Job Application: ${escapeHtml(position)} — ${escapeHtml(name)}`;
    const htmlBody = `
      <h2>New Job Application</h2>
      <table style="border-collapse:collapse;">
        <tr><td style="padding:8px;font-weight:bold;">Position:</td><td style="padding:8px;">${escapeHtml(position)}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;">Name:</td><td style="padding:8px;">${escapeHtml(name)}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;">Email:</td><td style="padding:8px;"><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></td></tr>
        <tr><td style="padding:8px;font-weight:bold;">Phone:</td><td style="padding:8px;">${escapeHtml(phone)}</td></tr>
        ${organization ? `<tr><td style="padding:8px;font-weight:bold;">Organization:</td><td style="padding:8px;">${escapeHtml(organization)}</td></tr>` : ''}
      </table>
      <h3>Cover Letter / Message</h3>
      <p>${escapeHtml(coverLetter).replace(/\n/g, '<br>')}</p>
      <hr>
      <p style="color:#888;font-size:12px;">Submitted via HSS Contact Form (Career Inquiry).</p>
    `;

    // If any attachments, send raw email with attachments
    if (resumeB64 || coverLetterB64) {
      try {
        const boundary = `----=_Part_${Date.now()}`;
        const parts = [
          `From: ${FROM_EMAIL}`,
          `To: ${TO_EMAIL}`,
          `Reply-To: ${email}`,
          `Subject: ${subject}`,
          `MIME-Version: 1.0`,
          `Content-Type: multipart/mixed; boundary="${boundary}"`,
          ``,
          `--${boundary}`,
          `Content-Type: text/html; charset=UTF-8`,
          `Content-Transfer-Encoding: 7bit`,
          ``,
          htmlBody,
        ];

        // Add resume attachment
        if (resumeB64) {
          parts.push(
            `--${boundary}`,
            `Content-Type: application/octet-stream; name="${resumeFilename}"`,
            `Content-Transfer-Encoding: base64`,
            `Content-Disposition: attachment; filename="${resumeFilename}"`,
            ``,
            resumeB64
          );
        }

        // Add cover letter file attachment (optional)
        if (coverLetterB64) {
          parts.push(
            `--${boundary}`,
            `Content-Type: application/octet-stream; name="${coverLetterFilename}"`,
            `Content-Transfer-Encoding: base64`,
            `Content-Disposition: attachment; filename="${coverLetterFilename}"`,
            ``,
            coverLetterB64
          );
        }

        parts.push(`--${boundary}--`);
        const rawEmail = parts.join("\r\n");

        await ses.send(
          new SendRawEmailCommand({
            Source: FROM_EMAIL,
            Destinations: [TO_EMAIL],
            RawMessage: { Data: new TextEncoder().encode(rawEmail) },
          })
        );

        return {
          statusCode: 200,
          headers: getCorsHeaders(requestOrigin),
          body: JSON.stringify({ message: "Application sent successfully" }),
        };
      } catch (err) {
        console.error("SES send error (application w/attachments)");
        return {
          statusCode: 500,
          headers: getCorsHeaders(requestOrigin),
          body: JSON.stringify({ error: "Failed to send application" }),
        };
      }
    }

    // Application without resume — send regular email
    try {
      await ses.send(
        new SendEmailCommand({
          Source: FROM_EMAIL,
          Destination: { ToAddresses: [TO_EMAIL] },
          Message: {
            Subject: { Data: subject, Charset: "UTF-8" },
            Body: { Html: { Data: htmlBody, Charset: "UTF-8" } },
          },
        })
      );
      return {
        statusCode: 200,
        headers: getCorsHeaders(requestOrigin),
        body: JSON.stringify({ message: "Application sent successfully" }),
      };
    } catch (err) {
      console.error("SES send error (application)");
      return {
        statusCode: 500,
        headers: getCorsHeaders(requestOrigin),
        body: JSON.stringify({ error: "Failed to send application" }),
      };
    }
  }

  // ── CONTACT FORM ──
  const organization = body.organization || "Not provided";
  const subjectLine = body.subject || "General";
  const message = body.message || "No message";

  const subject = `HSS Contact: ${escapeHtml(subjectLine)} — ${escapeHtml(name)}`;
  const htmlBody = `
    <h2>New Contact Form Submission</h2>
    <table style="border-collapse:collapse;">
      <tr><td style="padding:8px;font-weight:bold;">Name:</td><td style="padding:8px;">${escapeHtml(name)}</td></tr>
      <tr><td style="padding:8px;font-weight:bold;">Email:</td><td style="padding:8px;"><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></td></tr>
      <tr><td style="padding:8px;font-weight:bold;">Organization:</td><td style="padding:8px;">${escapeHtml(organization)}</td></tr>
      <tr><td style="padding:8px;font-weight:bold;">Subject:</td><td style="padding:8px;">${escapeHtml(subjectLine)}</td></tr>
    </table>
    <h3>Message</h3>
    <p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>
    <hr>
    <p style="color:#888;font-size:12px;">Submitted via HSS Contact page.</p>
  `;

  try {
    await ses.send(
      new SendEmailCommand({
        Source: FROM_EMAIL,
        Destination: { ToAddresses: [TO_EMAIL] },
        Message: {
          Subject: { Data: subject, Charset: "UTF-8" },
          Body: { Html: { Data: htmlBody, Charset: "UTF-8" } },
        },
      })
    );
    return {
      statusCode: 200,
      headers: getCorsHeaders(requestOrigin),
      body: JSON.stringify({ message: "Email sent successfully" }),
    };
  } catch (err) {
    console.error("SES send error (contact)");
    return {
      statusCode: 500,
      headers: getCorsHeaders(requestOrigin),
      body: JSON.stringify({ error: "Failed to send email" }),
    };
  }
};
