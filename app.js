/* =====================================================
   HEINRICHS SOFTWARE SOLUTIONS COMPANY — App Logic
   Multi-page nav | Scroll reveal animations
   Sticky header | Hamburger menu | Apply modal
   ===================================================== */

/* ── API endpoint — update this after creating API Gateway ── */
window.HSS_API_URL = 'https://pd30lkyyof.execute-api.us-east-2.amazonaws.com/prod/contact';

/* ── Token validation helper (shared across all pages) ── */
window.hssAuth = {
  _refreshing: null, // lock to prevent concurrent refresh attempts

  isTokenValid() {
    const token = localStorage.getItem('hss_id_token');
    if (!token) return false;
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      // exp is in seconds, Date.now() is in ms
      if (payload.exp && (payload.exp * 1000) < Date.now()) {
        // Don't clear session immediately — try refresh first
        return false;
      }
      return true;
    } catch (e) {
      this.clearSession();
      return false;
    }
  },

  // Check if token is valid, attempting silent refresh if expired
  async isTokenValidAsync() {
    if (this.isTokenValid()) return true;
    // Token expired but we may have a refresh token
    const refreshToken = localStorage.getItem('hss_refresh_token');
    if (!refreshToken) {
      this.clearSession();
      return false;
    }
    try {
      await this.refreshSession();
      return this.isTokenValid();
    } catch (e) {
      this.clearSession();
      return false;
    }
  },

  // Refresh tokens using Cognito refresh token
  async refreshSession() {
    // Prevent concurrent refresh calls
    if (this._refreshing) return this._refreshing;

    const refreshToken = localStorage.getItem('hss_refresh_token');
    if (!refreshToken) throw new Error('No refresh token');

    this._refreshing = (async () => {
      try {
        const resp = await fetch('https://cognito-idp.us-east-2.amazonaws.com/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-amz-json-1.1',
            'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
          },
          body: JSON.stringify({
            AuthFlow: 'REFRESH_TOKEN_AUTH',
            ClientId: '4349q6k1fa2vmf5mthuj65t44g',
            AuthParameters: { REFRESH_TOKEN: refreshToken },
          }),
        });

        const data = await resp.json();
        if (data.__type) throw new Error(data.message || 'Refresh failed');

        if (data.AuthenticationResult) {
          localStorage.setItem('hss_id_token', data.AuthenticationResult.IdToken);
          localStorage.setItem('hss_access_token', data.AuthenticationResult.AccessToken);
          // Note: RefreshToken is NOT returned on refresh — keep existing one
          const payload = JSON.parse(atob(data.AuthenticationResult.IdToken.split('.')[1]));
          localStorage.setItem('hss_user_id', payload.sub);
        }
      } finally {
        this._refreshing = null;
      }
    })();

    return this._refreshing;
  },

  getPayload() {
    try {
      const token = localStorage.getItem('hss_id_token');
      return token ? JSON.parse(atob(token.split('.')[1])) : null;
    } catch (e) { return null; }
  },
  clearSession() {
    localStorage.removeItem('hss_id_token');
    localStorage.removeItem('hss_access_token');
    localStorage.removeItem('hss_refresh_token');
    localStorage.removeItem('hss_email');
    localStorage.removeItem('hss_user_id');
  }
};

