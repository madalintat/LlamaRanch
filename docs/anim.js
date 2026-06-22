/* anim.js - scroll reveal + hero drift (reduced-motion-safe) */
(function () {
  'use strict';

  // If the user prefers reduced motion: do nothing.
  // CSS already shows everything by default (opacity:0 is scoped to html.js-anim).
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // Mark the document so CSS can safely hide [data-reveal] elements.
  document.documentElement.classList.add('js-anim');

  // ── Scroll reveal ──────────────────────────────────────────────
  var targets = document.querySelectorAll('[data-reveal]');

  if (!targets.length) return;

  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          observer.unobserve(entry.target);
        }
      });
    },
    {
      threshold: 0.12,
      rootMargin: '0px 0px -40px 0px'
    }
  );

  targets.forEach(function (el) {
    observer.observe(el);
  });

  // ── Line-draw for eyebrow rules ────────────────────────────────
  // [data-reveal-rule] elements also get [data-reveal], so the .in
  // class propagates to the ::before pseudo as well - no extra work needed.
})();

// ── Copy-to-clipboard for the install command (runs regardless of motion) ──
(function () {
  'use strict';
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy');
      if (!navigator.clipboard || !navigator.clipboard.writeText) return;
      navigator.clipboard.writeText(text).then(function () {
        var orig = btn.textContent;
        btn.textContent = 'Copied';
        btn.classList.add('copied');
        setTimeout(function () {
          btn.textContent = orig;
          btn.classList.remove('copied');
        }, 1500);
      }).catch(function () {});
    });
  });
})();
