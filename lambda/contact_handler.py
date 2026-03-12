import json
import boto3
import base64
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.application import MIMEApplication
from botocore.exceptions import ClientError

# ─── CONFIG ───
TO_EMAIL = "heinrichssoftwaresolutions@gmail.com"
FROM_EMAIL = "contact@heinrichstech.com"  # SES-verified domain
REGION = "us-east-2"

ses = boto3.client("ses", region_name=REGION)


def lambda_handler(event, context):
    # Handle CORS preflight
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
    }

    if event.get("httpMethod") == "OPTIONS":
        return {"statusCode": 200, "headers": headers, "body": ""}

    # Support both Lambda proxy integration (body is JSON string)
    # and non-proxy integration (body is already a dict or data is in event directly)
    try:
        raw_body = event.get("body", None)
        if isinstance(raw_body, str):
            body = json.loads(raw_body)
        elif isinstance(raw_body, dict):
            body = raw_body
        else:
            # Non-proxy mode: data might be directly in event
            body = {k: v for k, v in event.items()
                    if k not in ("httpMethod", "headers", "queryStringParameters",
                                 "pathParameters", "stageVariables", "requestContext",
                                 "resource", "path", "isBase64Encoded",
                                 "multiValueHeaders", "multiValueQueryStringParameters")}
    except json.JSONDecodeError:
        return {
            "statusCode": 400,
            "headers": headers,
            "body": json.dumps({"error": "Invalid JSON"}),
        }

    # Debug: log what we received so we can check CloudWatch
    print(f"Event: {json.dumps(event, default=str)}")
    print(f"Parsed body: {json.dumps(body, default=str)}")

    form_type = body.get("formType", "contact")
    name = body.get("name", "Unknown")
    email = body.get("email", "No email provided")

    if form_type == "application":
        position = body.get("position", "Not specified")
        phone = body.get("phone", "Not provided")
        cover_letter = body.get("coverLetter", "None")
        resume_b64 = body.get("resumeBase64", None)
        resume_filename = body.get("resumeFilename", "resume.pdf")
        resume_content_type = body.get("resumeContentType", "application/pdf")

        subject = f"HSS Job Application: {position} — {name}"
        html_body = f"""
        <h2>New Job Application</h2>
        <table style="border-collapse:collapse;">
            <tr><td style="padding:8px;font-weight:bold;">Position:</td><td style="padding:8px;">{position}</td></tr>
            <tr><td style="padding:8px;font-weight:bold;">Name:</td><td style="padding:8px;">{name}</td></tr>
            <tr><td style="padding:8px;font-weight:bold;">Email:</td><td style="padding:8px;"><a href="mailto:{email}">{email}</a></td></tr>
            <tr><td style="padding:8px;font-weight:bold;">Phone:</td><td style="padding:8px;">{phone}</td></tr>
        </table>
        <h3>Cover Letter</h3>
        <p>{cover_letter}</p>
        <hr>
        <p style="color:#888;font-size:12px;">Submitted via HSS Careers page.</p>
        """

        # If resume attached, send as raw email with attachment
        if resume_b64:
            try:
                msg = MIMEMultipart("mixed")
                msg["Subject"] = subject
                msg["From"] = FROM_EMAIL
                msg["To"] = TO_EMAIL

                # HTML body
                body_part = MIMEText(html_body, "html", "utf-8")
                msg.attach(body_part)

                # Resume attachment
                resume_bytes = base64.b64decode(resume_b64)
                att = MIMEApplication(resume_bytes)
                att.add_header("Content-Disposition", "attachment", filename=resume_filename)
                msg.attach(att)

                ses.send_raw_email(
                    Source=FROM_EMAIL,
                    Destinations=[TO_EMAIL],
                    RawMessage={"Data": msg.as_string()},
                )
                return {
                    "statusCode": 200,
                    "headers": headers,
                    "body": json.dumps({"message": "Application with resume sent successfully"}),
                }
            except ClientError as e:
                print(f"SES Error: {e}")
                return {
                    "statusCode": 500,
                    "headers": headers,
                    "body": json.dumps({"error": "Failed to send application"}),
                }
    else:
        organization = body.get("organization", "Not provided")
        subject_line = body.get("subject", "General")
        message = body.get("message", "No message")

        subject = f"HSS Contact: {subject_line} — {name}"
        html_body = f"""
        <h2>New Contact Form Submission</h2>
        <table style="border-collapse:collapse;">
            <tr><td style="padding:8px;font-weight:bold;">Name:</td><td style="padding:8px;">{name}</td></tr>
            <tr><td style="padding:8px;font-weight:bold;">Email:</td><td style="padding:8px;"><a href="mailto:{email}">{email}</a></td></tr>
            <tr><td style="padding:8px;font-weight:bold;">Organization:</td><td style="padding:8px;">{organization}</td></tr>
            <tr><td style="padding:8px;font-weight:bold;">Subject:</td><td style="padding:8px;">{subject_line}</td></tr>
        </table>
        <h3>Message</h3>
        <p>{message}</p>
        <hr>
        <p style="color:#888;font-size:12px;">Submitted via HSS Contact page.</p>
        """

    try:
        ses.send_email(
            Source=FROM_EMAIL,
            Destination={"ToAddresses": [TO_EMAIL]},
            Message={
                "Subject": {"Data": subject, "Charset": "UTF-8"},
                "Body": {"Html": {"Data": html_body, "Charset": "UTF-8"}},
            },
        )
        return {
            "statusCode": 200,
            "headers": headers,
            "body": json.dumps({"message": "Email sent successfully"}),
        }
    except ClientError as e:
        print(f"SES Error: {e}")
        return {
            "statusCode": 500,
            "headers": headers,
            "body": json.dumps({"error": "Failed to send email"}),
        }