document.addEventListener('DOMContentLoaded', () => {
  const header    = document.getElementById('header');
  const nav       = document.getElementById('nav');
  const hamburger = document.getElementById('hamburger');

  /* ── Sticky header ── */
  window.addEventListener('scroll', () => {
    header.classList.toggle('scrolled', window.scrollY > 40);
  }, { passive: true });

  /* ── Hamburger toggle ── */
  hamburger.addEventListener('click', () => nav.classList.toggle('open'));

  /* ── Close mobile nav on link click ── */
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', () => nav.classList.remove('open'));
  });

  /* ══════════════════════════════════════
     SCROLL REVEAL — IntersectionObserver
     ══════════════════════════════════════ */
  const revealEls = document.querySelectorAll('.reveal');

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

    revealEls.forEach(el => observer.observe(el));
  } else {
    /* Fallback: show everything immediately */
    revealEls.forEach(el => el.classList.add('visible'));
  }

  /* ══════════════════════════════════════
     APPLY MODAL (careers page)
     ══════════════════════════════════════ */
  const modal    = document.getElementById('apply-modal');
  const posField = document.getElementById('apply-position-field');
  const posTitle = document.getElementById('apply-position');

  if (modal) {
    /* Open modal */
    document.querySelectorAll('.apply-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const job = btn.getAttribute('data-position');
        if (posField) posField.value = job;
        if (posTitle) posTitle.textContent = job;
        modal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
      });
    });

    /* Close modal */
    const closeModal = () => {
      modal.style.display = 'none';
      document.body.style.overflow = '';
    };

    const closeBtn = document.getElementById('modal-close');
    if (closeBtn) closeBtn.addEventListener('click', closeModal);

    modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && modal.style.display === 'flex') closeModal();
    });

    /* Apply form submit */
    const applyForm = document.getElementById('apply-form');
    if (applyForm) {
      applyForm.addEventListener('submit', async e => {
        e.preventDefault();
        const btn = applyForm.querySelector('button[type="submit"]');
        const origText = btn.textContent;
        btn.textContent = 'Submitting...';
        btn.disabled = true;

        const data = Object.fromEntries(new FormData(applyForm));
        data.formType = 'application';

        // Read resume file as base64
        const fileInput = document.getElementById('apply-resume');
        if (fileInput && fileInput.files.length > 0) {
          const file = fileInput.files[0];
          if (file.size > 5 * 1024 * 1024) {
            alert('Resume file must be under 5 MB.');
            btn.textContent = origText;
            btn.disabled = false;
            return;
          }
          const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          data.resumeBase64 = base64;
          data.resumeFilename = file.name;
          data.resumeContentType = file.type || 'application/octet-stream';
        }
        delete data.resume; // remove the File object (can't serialize)

        try {
          const res = await fetch(window.HSS_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
          });
          if (!res.ok) throw new Error('Server error');
          applyForm.reset();
          closeModal();
          alert('Your application has been submitted with your resume! We will review and contact you shortly.');
        } catch (err) {
          console.error('Submit error:', err);
          alert('There was an error submitting your application. Please email us directly at contact@heinrichstech.com');
        } finally {
          btn.textContent = origText;
          btn.disabled = false;
        }
      });
    }
  }

  /* ══════════════════════════════════════
     CONTACT FORM (contact page)
     ══════════════════════════════════════ */
  const contactForm = document.getElementById('contact-form');
  if (contactForm) {
    contactForm.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = contactForm.querySelector('button[type="submit"]');
      const origText = btn.textContent;
      btn.textContent = 'Sending...';
      btn.disabled = true;

      const formData = new FormData(contactForm);
      const data = Object.fromEntries(formData);
      const isCareers = data.subject === 'careers';

      // Handle career application with file attachments
      if (isCareers) {
        data.formType = 'application';
        data.position = 'General Application';
        data.coverLetter = data.message || '';
        delete data.message;

        // Convert resume to base64
        const resumeFile = document.getElementById('c-resume')?.files[0];
        if (resumeFile) {
          try {
            const base64 = await fileToBase64(resumeFile);
            data.resumeBase64 = base64;
            data.resumeFilename = resumeFile.name;
          } catch (err) {
            console.error('Resume upload error:', err);
            alert('Error processing resume file. Please try a smaller file or different format.');
            btn.textContent = origText;
            btn.disabled = false;
            return;
          }
        }

        // Convert cover letter file to base64 (optional)
        const coverFile = document.getElementById('c-cover')?.files[0];
        if (coverFile) {
          try {
            const base64 = await fileToBase64(coverFile);
            data.coverLetterBase64 = base64;
            data.coverLetterFilename = coverFile.name;
          } catch (err) {
            console.error('Cover letter upload error:', err);
            // Non-fatal, continue without attachment
          }
        }
      } else {
        data.formType = 'contact';
      }

      try {
        const res = await fetch(window.HSS_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        if (!res.ok) throw new Error('Server error');
        contactForm.reset();
        // Reset file display names
        const resumeName = document.getElementById('resume-name');
        const coverName = document.getElementById('cover-name');
        if (resumeName) { resumeName.textContent = 'No file selected'; resumeName.classList.remove('selected'); }
        if (coverName) { coverName.textContent = 'No file selected'; coverName.classList.remove('selected'); }
        // Hide career fields
        document.getElementById('career-fields')?.classList.remove('show');

        if (isCareers) {
          alert('Thank you for your application, ' + data.name + '! We will review your resume and get back to you soon.');
        } else {
          alert('Thank you for your inquiry, ' + data.name + '. We will respond within 24 hours.');
        }
      } catch (err) {
        console.error('Submit error:', err);
        alert('There was an error sending your message. Please email us directly at contact@heinrichstech.com');
      } finally {
        btn.textContent = origText;
        btn.disabled = false;
      }
    });
  }

  // Helper: Convert file to base64
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        // Remove data URL prefix (e.g., "data:application/pdf;base64,")
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /* ══════════════════════════════════════
     COUNTER ANIMATION (stat numbers)
     ══════════════════════════════════════ */
  const statNums = document.querySelectorAll('.stat-num');
  if (statNums.length && 'IntersectionObserver' in window) {
    const counterObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('counted');
          counterObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.5 });
    statNums.forEach(el => counterObserver.observe(el));
  }

  /* ══════════════════════════════════════
     AUTH-AWARE NAV (Sign In → My Account)
     ══════════════════════════════════════ */
  const signinLink = document.querySelector('.nav-signin');
  if (signinLink && window.hssAuth.isTokenValid()) {
    const payload = window.hssAuth.getPayload();
    if (payload) {
      const groups = payload['cognito:groups'] || [];
      const isAdmin = groups.includes('admin');
      signinLink.textContent = 'My Account';
      signinLink.href = isAdmin ? 'admin.html' : 'dashboard.html';
      // Handle blog subdirectory links
      if (window.location.pathname.includes('/blog/')) {
        signinLink.href = isAdmin ? '../admin.html' : '../dashboard.html';
      }
    }
  }

  /* ══════════════════════════════════════
     COOKIE CONSENT BANNER
     ══════════════════════════════════════ */
  initCookieConsent();
});

