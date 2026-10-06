/**
 * LA BOCA NEGRA — Main Script
 * Hero entrance animations + site-wide interactions
 */

(function () {
  'use strict';

  // Prevent the browser from restoring the previous scroll/anchor position on reload
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  document.addEventListener('DOMContentLoaded', () => {
    // Always land at the very top, ignoring restored/anchor position
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });

    // Reveal the hero content immediately (splash screen removed)
    document.querySelector('.hero')?.classList.add('revealed');

    // Back/forward cache restores: snap back to the top too
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    });

    // Menu Modal
    const menuModal = document.getElementById('menu-modal');
    const openMenuBtns = document.querySelectorAll('.open-menu-modal, #open-menu-modal');
    const closeBtn = document.getElementById('close-menu-modal');
    const overlay = document.getElementById('menu-modal-overlay');

    function openModal() { menuModal.hidden = false; }
    function closeModal() { menuModal.hidden = true; }

    openMenuBtns.forEach(btn => btn.addEventListener('click', openModal));
    closeBtn?.addEventListener('click', closeModal);
    overlay?.addEventListener('click', closeModal);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !menuModal.hidden) closeModal();
    });

    // Booking Modal
    const bookingModal = document.getElementById('booking-modal');
    const openBookingBtns = document.querySelectorAll('[data-open-booking]');
    const closeBookingBtn = document.getElementById('close-booking-modal');
    const bookingOverlay = document.getElementById('booking-modal-overlay');
    const bookingForm = document.getElementById('booking-form');
    const bookingError = document.getElementById('booking-error');
    const bookingSuccess = document.getElementById('booking-success');
    const bookingSubmit = document.getElementById('booking-submit');

    function openBookingModal() {
      bookingModal.hidden = false;
      bookingError.hidden = true;
      bookingSuccess.hidden = true;
      bookingSubmit.hidden = false;
      bookingForm.reset();
    }

    function closeBookingModal() {
      bookingModal.hidden = true;
    }

    openBookingBtns.forEach(btn => btn.addEventListener('click', openBookingModal));
    closeBookingBtn?.addEventListener('click', closeBookingModal);
    bookingOverlay?.addEventListener('click', closeBookingModal);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !bookingModal.hidden) closeBookingModal();
    });

    // Booking Form Submit
    bookingForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      bookingError.hidden = true;

      const name = document.getElementById('booking-name').value.trim();
      const phone = document.getElementById('booking-phone').value.trim();
      const guests = document.getElementById('booking-guests').value;
      const date = document.getElementById('booking-date').value;
      const time = document.getElementById('booking-time').value;

      // Validate all fields
      if (!name || !phone || !guests || !date || !time) {
        bookingError.textContent = 'Veuillez remplir tous les champs.';
        bookingError.hidden = false;
        return;
      }

      // Time restriction: 13:00 – 20:00
      if (time < '13:00' || time > '20:00') {
        bookingError.textContent = 'Les réservations en ligne sont clôturées après 20h en raison de la forte affluence. Veuillez appeler le restaurant directement au +212 6 14 36 66 81.';
        bookingError.hidden = false;
        return;
      }

      // Success — show message then redirect to WhatsApp
      bookingError.hidden = true;
      bookingSuccess.hidden = false;
      bookingSubmit.hidden = true;

      const formattedDate = new Date(date).toLocaleDateString('fr-FR', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      });

      const message = [
        '🍽️ *Réservation — LA BOCA NEGRA*',
        '',
        `👤 *Nom :* ${name}`,
        `📞 *Téléphone :* ${phone}`,
        `👥 *Invités :* ${guests}`,
        `📅 *Date :* ${formattedDate}`,
        `⏰ *Heure :* ${time}`,
        '',
        'Merci de confirmer cette réservation.'
      ].join('%0A');

      setTimeout(() => {
        window.open(`https://wa.me/212614366681?text=${message}`, 'whatsapp_reservation', 'noopener,noreferrer');
      }, 1500);
    });

    // History Modal
    const historyModal = document.getElementById('history-modal');
    const openHistoryBtns = document.querySelectorAll('.open-history-modal');
    const closeHistoryBtn = document.getElementById('close-history-modal');
    const historyOverlay = document.getElementById('history-modal-overlay');

    function openHistoryModal() { historyModal.hidden = false; }
    function closeHistoryModal() { historyModal.hidden = true; }

    openHistoryBtns.forEach(btn => btn.addEventListener('click', openHistoryModal));
    closeHistoryBtn?.addEventListener('click', closeHistoryModal);
    historyOverlay?.addEventListener('click', closeHistoryModal);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !historyModal.hidden) closeHistoryModal();
    });

    // Contact Modal
    const contactModal = document.getElementById('contact-modal');
    const openContactBtns = document.querySelectorAll('.open-contact-modal');
    const closeContactBtn = document.getElementById('close-contact-modal');
    const contactOverlay = document.getElementById('contact-modal-overlay');

    function openContactModal() { contactModal.hidden = false; }
    function closeContactModal() { contactModal.hidden = true; }

    openContactBtns.forEach(btn => btn.addEventListener('click', openContactModal));
    closeContactBtn?.addEventListener('click', closeContactModal);
    contactOverlay?.addEventListener('click', closeContactModal);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !contactModal.hidden) closeContactModal();
    });

    // Dynamic Image Slider (coverflow)
    document.querySelectorAll('.dynamic-slider').forEach((root) => {
      const track = root.querySelector('[data-slider-track]');
      if (!track) return;

      const slides = [...track.querySelectorAll('.dynamic-slider__slide')];
      const dotsBox = root.querySelector('[data-slider-dots]');
      const status = root.querySelector('[data-slider-status]');
      const prevBtn = root.querySelector('[data-slider-prev]');
      const nextBtn = root.querySelector('[data-slider-next]');
      const total = slides.length;
      if (!total) return;

      const names = slides.map((s) => s.querySelector('.dynamic-slider__name')?.textContent.trim() || '');
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
      const DELAY = 4500;

      let index = 0;
      let timer = null;
      let manual = false;

      const dots = names.map((name, i) => {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'dynamic-slider__dot';
        dot.setAttribute('aria-label', name ? `Aller à ${name}` : `Aller à la photo ${i + 1}`);
        dot.addEventListener('click', () => { go(i); takeOver(); });
        dotsBox.appendChild(dot);
        return dot;
      });

      function render() {
        root.style.setProperty('--slide-active', index);
        dots.forEach((d, i) => d.setAttribute('aria-current', i === index ? 'true' : 'false'));
        status.textContent = `${index + 1} / ${total}${names[index] ? ' — ' + names[index] : ''}`;
      }

      function go(i) {
        index = ((i % total) + total) % total;
        render();
      }
      const next = () => go(index + 1);
      const prev = () => go(index - 1);

      function stop() { if (timer) { clearInterval(timer); timer = null; } }
      function play() { stop(); if (!manual && !reduceMotion.matches) timer = setInterval(next, DELAY); }
      function takeOver() { manual = true; stop(); }

      nextBtn?.addEventListener('click', () => { next(); takeOver(); });
      prevBtn?.addEventListener('click', () => { prev(); takeOver(); });

      let x0 = null;
      track.addEventListener('pointerdown', (e) => { x0 = e.clientX; });
      track.addEventListener('pointerup', (e) => {
        if (x0 === null) return;
        const dx = e.clientX - x0;
        if (Math.abs(dx) > 45) { dx < 0 ? next() : prev(); takeOver(); }
        x0 = null;
      });

      root.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight') { next(); takeOver(); }
        if (e.key === 'ArrowLeft') { prev(); takeOver(); }
      });

      root.addEventListener('pointerenter', stop);
      root.addEventListener('pointerleave', play);
      root.addEventListener('focusin', stop);
      root.addEventListener('focusout', play);
      document.addEventListener('visibilitychange', () => (document.hidden ? stop() : play()));

      render();
      play();
    });
  });
})();
