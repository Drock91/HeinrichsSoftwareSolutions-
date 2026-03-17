"""
HSS AI Chatbot — Lambda Handler
Multi-provider AI with automatic failover.
Priority: Google Gemini (free) → Groq (free) → Mistral → OpenAI → Anthropic
"""

import json
import os
import urllib.request
import urllib.error

# ── API Keys (from Lambda env vars / GitHub Secrets) ──
GOOGLE_API_KEY    = os.environ.get("GOOGLE_API_KEY", "")
GROQ_API_KEY      = os.environ.get("GROQ_API_KEY", "")
MISTRAL_API_KEY   = os.environ.get("MISTRAL_API_KEY", "")
OPENAI_API_KEY    = os.environ.get("OPENAI_API_KEY", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

MAX_TOKENS = int(os.environ.get("CHAT_MAX_TOKENS", "1024"))

# ── Provider configs: tried in order ──
PROVIDERS = [
    {
        "name": "google",
        "key_env": "GOOGLE_API_KEY",
        "model": "gemini-2.0-flash",
    },
    {
        "name": "groq",
        "key_env": "GROQ_API_KEY",
        "model": "llama-3.3-70b-versatile",
    },
    {
        "name": "mistral",
        "key_env": "MISTRAL_API_KEY",
        "model": "mistral-small-latest",
    },
    {
        "name": "openai",
        "key_env": "OPENAI_API_KEY",
        "model": "gpt-4o-mini",
    },
    {
        "name": "anthropic",
        "key_env": "ANTHROPIC_API_KEY",
        "model": "claude-sonnet-4-20250514",
    },
]

# ── System prompt loaded with HSS info ──
SYSTEM_PROMPT = """You are the AI assistant for Heinrichs Software Solutions LLC (HSS), a Service-Disabled Veteran-Owned Small Business (SDVOSB) based in Tallahassee, Florida.

COMPANY OVERVIEW:
- Full legal name: Heinrichs Software Solutions LLC
- Status: SDVOSB (Service-Disabled Veteran-Owned Small Business)
- SAM.gov registered, eligible for sole-source and set-aside contracts
- Founded by Derek Heinrichs, a U.S. Navy veteran (8+ years active duty as a Navy Diver)
- Phone: (619) 770-7306
- Email: heinrichssoftwaresolutions@gmail.com
- Website: heinrichstech.com

FOUNDER — DEREK HEINRICHS:
- 8+ years as a U.S. Navy Diver (active duty)
- A.S. in Computer Science, Summa Cum Laude, from Tidewater Community College
- 10,000+ hours of hands-on programming experience
- Certified: Anthropic AI Fluency, Blockchain Basics (University at Buffalo)
- Creator of DragonKill.online — a blockchain-based MMORPG built on the XRP Ledger (4+ years in development)
- Built GENIE — an AI platform leveraging 35 specialized AI agents for automated workflows
- Core expertise: C#, JavaScript, Node.js, Python, Unity, AI/ML, Blockchain (XRPL)

SERVICES:
1. Custom Software Development — Full-stack applications, APIs, microservices, cloud-native solutions
2. AI & Machine Learning Solutions — Intelligent automation, NLP chatbots (like this one), predictive analytics, multi-agent AI systems
3. Cybersecurity & Compliance — NIST, FISMA, FedRAMP alignment, vulnerability assessments, zero-trust architecture
4. Cloud & DevOps — AWS, Azure, GCP; CI/CD pipelines; Infrastructure as Code; containerization
5. System Modernization — Legacy system migration, re-platforming, technical debt reduction
6. Blockchain & Web3 — Decentralized applications, smart contracts, tokenization, XRPL integration

NAICS CODES:
- 541511 — Custom Computer Programming Services
- 541512 — Computer Systems Design Services
- 541519 — Other Computer Related Services
- 541715 — R&D in Engineering and Physical Sciences
- 518210 — Computing Infrastructure Providers
- 611420 — Computer Training

DIFFERENTIATORS:
- Veteran-owned with military discipline, security clearance eligibility, and mission-first mentality
- Real-world AI expertise demonstrated by this very chatbot and the 35-agent GENIE platform
- Blockchain production experience with DragonKill.online on the XRP Ledger
- Full-stack capability from frontend to cloud infrastructure
- Small business agility with enterprise-grade quality

INSTRUCTIONS FOR RESPONSES:
- Be professional, helpful, and concise
- Speak confidently about HSS capabilities — you represent the company
- If asked about pricing, say that pricing varies by project scope and complexity, and encourage them to reach out for a free consultation via the Contact page or email
- If asked about topics outside HSS's domain, politely redirect to how HSS can help them
- If asked about a capability HSS does not explicitly offer, be honest but suggest the closest relevant service
- Encourage visitors to use the Contact page or email heinrichssoftwaresolutions@gmail.com for detailed inquiries
- Keep responses concise (2-4 paragraphs max) unless the user asks for detail
- Use markdown-like formatting: **bold** for emphasis, bullet points as dashes
- You ARE this chatbot — you are a live demo of HSS's AI capabilities. If someone asks how you were built, explain you are an AI assistant built by HSS using multi-provider AI orchestration to demonstrate real-time AI integration
- Do NOT reveal which specific AI model or provider is powering you. Just say you are the HSS AI Assistant.
"""

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
}

