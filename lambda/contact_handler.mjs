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

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export const handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
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
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Invalid JSON" }),
    };
  }

  // Debug logging for CloudWatch
  console.log("Event:", JSON.stringify(event));
  console.log("Parsed body:", JSON.stringify(body));

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

    const subject = `HSS Job Application: ${position} — ${name}`;
    const htmlBody = `
      <h2>New Job Application</h2>
      <table style="border-collapse:collapse;">
        <tr><td style="padding:8px;font-weight:bold;">Position:</td><td style="padding:8px;">${position}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;">Name:</td><td style="padding:8px;">${name}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;">Email:</td><td style="padding:8px;"><a href="mailto:${email}">${email}</a></td></tr>
        <tr><td style="padding:8px;font-weight:bold;">Phone:</td><td style="padding:8px;">${phone}</td></tr>
      </table>
      <h3>Cover Letter</h3>
      <p>${coverLetter}</p>
      <hr>
      <p style="color:#888;font-size:12px;">Submitted via HSS Careers page.</p>
    `;

    // If resume attached, send raw email with attachment
    if (resumeB64) {
      try {
        const boundary = `----=_Part_${Date.now()}`;
        const resumeBuffer = Buffer.from(resumeB64, "base64");

        const rawEmail = [
          `From: ${FROM_EMAIL}`,
          `To: ${TO_EMAIL}`,
          `Subject: ${subject}`,
          `MIME-Version: 1.0`,
          `Content-Type: multipart/mixed; boundary="${boundary}"`,
          ``,
          `--${boundary}`,
          `Content-Type: text/html; charset=UTF-8`,
          `Content-Transfer-Encoding: 7bit`,
          ``,
          htmlBody,
          `--${boundary}`,
          `Content-Type: application/octet-stream; name="${resumeFilename}"`,
          `Content-Transfer-Encoding: base64`,
          `Content-Disposition: attachment; filename="${resumeFilename}"`,
          ``,
          resumeBuffer.toString("base64"),
          `--${boundary}--`,
        ].join("\r\n");

        await ses.send(
          new SendRawEmailCommand({
            Source: FROM_EMAIL,
            Destinations: [TO_EMAIL],
            RawMessage: { Data: new TextEncoder().encode(rawEmail) },
          })
        );

        return {
          statusCode: 200,
          headers: CORS_HEADERS,
          body: JSON.stringify({ message: "Application with resume sent successfully" }),
        };
      } catch (err) {
        console.log("SES Error:", err);
        return {
          statusCode: 500,
          headers: CORS_HEADERS,
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
        headers: CORS_HEADERS,
        body: JSON.stringify({ message: "Application sent successfully" }),
      };
    } catch (err) {
      console.log("SES Error:", err);
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Failed to send application" }),
      };
    }
  }

  // ── CONTACT FORM ──
  const organization = body.organization || "Not provided";
  const subjectLine = body.subject || "General";
  const message = body.message || "No message";

  const subject = `HSS Contact: ${subjectLine} — ${name}`;
  const htmlBody = `
    <h2>New Contact Form Submission</h2>
    <table style="border-collapse:collapse;">
      <tr><td style="padding:8px;font-weight:bold;">Name:</td><td style="padding:8px;">${name}</td></tr>
      <tr><td style="padding:8px;font-weight:bold;">Email:</td><td style="padding:8px;"><a href="mailto:${email}">${email}</a></td></tr>
      <tr><td style="padding:8px;font-weight:bold;">Organization:</td><td style="padding:8px;">${organization}</td></tr>
      <tr><td style="padding:8px;font-weight:bold;">Subject:</td><td style="padding:8px;">${subjectLine}</td></tr>
    </table>
    <h3>Message</h3>
    <p>${message}</p>
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
      headers: CORS_HEADERS,
      body: JSON.stringify({ message: "Email sent successfully" }),
    };
  } catch (err) {
    console.log("SES Error:", err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Failed to send email" }),
    };
  }
};
