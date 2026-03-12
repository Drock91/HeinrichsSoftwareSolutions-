/* =====================================================
   HEINRICHS SOFTWARE SOLUTIONS LLC — App Logic
   Multi-page nav | Scroll reveal animations
   Sticky header | Hamburger menu | Apply modal
   ===================================================== */

/* ── API endpoint — update this after creating API Gateway ── */
window.HSS_API_URL = 'https://pd30lkyyof.execute-api.us-east-2.amazonaws.com/prod/contact';

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
        delete data.resume; // file can't be sent via JSON
        data.formType = 'application';

        try {
          const res = await fetch(window.HSS_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
          });
          if (!res.ok) throw new Error('Server error');
          applyForm.reset();
          closeModal();
          alert('Your application has been submitted! We will review and contact you shortly. Please email your resume to heinrichssoftwaresolutions@gmail.com.');
        } catch (err) {
          console.error('Submit error:', err);
          alert('There was an error submitting your application. Please email us directly at heinrichssoftwaresolutions@gmail.com');
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

      const data = Object.fromEntries(new FormData(contactForm));
      data.formType = 'contact';

      try {
        const res = await fetch(window.HSS_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        if (!res.ok) throw new Error('Server error');
        contactForm.reset();
        alert('Thank you for your inquiry, ' + data.name + '. We will respond within 24 hours.');
      } catch (err) {
        console.error('Submit error:', err);
        alert('There was an error sending your message. Please email us directly at heinrichssoftwaresolutions@gmail.com');
      } finally {
        btn.textContent = origText;
        btn.disabled = false;
      }
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
});
