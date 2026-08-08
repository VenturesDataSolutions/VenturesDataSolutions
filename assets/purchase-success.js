// assets/purchase-success.js
(function () {
  const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:8787'
    : 'https://api.venturesdatasolutions.com';

  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('session_id');
  const manageLink = document.getElementById('manage-subscription-link');
  const errorEl = document.getElementById('success-error');

  if (!sessionId) {
    errorEl.textContent = 'No checkout session found. If you just completed checkout, check your email for a confirmation.';
    manageLink.style.display = 'none';
    return;
  }

  let requestInFlight = false;

  manageLink.addEventListener('click', async (event) => {
    event.preventDefault();
    if (requestInFlight) return;
    requestInFlight = true;
    errorEl.textContent = '';
    try {
      const response = await fetch(`${API_BASE}/portal-link?session_id=${encodeURIComponent(sessionId)}`);
      const data = await response.json();
      if (response.ok && data.url) {
        window.location.href = data.url;
        return;
      }
      errorEl.textContent = data.error || 'Could not open the subscription portal. Please email us instead.';
    } catch (err) {
      errorEl.textContent = 'Could not open the subscription portal. Please email us instead.';
    } finally {
      requestInFlight = false;
    }
  });
})();
