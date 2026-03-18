/**
 * HSS Chatbot Widget - Embeddable chat widget for client websites
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
    primaryColor: config.primaryColor || '#F5C800',
    headerColor: config.headerColor || '#1A1A2E',
    bubbleSize: config.bubbleSize || '60px',
    zIndex: config.zIndex || 9999
  };

  // State
  let isOpen = false;
  let chatConfig = null;
  let messages = [];
  let conversationCount = 0;

  // Create styles
  const styles = document.createElement('style');
  styles.textContent = `
    #hss-chat-widget * {
      box-sizing: border-box;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
    }
    #hss-chat-bubble {
      position: fixed;
      ${options.position.includes('right') ? 'right: 20px;' : 'left: 20px;'}
      ${options.position.includes('bottom') ? 'bottom: 20px;' : 'top: 20px;'}
      width: ${options.bubbleSize};
      height: ${options.bubbleSize};
      border-radius: 50%;
      background: ${options.primaryColor};
      cursor: pointer;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: ${options.zIndex};
      transition: transform 0.2s, box-shadow 0.2s;
    }
    #hss-chat-bubble:hover {
      transform: scale(1.1);
      box-shadow: 0 6px 25px rgba(0,0,0,0.4);
    }
    #hss-chat-bubble svg {
      width: 28px;
      height: 28px;
      fill: #1A1A2E;
    }
    #hss-chat-window {
      position: fixed;
      ${options.position.includes('right') ? 'right: 20px;' : 'left: 20px;'}
      ${options.position.includes('bottom') ? 'bottom: 90px;' : 'top: 90px;'}
      width: 370px;
      height: 520px;
      max-height: calc(100vh - 120px);
      background: #fff;
      border-radius: 16px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.3);
      display: none;
      flex-direction: column;
      overflow: hidden;
      z-index: ${options.zIndex};
    }
    #hss-chat-window.open {
      display: flex;
    }
    @media (max-width: 420px) {
      #hss-chat-window {
        width: calc(100vw - 20px);
        height: calc(100vh - 100px);
        right: 10px;
        left: 10px;
        bottom: 80px;
      }
    }
    #hss-chat-header {
      background: ${options.headerColor};
      color: #fff;
      padding: 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    #hss-chat-header-title {
      font-weight: 600;
      font-size: 16px;
    }
    #hss-chat-close {
      background: none;
      border: none;
      color: #fff;
      cursor: pointer;
      padding: 4px;
      font-size: 20px;
      line-height: 1;
    }
    #hss-chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      background: #f8f9fa;
    }
    .hss-message {
      margin-bottom: 12px;
      display: flex;
      flex-direction: column;
    }
    .hss-message.user {
      align-items: flex-end;
    }
    .hss-message.bot {
      align-items: flex-start;
    }
    .hss-message-bubble {
      max-width: 80%;
      padding: 10px 14px;
      border-radius: 16px;
      font-size: 14px;
      line-height: 1.4;
    }
    .hss-message.user .hss-message-bubble {
      background: ${options.primaryColor};
      color: #1A1A2E;
      border-bottom-right-radius: 4px;
    }
    .hss-message.bot .hss-message-bubble {
      background: #fff;
      color: #333;
      border: 1px solid #e0e0e0;
      border-bottom-left-radius: 4px;
    }
    .hss-typing {
      display: flex;
      gap: 4px;
      padding: 10px 14px;
    }
    .hss-typing span {
      width: 8px;
      height: 8px;
      background: #999;
      border-radius: 50%;
      animation: hss-bounce 1.4s infinite ease-in-out;
    }
    .hss-typing span:nth-child(1) { animation-delay: 0s; }
    .hss-typing span:nth-child(2) { animation-delay: 0.2s; }
    .hss-typing span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes hss-bounce {
      0%, 80%, 100% { transform: translateY(0); }
      40% { transform: translateY(-6px); }
    }
    #hss-chat-input-area {
      padding: 12px;
      background: #fff;
      border-top: 1px solid #e0e0e0;
      display: flex;
      gap: 8px;
    }
    #hss-chat-input {
      flex: 1;
      padding: 10px 14px;
      border: 1px solid #ddd;
      border-radius: 24px;
      font-size: 14px;
      outline: none;
    }
    #hss-chat-input:focus {
      border-color: ${options.primaryColor};
    }
    #hss-chat-send {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: ${options.primaryColor};
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #hss-chat-send:hover {
      opacity: 0.9;
    }
    #hss-chat-send:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    #hss-chat-send svg {
      width: 18px;
      height: 18px;
      fill: #1A1A2E;
    }
    #hss-powered-by {
      text-align: center;
      padding: 8px;
      font-size: 11px;
      color: #999;
      background: #fff;
    }
    #hss-powered-by a {
      color: #666;
      text-decoration: none;
    }
    #hss-powered-by a:hover {
      text-decoration: underline;
    }
  `;
  document.head.appendChild(styles);

  // Create widget HTML
  const widget = document.createElement('div');
  widget.id = 'hss-chat-widget';
  widget.innerHTML = `
    <div id="hss-chat-bubble">
      <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>
    </div>
    <div id="hss-chat-window">
      <div id="hss-chat-header">
        <span id="hss-chat-header-title">Chat with us</span>
        <button id="hss-chat-close">&times;</button>
      </div>
      <div id="hss-chat-messages"></div>
      <div id="hss-chat-input-area">
        <input type="text" id="hss-chat-input" placeholder="Type a message..." />
        <button id="hss-chat-send">
          <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        </button>
      </div>
      <div id="hss-powered-by">
        Powered by <a href="https://heinrichstech.com" target="_blank">Heinrichs Software Solutions</a>
      </div>
    </div>
  `;
  document.body.appendChild(widget);

  // Get elements
  const bubble = document.getElementById('hss-chat-bubble');
  const chatWindow = document.getElementById('hss-chat-window');
  const closeBtn = document.getElementById('hss-chat-close');
  const messagesContainer = document.getElementById('hss-chat-messages');
  const input = document.getElementById('hss-chat-input');
  const sendBtn = document.getElementById('hss-chat-send');
  const headerTitle = document.getElementById('hss-chat-header-title');

  // Load chatbot config
  async function loadConfig() {
    try {
      const resp = await fetch(`${API_BASE}/chatbot/config?configId=${options.configId}`);
      if (!resp.ok) throw new Error('Config not found');
      const data = await resp.json();
      chatConfig = data;
      headerTitle.textContent = chatConfig.headerText || chatConfig.businessName || 'Chat with us';
      // Add welcome message
      if (chatConfig.welcomeMessage) {
        addMessage(chatConfig.welcomeMessage, 'bot');
      }
    } catch (err) {
      console.error('HSS Chatbot: Failed to load config', err);
    }
  }

  // Add message to chat
  function addMessage(text, type) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `hss-message ${type}`;
    msgDiv.innerHTML = `<div class="hss-message-bubble">${escapeHtml(text)}</div>`;
    messagesContainer.appendChild(msgDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  // Show typing indicator
  function showTyping() {
    const typing = document.createElement('div');
    typing.className = 'hss-message bot';
    typing.id = 'hss-typing';
    typing.innerHTML = `<div class="hss-message-bubble hss-typing"><span></span><span></span><span></span></div>`;
    messagesContainer.appendChild(typing);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function hideTyping() {
    const typing = document.getElementById('hss-typing');
    if (typing) typing.remove();
  }

  // Send message
  async function sendMessage() {
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    addMessage(text, 'user');
    sendBtn.disabled = true;
    showTyping();

    try {
      // Add current message to history for API call
      const apiMessages = [...messages.slice(-10), { role: 'user', content: text }];
      
      const resp = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          configId: options.configId,
          messages: apiMessages
        })
      });
      const data = await resp.json();
      hideTyping();
      
      if (data.reply) {
        addMessage(data.reply, 'bot');
        messages.push({ role: 'user', content: text });
        messages.push({ role: 'assistant', content: data.reply });
        conversationCount++;
      } else if (data.error) {
        addMessage('Sorry, something went wrong. Please try again.', 'bot');
      }
    } catch (err) {
      hideTyping();
      addMessage('Sorry, I couldn\'t connect. Please try again later.', 'bot');
      console.error('HSS Chatbot: Send error', err);
    }

    sendBtn.disabled = false;
    input.focus();
  }

  // Escape HTML
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Toggle chat window
  function toggleChat() {
    isOpen = !isOpen;
    chatWindow.classList.toggle('open', isOpen);
    if (isOpen) {
      input.focus();
    }
  }

  // Event listeners
  bubble.addEventListener('click', toggleChat);
  closeBtn.addEventListener('click', toggleChat);
  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
  });

  // Initialize
  loadConfig();

})();