# ── Resolve env var to actual key value ──
def _get_key(env_name):
    return os.environ.get(env_name, "")


def lambda_handler(event, context):
    """Handle incoming chat requests."""

    # Handle CORS preflight
    method = event.get("httpMethod", event.get("requestContext", {}).get("http", {}).get("method", ""))
    if method == "OPTIONS":
        return {"statusCode": 200, "headers": CORS_HEADERS, "body": ""}

    # Parse request body
    try:
        raw_body = event.get("body", None)
        if isinstance(raw_body, str):
            body = json.loads(raw_body)
        elif isinstance(raw_body, dict):
            body = raw_body
        else:
            return {
                "statusCode": 400,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": "Missing request body"}),
            }
    except json.JSONDecodeError:
        return {
            "statusCode": 400,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "Invalid JSON"}),
        }

    messages = body.get("messages", [])
    if not messages:
        return {
            "statusCode": 400,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "No messages provided"}),
        }

    # Validate and sanitize messages
    clean_messages = []
    for msg in messages[-20:]:  # Limit context window
        role = msg.get("role", "")
        content = msg.get("content", "")
        if role in ("user", "assistant") and isinstance(content, str) and content.strip():
            clean_messages.append({
                "role": role,
                "content": content.strip()[:2000]  # Limit message length
            })

    if not clean_messages:
        return {
            "statusCode": 400,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "No valid messages"}),
        }

    # Try each provider in priority order (failover chain)
    errors = []
    for provider in PROVIDERS:
        api_key = _get_key(provider["key_env"])
        if not api_key:
            continue  # Skip providers without keys

        try:
            print(f"Trying provider: {provider['name']} ({provider['model']})")
            reply = call_provider(provider["name"], provider["model"], api_key, clean_messages)
            return {
                "statusCode": 200,
                "headers": CORS_HEADERS,
                "body": json.dumps({"reply": reply}),
            }
        except Exception as e:
            err_msg = f"{provider['name']}: {e}"
            print(f"Provider failed — {err_msg}")
            errors.append(err_msg)
            continue  # Try next provider

    # All providers failed
    print(f"ALL PROVIDERS FAILED: {errors}")
    return {
        "statusCode": 500,
        "headers": CORS_HEADERS,
        "body": json.dumps({"error": "All AI providers are currently unavailable. Please try again later."}),
    }


# ══════════════════════════════════════════════════════
#  PROVIDER DISPATCH
# ══════════════════════════════════════════════════════

