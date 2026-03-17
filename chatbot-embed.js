/**
 * HSS Embeddable AI Chatbot Widget
 * 
 * Usage: Add this to any website before </body>:
 *   <script src="https://heinrichstech.com/chatbot-embed.js" data-config="CONFIG_ID_HERE"></script>
 * 
 * Optional attributes:
 *   data-position="bottom-right"  (or "bottom-left")
 *   data-primary="#001F3F"        (widget color override)
 */
(function() {
  'use strict';

  const API_BASE = 'https://pd30lkyyof.execute-api.us-east-2.amazonaws.com/prod';

  // Get config from script tag
  const scriptTag = document.currentScript || document.querySelector('script[data-config]');
  const configId = scriptTag?.getAttribute('data-config');
  const posOverride = scriptTag?.getAttribute('data-position');
  const colorOverride = scriptTag?.getAttribute('data-primary');

  if (!configId) {
    console.warn('HSS Chatbot: Missing data-config attribute');
    return;
  }

  // State
  let config = null;
  let messages = [];
  let isOpen = false;
  let isLoading = false;
  let sessionId = `hss_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;

  // ──── FETCH CONFIG ────
  async function loadConfig() {
    try {
      const resp = await fetch(`${API_BASE}/chatbot/config?configId=${configId}`);
      if (!resp.ok) throw new Error('Config not found');
      config = await resp.json();
      if (!config.active) {
        console.warn('HSS Chatbot: Widget is inactive');
        return;
      }
      buildWidget();
    } catch (err) {
      console.warn('HSS Chatbot: Could not load config —', err.message);
    }
  }

  // ──── BUILD WIDGET ────
  function buildWidget() {
    const primaryColor = colorOverride || config.primaryColor || '#001F3F';
    const position = posOverride || config.position || 'bottom-right';
    const welcomeMsg = config.welcomeMessage || "Hi! How can I help you today?";
    const businessName = config.businessName || 'AI Assistant';
    const isLeft = position === 'bottom-left';

    // Inject styles
    const style = document.createElement('style');
    style.textContent = `
      #hss-chat-toggle {
        position: fixed;
        ${isLeft ? 'left' : 'right'}: 20px;
        bottom: 20px;
        width: 60px;
        height: 60px;
        border-radius: 50%;
        background: ${primaryColor};
        color: #fff;
        border: none;
        cursor: pointer;
        box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        z-index: 99999;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.2s, box-shadow 0.2s;
        font-size: 0;
      }
      #hss-chat-toggle:hover {
        transform: scale(1.1);
        box-shadow: 0 6px 28px rgba(0,0,0,0.4);
      }
      #hss-chat-toggle svg { width: 28px; height: 28px; fill: #fff; }

      #hss-chat-widget {
        position: fixed;
        ${isLeft ? 'left' : 'right'}: 20px;
        bottom: 90px;
        width: 380px;
        max-width: calc(100vw - 40px);
        height: 520px;
        max-height: calc(100vh - 120px);
        background: #fff;
        border-radius: 16px;
        box-shadow: 0 12px 48px rgba(0,0,0,0.2);
        z-index: 99999;
        display: none;
        flex-direction: column;
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        animation: hssSlideUp 0.3s ease;
      }
      #hss-chat-widget.hss-open { display: flex; }

      @keyframes hssSlideUp {
        from { opacity: 0; transform: translateY(20px); }
        to { opacity: 1; transform: translateY(0); }
      }

      .hss-chat-header {
        background: ${primaryColor};
        color: #fff;
        padding: 16px 20px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-shrink: 0;
      }
      .hss-chat-header-info h4 {
        margin: 0;
        font-size: 16px;
        font-weight: 600;
      }
      .hss-chat-header-info p {
        margin: 2px 0 0;
        font-size: 12px;
        opacity: 0.8;
      }
      .hss-chat-close {
        background: none;
        border: none;
        color: #fff;
        font-size: 24px;
        cursor: pointer;
        padding: 0;
        line-height: 1;
        opacity: 0.7;
      }
      .hss-chat-close:hover { opacity: 1; }

      .hss-chat-messages {
        flex: 1;
        overflow-y: auto;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .hss-msg {
        max-width: 85%;
        padding: 10px 14px;
        border-radius: 16px;
        font-size: 14px;
        line-height: 1.5;
        word-wrap: break-word;
      }
      .hss-msg-bot {
        align-self: flex-start;
        background: #f0f2f5;
        color: #1a1a1a;
        border-bottom-left-radius: 4px;
      }
      .hss-msg-user {
        align-self: flex-end;
        background: ${primaryColor};
        color: #fff;
        border-bottom-right-radius: 4px;
      }

      .hss-typing {
        align-self: flex-start;
        background: #f0f2f5;
        padding: 12px 18px;
        border-radius: 16px;
        border-bottom-left-radius: 4px;
        display: flex;
        gap: 4px;
      }
      .hss-typing-dot {
        width: 8px;
        height: 8px;
        background: #999;
        border-radius: 50%;
        animation: hssTyping 1.4s infinite;
      }
      .hss-typing-dot:nth-child(2) { animation-delay: 0.2s; }
      .hss-typing-dot:nth-child(3) { animation-delay: 0.4s; }
      @keyframes hssTyping {
        0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
        30% { transform: translateY(-6px); opacity: 1; }
      }

      .hss-chat-input-wrap {
        border-top: 1px solid #e8e8e8;
        padding: 12px 16px;
        display: flex;
        gap: 8px;
        flex-shrink: 0;
        background: #fff;
      }
      .hss-chat-input {
        flex: 1;
        border: 1px solid #ddd;
        border-radius: 24px;
        padding: 10px 16px;
        font-size: 14px;
        outline: none;
        font-family: inherit;
        resize: none;
        max-height: 80px;
      }
      .hss-chat-input:focus { border-color: ${primaryColor}; }
      .hss-chat-send {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background: ${primaryColor};
        color: #fff;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        transition: opacity 0.2s;
      }
      .hss-chat-send:disabled { opacity: 0.4; cursor: default; }
      .hss-chat-send svg { width: 18px; height: 18px; fill: #fff; }

      .hss-powered {
        text-align: center;
        padding: 8px;
        font-size: 11px;
        color: #999;
        background: #fafafa;
        border-top: 1px solid #f0f0f0;
        flex-shrink: 0;
      }
      .hss-powered a {
        color: #666;
        text-decoration: none;
        font-weight: 500;
      }
      .hss-powered a:hover { text-decoration: underline; }

      @media (max-width: 480px) {
        #hss-chat-widget {
          width: calc(100vw - 20px);
          height: calc(100vh - 80px);
          ${isLeft ? 'left' : 'right'}: 10px;
          bottom: 70px;
          border-radius: 12px;
        }
        #hss-chat-toggle {
          width: 52px;
          height: 52px;
          ${isLeft ? 'left' : 'right'}: 14px;
          bottom: 14px;
        }
      }
    `;
    document.head.appendChild(style);

    // Chat toggle button
    const toggle = document.createElement('button');
    toggle.id = 'hss-chat-toggle';
    toggle.setAttribute('aria-label', 'Open chat');
    toggle.innerHTML = `<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>`;
    document.body.appendChild(toggle);

    // Chat widget
    const widget = document.createElement('div');
    widget.id = 'hss-chat-widget';
    widget.innerHTML = `
      <div class="hss-chat-header">
        <div class="hss-chat-header-info">
          <h4>${escHtml(businessName)}</h4>
          <p>Powered by AI</p>
        </div>
        <button class="hss-chat-close" aria-label="Close chat">&times;</button>
      </div>
      <div class="hss-chat-messages" id="hss-messages"></div>
      <div class="hss-chat-input-wrap">
        <input class="hss-chat-input" id="hss-input" type="text" placeholder="Type a message..." autocomplete="off">
        <button class="hss-chat-send" id="hss-send" aria-label="Send">
          <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        </button>
      </div>
      <div class="hss-powered">Powered by <a href="https://heinrichstech.com" target="_blank" rel="noopener">Heinrichs Software Solutions</a></div>
    `;
    document.body.appendChild(widget);

    // Add welcome message
    addMessage('bot', welcomeMsg);

    // ──── EVENT LISTENERS ────
    toggle.addEventListener('click', toggleChat);
    widget.querySelector('.hss-chat-close').addEventListener('click', toggleChat);

    const input = document.getElementById('hss-input');
    const sendBtn = document.getElementById('hss-send');

    sendBtn.addEventListener('click', sendMessage);
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
  }

  function toggleChat() {
    isOpen = !isOpen;
    const widget = document.getElementById('hss-chat-widget');
    const toggle = document.getElementById('hss-chat-toggle');

    if (isOpen) {
      widget.classList.add('hss-open');
      toggle.innerHTML = `<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;
      document.getElementById('hss-input')?.focus();
    } else {
      widget.classList.remove('hss-open');
      toggle.innerHTML = `<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>`;
    }
  }

  function addMessage(role, text) {
    messages.push({ role, text });
    const container = document.getElementById('hss-messages');
    const div = document.createElement('div');
    div.className = `hss-msg hss-msg-${role === 'bot' ? 'bot' : 'user'}`;
    div.textContent = text;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function showTyping() {
    const container = document.getElementById('hss-messages');
    const div = document.createElement('div');
    div.className = 'hss-typing';
    div.id = 'hss-typing-indicator';
    div.innerHTML = '<div class="hss-typing-dot"></div><div class="hss-typing-dot"></div><div class="hss-typing-dot"></div>';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function hideTyping() {
    document.getElementById('hss-typing-indicator')?.remove();
  }

  async function sendMessage() {
    if (isLoading) return;

    const input = document.getElementById('hss-input');
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    addMessage('user', text);

    isLoading = true;
    document.getElementById('hss-send').disabled = true;
    showTyping();

    try {
      // Build conversation history for context
      const history = messages.slice(-10).map(m => ({
        role: m.role === 'bot' ? 'assistant' : 'user',
        content: m.text,
      }));

      const resp = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          configId: configId,
          sessionId: sessionId,
          history: history,
        }),
      });

      const data = await resp.json();
      hideTyping();

      if (data.reply || data.response || data.message) {
        addMessage('bot', data.reply || data.response || data.message);
      } else {
        addMessage('bot', "I'm sorry, I couldn't process that. Please try again.");
      }
    } catch (err) {
      hideTyping();
      addMessage('bot', "Sorry, I'm having trouble connecting. Please try again in a moment.");
    } finally {
      isLoading = false;
      document.getElementById('hss-send').disabled = false;
    }
  }

  function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ──── INIT ────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadConfig);
  } else {
    loadConfig();
  }
})();
