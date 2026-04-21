const pricing = {
  ro:   { monthly: { price: '$20', sub: 'per month', billing: 'monthly' }, annual: { price: '$220', sub: 'per year ($18.33/mo)', billing: 'annual' } },
  full: { monthly: { price: '$40', sub: 'per month', billing: 'monthly' }, annual: { price: '$440', sub: 'per year ($36.67/mo)', billing: 'annual' } }
};
const selected = { ro: 'monthly', full: 'monthly' };

function setPrice(tier, billing, btn) {
  selected[tier] = billing;
  const p = pricing[tier][billing];
  document.getElementById(tier+'-price').textContent = p.price;
  document.getElementById(tier+'-sub').textContent = p.sub;
  btn.closest('.price-toggle').querySelectorAll('.ptab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

async function doCheckout(tier) {
  const urlId   = tier === 'full' ? 'full-url'   : 'ro-url';
  const emailId = tier === 'full' ? 'full-email' : 'ro-email';
  const btnId   = 'btn-' + tier;
  const urlEl   = document.getElementById(urlId);
  const emailEl = document.getElementById(emailId);
  const btn     = document.getElementById(btnId);
  if (!urlEl || !emailEl) { alert('Form fields not found. Please refresh the page.'); return; }
  const instanceUrl = urlEl.value.trim() || 'https://login.salesforce.com';
  const email = emailEl.value.trim();
  if (!email) { alert('Please enter your email address.'); return; }
  const billing = selected[tier === 'full' ? 'full' : 'ro'];
  btn.textContent = 'Checking...';
  btn.disabled = true;
  try {
    const res = await fetch('/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier, billing, instance_url: instanceUrl, email })
    });
    const data = await res.json();
    if (data.tier_mismatch) {
      alert(data.message);
      window.location.href = '/manage';
    } else if (data.already_subscribed) {
      window.location.href = '/oauth/start?tier=' + data.tier + '&instance_url=' + encodeURIComponent(data.instance_url || 'https://login.salesforce.com') + '&email=' + encodeURIComponent(email);
    } else if (data.url) {
      window.location.href = data.url;
    } else {
      alert('Error: ' + (data.error || 'Unknown error'));
      btn.textContent = 'Get started';
      btn.disabled = false;
    }
  } catch(err) {
    alert('Error: ' + err.message);
    btn.textContent = 'Get started';
    btn.disabled = false;
  }
}
