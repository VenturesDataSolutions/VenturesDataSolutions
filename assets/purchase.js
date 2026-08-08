// assets/purchase.js
(function () {
  const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:8787'
    : 'https://api.venturesdatasolutions.com';

  const input = document.getElementById('county-input');
  const datalist = document.getElementById('county-list');
  const status = document.getElementById('county-status');
  const claimBtn = document.getElementById('claim-btn');
  const errorEl = document.getElementById('purchase-error');

  const nameToCounty = new Map();
  let selectedCountyId = null;

  function disableClaim() {
    claimBtn.setAttribute('aria-disabled', 'true');
    claimBtn.disabled = true;
  }

  function enableClaim() {
    claimBtn.removeAttribute('aria-disabled');
    claimBtn.disabled = false;
  }

  function setStatus(text, isAvailable) {
    status.textContent = text;
    status.className = isAvailable ? 'county-status county-status-available' : 'county-status county-status-unavailable';
  }

  function clearStatus() {
    status.textContent = '';
    status.className = 'county-status';
  }

  async function loadCounties() {
    const response = await fetch('assets/counties.json');
    const counties = await response.json();
    for (const county of counties) {
      const label = `${county.name}, ${county.state}`;
      nameToCounty.set(label, county);
      const option = document.createElement('option');
      option.value = label;
      datalist.appendChild(option);
    }
  }

  async function checkAvailability(countyId) {
    disableClaim();
    setStatus('Checking availability…', false);
    try {
      const response = await fetch(`${API_BASE}/availability/${countyId}`);
      const data = await response.json();
      // Ignore a stale response if the user has since selected a different county.
      if (countyId !== selectedCountyId) return;
      if (!response.ok) {
        setStatus('Could not check availability. Try again.', false);
        return;
      }
      if (data.available) {
        setStatus('Available — this county is unclaimed.', true);
        enableClaim();
      } else {
        setStatus('Already claimed by another subscriber.', false);
      }
    } catch (err) {
      if (countyId !== selectedCountyId) return;
      setStatus('Could not check availability. Try again.', false);
    }
  }

  input.addEventListener('input', () => {
    errorEl.textContent = '';
    const match = nameToCounty.get(input.value);
    if (match) {
      selectedCountyId = match.id;
      checkAvailability(match.id);
    } else {
      selectedCountyId = null;
      disableClaim();
      if (input.value.trim() === '') {
        clearStatus();
      } else {
        setStatus('No matching county — please select one from the list.', false);
      }
    }
  });

  claimBtn.addEventListener('click', async () => {
    if (!selectedCountyId) return;
    disableClaim();
    errorEl.textContent = '';
    try {
      const response = await fetch(`${API_BASE}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ countyId: selectedCountyId }),
      });
      const data = await response.json();
      if (response.ok && data.url) {
        window.location.href = data.url;
        return;
      }
      errorEl.textContent = data.error || 'Something went wrong. Please try again.';
      checkAvailability(selectedCountyId);
    } catch (err) {
      errorEl.textContent = 'Something went wrong. Please try again.';
      enableClaim();
    }
  });

  loadCounties().catch(() => {
    errorEl.textContent = 'Could not load the county list. Please refresh the page.';
  });
})();
