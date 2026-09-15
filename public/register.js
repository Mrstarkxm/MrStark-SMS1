const form = document.getElementById('registerForm');
const errorBox = document.getElementById('error');
const submitBtn = document.getElementById('submitBtn');
const adminSelect = document.getElementById('adminId');

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.add('show');
}

async function loadAdmins() {
  try {
    const res = await fetch('/api/public/admins');
    const data = await res.json();
    adminSelect.innerHTML = '';
    if (!data.admins || data.admins.length === 0) {
      adminSelect.innerHTML = '<option value="">No admins available yet</option>';
      submitBtn.disabled = true;
      return;
    }
    adminSelect.innerHTML =
      '<option value="">-- Select an admin --</option>' +
      data.admins.map(a => `<option value="${a.id}">${a.username}</option>`).join('');
  } catch (e) {
    adminSelect.innerHTML = '<option value="">Could not load admins</option>';
  }
}
loadAdmins();

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorBox.classList.remove('show');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating account...';

  const payload = {
    adminId: adminSelect.value,
    username: document.getElementById('username').value.trim(),
    email: document.getElementById('email').value.trim(),
    password: document.getElementById('password').value,
  };

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      showError(data.error || 'Registration failed');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create Account';
      return;
    }
    window.location.href = '/dashboard';
  } catch (err) {
    showError('Network error. Please try again.');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Account';
  }
});