/* ── Cookie Consent Functions ── */
function initCookieConsent() {
  // Check if user has already consented
  const consent = localStorage.getItem('cookie_consent');
  if (consent) {
    // Apply saved preferences
    const prefs = JSON.parse(consent);
    applyCookiePreferences(prefs);
    return;
  }

  // Show the banner if no consent recorded
  showCookieBanner();
}

function showCookieBanner() {
  // Don't show if already on cookie policy page
  if (window.location.pathname.includes('cookies.html')) return;

  // Create banner HTML
  const banner = document.createElement('div');
  banner.id = 'cookie-banner';
  banner.innerHTML = `
    <div class="cookie-banner-content">
      <div class="cookie-banner-text">
        <p><strong>We use cookies</strong> to enhance your experience on our website. By continuing to use this site, you consent to our use of cookies.</p>
        <p class="cookie-banner-links">
          <a href="cookies.html">Cookie Policy</a> &bull; <a href="privacy.html">Privacy Policy</a>
        </p>
      </div>
      <div class="cookie-banner-actions">
        <button id="cookie-accept-all" class="btn btn-gold">Accept All</button>
        <button id="cookie-accept-essential" class="btn btn-outline">Essential Only</button>
        <button id="cookie-customize" class="btn btn-outline-small">Customize</button>
      </div>
    </div>
  `;

  // Add styles
  const style = document.createElement('style');
  style.textContent = `
    #cookie-banner {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      background: linear-gradient(135deg, #001F3F 0%, #002b57 100%);
      border-top: 2px solid #D4AF37;
      padding: 1.25rem 1.5rem;
      z-index: 10000;
      box-shadow: 0 -4px 20px rgba(0,0,0,0.3);
      animation: slideUp 0.4s ease-out;
    }
    @keyframes slideUp {
      from { transform: translateY(100%); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
    .cookie-banner-content {
      max-width: 1200px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 2rem;
      flex-wrap: wrap;
    }
    .cookie-banner-text {
      flex: 1;
      min-width: 300px;
    }
    .cookie-banner-text p {
      color: #E0E0E0;
      margin: 0 0 0.5rem 0;
      font-size: 0.95rem;
      line-height: 1.5;
    }
    .cookie-banner-text p:last-child { margin-bottom: 0; }
    .cookie-banner-text strong { color: #fff; }
    .cookie-banner-links a {
      color: #D4AF37;
      text-decoration: none;
      font-size: 0.85rem;
    }
    .cookie-banner-links a:hover { text-decoration: underline; }
    .cookie-banner-actions {
      display: flex;
      gap: 0.75rem;
      flex-wrap: wrap;
    }
    .cookie-banner-actions .btn {
      padding: 0.6rem 1.25rem;
      font-size: 0.9rem;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 600;
      transition: all 0.2s;
      white-space: nowrap;
    }
    .cookie-banner-actions .btn-gold {
      background: #D4AF37;
      color: #001F3F;
      border: none;
    }
    .cookie-banner-actions .btn-gold:hover { background: #c9a227; }
    .cookie-banner-actions .btn-outline {
      background: transparent;
      color: #fff;
      border: 1px solid #fff;
    }
    .cookie-banner-actions .btn-outline:hover {
      background: rgba(255,255,255,0.1);
    }
    .cookie-banner-actions .btn-outline-small {
      background: transparent;
      color: #A0A0A0;
      border: 1px solid #A0A0A0;
      font-size: 0.8rem;
      padding: 0.5rem 1rem;
    }
    .cookie-banner-actions .btn-outline-small:hover {
      color: #fff;
      border-color: #fff;
    }
    @media (max-width: 768px) {
      #cookie-banner { padding: 1rem; }
      .cookie-banner-content { flex-direction: column; text-align: center; gap: 1rem; }
      .cookie-banner-actions { justify-content: center; }
    }

    /* Cookie Preferences Modal */
    #cookie-modal {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.7);
      z-index: 10001;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1rem;
    }
    .cookie-modal-content {
      background: #001F3F;
      border: 1px solid #D4AF37;
      border-radius: 8px;
      max-width: 500px;
      width: 100%;
      max-height: 80vh;
      overflow-y: auto;
      padding: 2rem;
    }
    .cookie-modal-content h2 {
      color: #D4AF37;
      margin: 0 0 1rem 0;
      font-size: 1.5rem;
    }
    .cookie-modal-content p {
      color: #E0E0E0;
      font-size: 0.9rem;
      line-height: 1.6;
      margin-bottom: 1.5rem;
    }
    .cookie-option {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      padding: 1rem 0;
      border-bottom: 1px solid #333;
    }
    .cookie-option:last-of-type { border-bottom: none; }
    .cookie-option-info { flex: 1; padding-right: 1rem; }
    .cookie-option-info h4 { color: #fff; margin: 0 0 0.25rem 0; font-size: 1rem; }
    .cookie-option-info p { color: #A0A0A0; margin: 0; font-size: 0.85rem; }
    .cookie-toggle {
      position: relative;
      width: 50px;
      height: 26px;
      flex-shrink: 0;
    }
    .cookie-toggle input { opacity: 0; width: 0; height: 0; }
    .cookie-toggle-slider {
      position: absolute;
      cursor: pointer;
      top: 0; left: 0; right: 0; bottom: 0;
      background: #333;
      border-radius: 26px;
      transition: 0.3s;
    }
    .cookie-toggle-slider:before {
      position: absolute;
      content: "";
      height: 20px;
      width: 20px;
      left: 3px;
      bottom: 3px;
      background: #fff;
      border-radius: 50%;
      transition: 0.3s;
    }
    .cookie-toggle input:checked + .cookie-toggle-slider { background: #D4AF37; }
    .cookie-toggle input:checked + .cookie-toggle-slider:before { transform: translateX(24px); }
    .cookie-toggle input:disabled + .cookie-toggle-slider { opacity: 0.6; cursor: not-allowed; }
    .cookie-modal-actions {
      display: flex;
      gap: 1rem;
      margin-top: 1.5rem;
      justify-content: flex-end;
    }
    .cookie-modal-actions .btn {
      padding: 0.6rem 1.5rem;
      font-size: 0.9rem;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 600;
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(banner);

  // Event listeners
  document.getElementById('cookie-accept-all').addEventListener('click', () => {
    saveCookiePreferences({ essential: true, analytics: true, functional: true });
    hideCookieBanner();
  });

  document.getElementById('cookie-accept-essential').addEventListener('click', () => {
    saveCookiePreferences({ essential: true, analytics: false, functional: false });
    hideCookieBanner();
  });

  document.getElementById('cookie-customize').addEventListener('click', showCookieModal);
}

function showCookieModal() {
  // Get current preferences or defaults
  const saved = localStorage.getItem('cookie_consent');
  const prefs = saved ? JSON.parse(saved) : { essential: true, analytics: true, functional: true };

  const modal = document.createElement('div');
  modal.id = 'cookie-modal';
  modal.innerHTML = `
    <div class="cookie-modal-content">
      <h2>Cookie Preferences</h2>
      <p>Customize which cookies you allow. Essential cookies are required for the site to function and cannot be disabled.</p>
      
      <div class="cookie-option">
        <div class="cookie-option-info">
          <h4>Essential Cookies</h4>
          <p>Required for basic site functionality, security, and authentication.</p>
        </div>
        <label class="cookie-toggle">
          <input type="checkbox" checked disabled>
          <span class="cookie-toggle-slider"></span>
        </label>
      </div>
      
      <div class="cookie-option">
        <div class="cookie-option-info">
          <h4>Analytics Cookies</h4>
          <p>Help us understand how visitors use our site (Google Analytics).</p>
        </div>
        <label class="cookie-toggle">
          <input type="checkbox" id="pref-analytics" ${prefs.analytics ? 'checked' : ''}>
          <span class="cookie-toggle-slider"></span>
        </label>
      </div>
      
      <div class="cookie-option">
        <div class="cookie-option-info">
          <h4>Functional Cookies</h4>
          <p>Enable enhanced features like chatbot preferences and personalization.</p>
        </div>
        <label class="cookie-toggle">
          <input type="checkbox" id="pref-functional" ${prefs.functional ? 'checked' : ''}>
          <span class="cookie-toggle-slider"></span>
        </label>
      </div>
      
      <div class="cookie-modal-actions">
        <button id="cookie-modal-cancel" class="btn btn-outline">Cancel</button>
        <button id="cookie-modal-save" class="btn btn-gold">Save Preferences</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Close on backdrop click
  modal.addEventListener('click', e => {
    if (e.target === modal) modal.remove();
  });

  document.getElementById('cookie-modal-cancel').addEventListener('click', () => modal.remove());

  document.getElementById('cookie-modal-save').addEventListener('click', () => {
    const newPrefs = {
      essential: true,
      analytics: document.getElementById('pref-analytics').checked,
      functional: document.getElementById('pref-functional').checked
    };
    saveCookiePreferences(newPrefs);
    modal.remove();
    hideCookieBanner();
  });
}

