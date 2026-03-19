/**
 * HSS Chatbot Widget - Embeddable chat widget for client websites
 * Polished version matching heinrichstech.com styling
 * 
 * Usage: 
 *   <script>window.HSSChatConfig = { configId: "config-xxx" };</script>
 *   <script src="https://heinrichstech.com/widget.js" defer></script>
 */
(function() {
  'use strict';

  const API_BASE = 'https://pd30lkyyof.execute-api.us-east-2.amazonaws.com/prod';
  const config = window.HSSChatConfig || {};
  
  if (!config.configId) {
    console.error('HSS Chatbot: Missing configId in HSSChatConfig');
    return;
  }

  // Default styling options
  const options = {
    configId: config.configId,
    position: config.position || 'bottom-right',
    primaryColor: config.primaryColor || '#D4AF37',
    headerColor: config.headerColor || '#001F3F',
    bubbleSize: config.bubbleSize || '60px',
    zIndex: config.zIndex || 9999
  };

  // State
  let isOpen = false;
  let isTyping = false;
  let chatConfig = null;
  let messages = [];
  let sessionId = `hss_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;

  // Create styles
  const styles = document.createElement('style');
  styles.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@700&family=Roboto:wght@400;500&display=swap');
    
    #hss-chat-widget * {
      box-sizing: border-box;
      font-family: 'Roboto', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    
    /* Toggle Button */
    #hss-chat-toggle {
      position: fixed;
      ${options.position.includes('right') ? 'right: 28px;' : 'left: 28px;'}
      ${options.position.includes('bottom') ? 'bottom: 28px;' : 'top: 28px;'}
      width: ${options.bubbleSize};
      height: ${options.bubbleSize};
      border-radius: 50%;
      border: none;
      background: linear-gradient(135deg, ${options.primaryColor} 0%, #B8960C 100%);
      color: ${options.headerColor};
      cursor: pointer;
      box-shadow: 0 6px 24px rgba(0,0,0,0.3);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: ${options.zIndex};
      transition: transform 0.25s ease, box-shadow 0.25s ease;
      animation: hss-pulse 3s ease-in-out 3;
    }
    #hss-chat-toggle:hover {
      transform: scale(1.08);
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      animation: none;
    }
    #hss-chat-toggle:active { transform: scale(0.96); }
    #hss-chat-toggle svg {
      width: 28px;
      height: 28px;
      stroke: ${options.headerColor};
      fill: none;
      stroke-width: 2;
    }
    
    @keyframes hss-pulse {
      0%, 100% { box-shadow: 0 6px 24px rgba(0,0,0,0.3); }
      50% { box-shadow: 0 6px 24px rgba(212,175,55,0.5), 0 0 0 12px rgba(212,175,55,0.1); }
    }
    
    /* Chat Window */
    #hss-chat-window {
      position: fixed;
      ${options.position.includes('right') ? 'right: 28px;' : 'left: 28px;'}
      ${options.position.includes('bottom') ? 'bottom: 100px;' : 'top: 100px;'}
      width: 380px;
      max-height: 560px;
      background: #fff;
      border-radius: 16px;
      box-shadow: 0 12px 48px rgba(0,0,0,0.25);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      z-index: ${options.zIndex};
      opacity: 0;
      transform: translateY(16px) scale(0.96);
      visibility: hidden;
      pointer-events: none;
      transition: opacity 0.3s ease, transform 0.3s ease, visibility 0.3s;
    }
    #hss-chat-window.hss-open {
      opacity: 1;
      transform: translateY(0) scale(1);
      visibility: visible;
      pointer-events: auto;
    }
    
    @media (max-width: 460px) {
      #hss-chat-window {
        right: 0 !important;
        left: 0 !important;
        bottom: 0 !important;
        width: 100vw;
        max-height: 100vh;
        border-radius: 0;
      }
      #hss-chat-toggle {
        bottom: 16px !important;
        right: 16px !important;
        left: auto !important;
        width: 52px;
        height: 52px;
      }
    }
    
    /* Header */
    #hss-chat-header {
      background: linear-gradient(135deg, ${options.headerColor} 0%, #003B5C 100%);
      color: #fff;
      padding: 14px 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }
    .hss-header-info {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .hss-avatar {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: ${options.primaryColor};
      color: ${options.headerColor};
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .hss-avatar svg {
      width: 20px;
      height: 20px;
      stroke: ${options.headerColor};
      fill: none;
    }
    .hss-header-title {
      font-family: 'Oswald', Impact, sans-serif;
      font-weight: 700;
      font-size: 1rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .hss-header-status {
      font-size: 0.75rem;
      opacity: 0.85;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .hss-status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #4ADE80;
      display: inline-block;
      animation: hss-status-pulse 2s ease-in-out infinite;
    }
    @keyframes hss-status-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    #hss-chat-minimize {
      background: none;
      border: none;
      color: #fff;
      cursor: pointer;
      padding: 4px;
      opacity: 0.7;
      transition: opacity 0.2s;
    }
    #hss-chat-minimize:hover { opacity: 1; }
    #hss-chat-minimize svg {
      width: 20px;
      height: 20px;
      stroke: #fff;
      fill: none;
    }
    
    /* Messages Area */
    #hss-chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      background: #f3f4f6;
      min-height: 260px;
      max-height: 360px;
    }
    #hss-chat-messages::-webkit-scrollbar { width: 5px; }
    #hss-chat-messages::-webkit-scrollbar-track { background: transparent; }
    #hss-chat-messages::-webkit-scrollbar-thumb {
      background: #9CA3AF;
      border-radius: 10px;
    }
    
    /* Message Bubbles */
    .hss-msg {
      display: flex;
      flex-direction: column;
      max-width: 85%;
      animation: hss-msg-slide 0.3s ease;
    }
    @keyframes hss-msg-slide {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .hss-msg-user {
      align-self: flex-end;
      align-items: flex-end;
    }
    .hss-msg-bot {
      align-self: flex-start;
      align-items: flex-start;
    }
    .hss-bubble {
      padding: 10px 14px;
      font-size: 0.9rem;
      line-height: 1.5;
      word-wrap: break-word;
    }
    .hss-msg-user .hss-bubble {
      background: linear-gradient(135deg, ${options.headerColor}, #003B5C);
      color: #fff;
      border-radius: 16px 16px 4px 16px;
    }
    .hss-msg-bot .hss-bubble {
      background: #fff;
      color: #374151;
      border-radius: 16px 16px 16px 4px;
      border: 1px solid #E5E7EB;
    }
    .hss-bubble code {
      background: rgba(0,0,0,0.08);
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 0.85em;
    }
    .hss-time {
      font-size: 0.68rem;
      color: #9CA3AF;
      margin-top: 4px;
      padding: 0 4px;
    }
    
    /* Typing Indicator */
    #hss-typing {
      padding: 8px 16px;
      background: #f3f4f6;
      display: none;
    }
    .hss-typing-indicator {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: #fff;
      border-radius: 16px;
      padding: 10px 16px;
      border: 1px solid #E5E7EB;
    }
    .hss-typing-indicator span {
      width: 7px;
      height: 7px;
      background: ${options.headerColor};
      border-radius: 50%;
      animation: hss-typing-bounce 1.4s ease-in-out infinite;
    }
    .hss-typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
    .hss-typing-indicator span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes hss-typing-bounce {
      0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
      30% { transform: translateY(-6px); opacity: 1; }
    }
    
    /* Input Form */
    #hss-chat-form {
      display: flex;
      padding: 12px;
      gap: 8px;
      background: #fff;
      border-top: 1px solid #E5E7EB;
      flex-shrink: 0;
    }
    #hss-chat-input {
      flex: 1;
      border: 1px solid #D1D5DB;
      border-radius: 24px;
      padding: 10px 16px;
      font-size: 0.9rem;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    #hss-chat-input:focus {
      border-color: ${options.headerColor};
      box-shadow: 0 0 0 3px rgba(0,31,63,0.1);
    }
    #hss-chat-input::placeholder { color: #9CA3AF; }
    #hss-chat-send {
      width: 42px;
      height: 42px;
      border: none;
      border-radius: 50%;
      background: linear-gradient(135deg, ${options.primaryColor}, #B8960C);
      color: ${options.headerColor};
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    #hss-chat-send:hover {
      transform: scale(1.06);
      box-shadow: 0 4px 12px rgba(212,175,55,0.3);
    }
    #hss-chat-send:active { transform: scale(0.94); }
    #hss-chat-send:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
    }
    #hss-chat-send svg {
      width: 20px;
      height: 20px;
      stroke: ${options.headerColor};
      fill: none;
    }
    
    /* Powered By */
    #hss-powered-by {
      text-align: center;
      padding: 8px;
      font-size: 11px;
      color: #9CA3AF;
      background: #fff;
      border-top: 1px solid #f3f4f6;
    }
    #hss-powered-by a {
      color: #6B7280;
      text-decoration: none;
    }
    #hss-powered-by a:hover {
      color: ${options.primaryColor};
      text-decoration: underline;
    }
  `;
  document.head.appendChild(styles);

  // Create widget HTML
  const widget = document.createElement('div');
  widget.id = 'hss-chat-widget';
  widget.innerHTML = `
    <!-- Toggle Button -->
    <button id="hss-chat-toggle" aria-label="Open chat assistant" title="Chat with our AI Assistant">
      <svg id="hss-icon-open" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
      <svg id="hss-icon-close" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" style="display:none;">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>

    <!-- Chat Window -->
    <div id="hss-chat-window">
      <div id="hss-chat-header">
        <div class="hss-header-info">
          <div class="hss-avatar">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
              <path d="M12 8V4H8"/>
              <rect x="2" y="2" width="20" height="20" rx="2"/>
              <path d="m6 12 4-4 4 4 4-4"/>
            </svg>
          </div>
          <div>
            <div class="hss-header-title" id="hss-header-title">AI Assistant</div>
            <div class="hss-header-status">
              <span class="hss-status-dot"></span> Online
            </div>
          </div>
        </div>
        <button id="hss-chat-minimize" aria-label="Minimize chat">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
      </div>

      <div id="hss-chat-messages"></div>

      <div id="hss-typing">
        <div class="hss-typing-indicator">
          <span></span><span></span><span></span>
        </div>
      </div>

      <form id="hss-chat-form">
        <input type="text" id="hss-chat-input" placeholder="Type your message..." autocomplete="off" maxlength="1000" />
        <button type="submit" id="hss-chat-send" aria-label="Send message">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
            <line x1="22" y1="2" x2="11" y2="13"/>
            <polygon points="22 2 15 22 11 13 2 9 22 2" fill="${options.headerColor}"/>
          </svg>
        </button>
      </form>

      <div id="hss-powered-by">
        Powered by <a href="https://heinrichstech.com" target="_blank" rel="noopener">Heinrichs Software Solutions</a>
      </div>
    </div>
  `;
  document.body.appendChild(widget);

  // Get elements
  const toggle = document.getElementById('hss-chat-toggle');
  const chatWindow = document.getElementById('hss-chat-window');
  const minimizeBtn = document.getElementById('hss-chat-minimize');
  const messagesContainer = document.getElementById('hss-chat-messages');
  const input = document.getElementById('hss-chat-input');
  const form = document.getElementById('hss-chat-form');
  const headerTitle = document.getElementById('hss-header-title');
  const iconOpen = document.getElementById('hss-icon-open');
  const iconClose = document.getElementById('hss-icon-close');

  // Load chatbot config
  async function loadConfig() {
    try {
      const resp = await fetch(`${API_BASE}/chatbot/config?configId=${options.configId}`);
      if (!resp.ok) throw new Error('Config not found');
      const data = await resp.json();
      chatConfig = data;
      headerTitle.textContent = chatConfig.headerText || chatConfig.businessName || 'AI Assistant';
    } catch (err) {
      console.error('HSS Chatbot: Failed to load config', err);
    }
  }

  // Toggle chat window
  function toggleChat() {
    isOpen = !isOpen;
    
    if (isOpen) {
      chatWindow.classList.add('hss-open');
      iconOpen.style.display = 'none';
      iconClose.style.display = 'block';
      input.focus();
      
      // Show welcome message on first open
      if (messages.length === 0 && chatConfig?.welcomeMessage) {
        addMessage('bot', chatConfig.welcomeMessage);
      }
    } else {
      chatWindow.classList.remove('hss-open');
      iconOpen.style.display = 'block';
      iconClose.style.display = 'none';
    }
  }

  // Add message to chat
  function addMessage(role, text) {
    messages.push({ role, content: text });
    
    const msgDiv = document.createElement('div');
    msgDiv.className = `hss-msg hss-msg-${role}`;
    
    const bubble = document.createElement('div');
    bubble.className = 'hss-bubble';
    bubble.innerHTML = formatMessage(text);
    
    const time = document.createElement('div');
    time.className = 'hss-time';
    time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    msgDiv.appendChild(bubble);
    msgDiv.appendChild(time);
    messagesContainer.appendChild(msgDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  // Format message with basic markdown
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

  // Show/hide typing indicator
  function setTyping(show) {
    isTyping = show;
    document.getElementById('hss-typing').style.display = show ? 'block' : 'none';
    if (show) messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  // Send message to API
  async function sendMessage(userText) {
    addMessage('user', userText);
    setTyping(true);

    // Build message history for context (last 20)
    const history = messages.slice(-20).map(m => ({
      role: m.role === 'bot' ? 'assistant' : m.role,
      content: m.content
    }));

    try {
      const res = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          configId: options.configId,
          sessionId: sessionId,
          messages: history
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Server error (${res.status})`);
      }

      const data = await res.json();
      setTyping(false);
      addMessage('bot', data.reply || "Sorry, I couldn't generate a response. Please try again.");

    } catch (err) {
      console.error('HSS Chatbot error:', err);
      setTyping(false);
      addMessage('bot', "I'm having trouble connecting right now. Please try again in a moment.");
    }
  }

  // Event listeners
  toggle.addEventListener('click', toggleChat);
  minimizeBtn.addEventListener('click', toggleChat);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || isTyping) return;
    input.value = '';
    sendMessage(text);
  });

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) toggleChat();
  });

  // Initialize
  loadConfig();
})();
