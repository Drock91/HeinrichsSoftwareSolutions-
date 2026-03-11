import json
import boto3
from botocore.exceptions import ClientError

# ─── CONFIG ───
TO_EMAIL = "heinrichssoftwaresolutions@gmail.com"
FROM_EMAIL = "heinrichssoftwaresolutions@gmail.com"  # Must be SES-verified
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

    try:
        body = json.loads(event.get("body", "{}"))
    except json.JSONDecodeError:
        return {
            "statusCode": 400,
            "headers": headers,
            "body": json.dumps({"error": "Invalid JSON"}),
        }

    form_type = body.get("formType", "contact")
    name = body.get("name", "Unknown")
    email = body.get("email", "No email provided")

    if form_type == "application":
        position = body.get("position", "Not specified")
        phone = body.get("phone", "Not provided")
        cover_letter = body.get("coverLetter", "None")

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
        <p style="color:#888;font-size:12px;">Submitted via HSS Careers page. Applicant should email resume separately.</p>
        """
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