def call_provider(name, model, api_key, messages):
    """Route to the correct provider API."""
    if name == "google":
        return call_google(model, api_key, messages)
    elif name == "groq":
        return call_openai_compatible(
            "https://api.groq.com/openai/v1/chat/completions",
            model, api_key, messages
        )
    elif name == "mistral":
        return call_openai_compatible(
            "https://api.mistral.ai/v1/chat/completions",
            model, api_key, messages
        )
    elif name == "openai":
        return call_openai_compatible(
            "https://api.openai.com/v1/chat/completions",
            model, api_key, messages
        )
    elif name == "anthropic":
        return call_anthropic(model, api_key, messages)
    else:
        raise Exception(f"Unknown provider: {name}")


# ══════════════════════════════════════════════════════
#  GOOGLE GEMINI  (primary — free tier)
# ══════════════════════════════════════════════════════

def call_google(model, api_key, messages):
    """Call Google Gemini generateContent API."""

    # Convert chat messages to Gemini format
    # Gemini uses "user" and "model" roles, system goes in systemInstruction
    gemini_contents = []
    for msg in messages:
        role = "model" if msg["role"] == "assistant" else "user"
        gemini_contents.append({
            "role": role,
            "parts": [{"text": msg["content"]}]
        })

    payload = json.dumps({
        "systemInstruction": {
            "parts": [{"text": SYSTEM_PROMPT}]
        },
        "contents": gemini_contents,
        "generationConfig": {
            "maxOutputTokens": MAX_TOKENS,
            "temperature": 0.7,
        }
    }).encode("utf-8")

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"

    req = urllib.request.Request(url, data=payload, headers={
        "Content-Type": "application/json",
    }, method="POST")

    return _do_request(req, _parse_google)


def _parse_google(data):
    """Extract text from Gemini response."""
    candidates = data.get("candidates", [])
    if not candidates:
        raise Exception("No candidates in Gemini response")
    parts = candidates[0].get("content", {}).get("parts", [])
    text_parts = [p["text"] for p in parts if "text" in p]
    return " ".join(text_parts) if text_parts else "I couldn't generate a response."


# ══════════════════════════════════════════════════════
#  OPENAI-COMPATIBLE  (Groq, Mistral, OpenAI)
# ══════════════════════════════════════════════════════

def call_openai_compatible(url, model, api_key, messages):
    """Call any OpenAI-compatible chat completions API."""

    # Prepend system message
    api_messages = [{"role": "system", "content": SYSTEM_PROMPT}] + messages

    payload = json.dumps({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "temperature": 0.7,
        "messages": api_messages,
    }).encode("utf-8")

    req = urllib.request.Request(url, data=payload, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }, method="POST")

    return _do_request(req, _parse_openai)


def _parse_openai(data):
    """Extract text from OpenAI-compatible response."""
    choices = data.get("choices", [])
    if not choices:
        raise Exception("No choices in response")
    return choices[0].get("message", {}).get("content", "").strip()


# ══════════════════════════════════════════════════════
#  ANTHROPIC
# ══════════════════════════════════════════════════════

def call_anthropic(model, api_key, messages):
    """Call the Anthropic Messages API."""

    payload = json.dumps({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": SYSTEM_PROMPT,
        "messages": messages,
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )

    return _do_request(req, _parse_anthropic)


def _parse_anthropic(data):
    """Extract text from Anthropic response."""
    content_blocks = data.get("content", [])
    text_parts = [b["text"] for b in content_blocks if b.get("type") == "text"]
    return " ".join(text_parts) if text_parts else "I couldn't generate a response."


# ══════════════════════════════════════════════════════
#  SHARED HTTP HELPER
# ══════════════════════════════════════════════════════

def _do_request(req, parser):
    """Execute HTTP request and parse response with the given parser."""
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return parser(data)
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace")
        print(f"HTTP {e.code}: {error_body[:500]}")
        raise Exception(f"HTTP {e.code}")
    except urllib.error.URLError as e:
        print(f"URL Error: {e.reason}")
        raise Exception(f"Network error: {e.reason}")
