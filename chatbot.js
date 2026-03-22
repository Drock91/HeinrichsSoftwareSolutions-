/* =====================================================
   HEINRICHS SOFTWARE SOLUTIONS — AI Chatbot Widget
   Floating chat assistant powered by Claude AI
   ===================================================== */

(function () {
  'use strict';

  /* ── Config ── */
  const CHAT_API_URL = 'https://pd30lkyyof.execute-api.us-east-2.amazonaws.com/prod/chat';
  const BOT_NAME = 'HSS Assistant';
  const GREETING = `Hello! I'm the HSS AI Assistant. I can answer questions about our services, capabilities, and how we can help your organization. What can I help you with?`;
  const MAX_HISTORY = 20; // max messages to send for context

  /* ── State ── */
  let isOpen = false;
  let isTyping = false;
  let conversationHistory = [];

  /* ── Inject HTML ── */
  function createWidget() {
    const widget = document.createElement('div');
    widget.id = 'hss-chatbot';
    widget.innerHTML = `
      <!-- Floating Toggle Button -->
      <button id="chat-toggle" aria-label="Open chat assistant" title="Chat with our AI Assistant">
        <svg id="chat-icon-open" xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <svg id="chat-icon-close" xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none;">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>

      <!-- Chat Window -->
      <div id="chat-window" class="chat-hidden">
        <div id="chat-header">
          <div class="chat-header-info">
            <div class="chat-avatar">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 8V4H8"/>
                <rect x="2" y="2" width="20" height="20" rx="2"/>
                <path d="m6 12 4-4 4 4 4-4"/>
              </svg>
            </div>
            <div>
              <div class="chat-header-title">${BOT_NAME}</div>
              <div class="chat-header-status">
                <span class="chat-status-dot"></span> Online
              </div>
            </div>
          </div>
          <button id="chat-minimize" aria-label="Minimize chat">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </button>
        </div>

        <div id="chat-messages">
          <!-- Messages render here -->
        </div>

        <div id="chat-typing" style="display:none;">
          <div class="typing-indicator">
            <span></span><span></span><span></span>
          </div>
        </div>

        <form id="chat-form">
          <input
            type="text"
            id="chat-input"
            placeholder="Type your message..."
            autocomplete="off"
            maxlength="1000"
          />
          <button type="submit" id="chat-send" aria-label="Send message">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"/>
              <polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
          </button>
        </form>
      </div>
    `;
    document.body.appendChild(widget);
  }

  /* ── Toggle chat open/closed ── */
  function toggleChat() {
    const win = document.getElementById('chat-window');
    const iconOpen = document.getElementById('chat-icon-open');
    const iconClose = document.getElementById('chat-icon-close');

    isOpen = !isOpen;

    if (isOpen) {
      win.classList.remove('chat-hidden');
      win.classList.add('chat-visible');
      iconOpen.style.display = 'none';
      iconClose.style.display = 'block';
      document.getElementById('chat-input').focus();

      // Show greeting if first open
      if (conversationHistory.length === 0) {
        addMessage('assistant', GREETING);
      }
    } else {
      win.classList.remove('chat-visible');
      win.classList.add('chat-hidden');
      iconOpen.style.display = 'block';
      iconClose.style.display = 'none';
    }
  }

  /* ── Add a message to the chat ── */
  function addMessage(role, content) {
    const container = document.getElementById('chat-messages');

    const msgDiv = document.createElement('div');
    msgDiv.className = `chat-msg chat-msg-${role}`;

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    bubble.innerHTML = formatMessage(content);

    const time = document.createElement('div');
    time.className = 'chat-time';
    time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    msgDiv.appendChild(bubble);
    msgDiv.appendChild(time);
    container.appendChild(msgDiv);

    // Scroll to bottom
    container.scrollTop = container.scrollHeight;

    // Track history (skip greeting for API calls)
    if (conversationHistory.length > 0 || role === 'user') {
      conversationHistory.push({ role, content });
    } else if (role === 'assistant') {
      // First assistant message is the greeting — still track it
      conversationHistory.push({ role, content });
    }
  }

  /* ── Simple markdown-like formatting ── */
  function formatMessage(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }

  /* ── Show/hide typing indicator ── */
  function setTyping(show) {
    isTyping = show;
    const el = document.getElementById('chat-typing');
    const msgs = document.getElementById('chat-messages');
    el.style.display = show ? 'flex' : 'none';
    if (show) msgs.scrollTop = msgs.scrollHeight;
  }

  /* ── Send message to backend ── */
  async function sendMessage(userText) {
    addMessage('user', userText);
    setTyping(true);

    // Build message history for context (trim to MAX_HISTORY)
    const messages = conversationHistory.slice(-MAX_HISTORY).map(m => ({
      role: m.role,
      content: m.content
    }));

    try {
      const res = await fetch(CHAT_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Server error (${res.status})`);
      }

      const data = await res.json();
      setTyping(false);
      addMessage('assistant', data.reply || 'Sorry, I couldn\'t generate a response. Please try again.');

    } catch (err) {
      console.error('Chat error:', err);
      setTyping(false);
      addMessage('assistant', 'I\'m having trouble connecting right now. Please try again in a moment, or reach out to us directly at **contact@heinrichstech.com**.');
    }
  }

  /* ── Initialize ── */
  function init() {
    createWidget();

    // Toggle button
    document.getElementById('chat-toggle').addEventListener('click', toggleChat);
    document.getElementById('chat-minimize').addEventListener('click', toggleChat);

    // Form submit
    document.getElementById('chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('chat-input');
      const text = input.value.trim();
      if (!text || isTyping) return;
      input.value = '';
      sendMessage(text);
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen) toggleChat();
    });
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
