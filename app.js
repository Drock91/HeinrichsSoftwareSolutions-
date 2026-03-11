/* =====================================================
   HEINRICHS SOFTWARE SOLUTIONS LLC — App Logic
   Multi-page nav | Scroll reveal animations
   Sticky header | Hamburger menu | Apply modal
   ===================================================== */

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
      applyForm.addEventListener('submit', e => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(applyForm));
        console.log('Application Submission:', data);
        applyForm.reset();
        closeModal();
        alert('Your application has been submitted. We will review and contact you shortly.');
      });
    }
  }

  /* ══════════════════════════════════════
     CONTACT FORM (contact page)
     ══════════════════════════════════════ */
  const contactForm = document.getElementById('contact-form');
  if (contactForm) {
    contactForm.addEventListener('submit', e => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(contactForm));
      console.log('Contact Submission:', data);
      contactForm.reset();
      alert('Thank you for your inquiry, ' + data.name + '. We will respond within 24 hours.');
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