function saveCookiePreferences(prefs) {
  prefs.timestamp = new Date().toISOString();
  localStorage.setItem('cookie_consent', JSON.stringify(prefs));
  applyCookiePreferences(prefs);
}

function applyCookiePreferences(prefs) {
  // If analytics is disabled, we could disable GA here
  // For now, GA runs by default; to fully disable, you'd need to:
  // 1. Not load the GA script, or
  // 2. Set window['ga-disable-G-2SP20JF1RE'] = true before GA loads
  
  if (!prefs.analytics) {
    // Disable GA
    window['ga-disable-G-2SP20JF1RE'] = true;
    // Remove GA cookies if they exist
    document.cookie = '_ga=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=.' + window.location.hostname;
    document.cookie = '_gid=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=.' + window.location.hostname;
  }
}

function hideCookieBanner() {
  const banner = document.getElementById('cookie-banner');
  if (banner) {
    banner.style.animation = 'slideDown 0.3s ease-in forwards';
    setTimeout(() => banner.remove(), 300);
  }
}

// Global function to show cookie consent (used from Cookie Policy page)
window.showCookieConsent = function() {
  // Remove existing banner/modal
  const existingBanner = document.getElementById('cookie-banner');
  const existingModal = document.getElementById('cookie-modal');
  if (existingBanner) existingBanner.remove();
  if (existingModal) existingModal.remove();
  
  // Clear stored consent
  localStorage.removeItem('cookie_consent');
  
  // Show banner again
  showCookieBanner();
};

// Add slideDown animation
const slideDownStyle = document.createElement('style');
slideDownStyle.textContent = `
  @keyframes slideDown {
    from { transform: translateY(0); opacity: 1; }
    to { transform: translateY(100%); opacity: 0; }
  }
`;
document.head.appendChild(slideDownStyle);
