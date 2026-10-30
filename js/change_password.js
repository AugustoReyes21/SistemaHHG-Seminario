document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const username = params.get('user') || params.get('username') || '';
  const token = params.get('token') || '';
  const form = document.getElementById('changeForm');
  const msgEl = document.getElementById('msg');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newPass = document.getElementById('newPass').value;
    const confirmPass = document.getElementById('confirmPass').value;
    if (newPass !== confirmPass) {
      msgEl.innerText = 'Las contraseñas no coinciden';
      return;
    }
    if (!username || !token) {
      msgEl.innerText = 'Faltan parámetros para restablecer';
      return;
    }
    try {
      const res = await fetch('api/change_password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, token: token, new_password: newPass })
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        alert('Contraseña actualizada. Inicie sesión con su nueva contraseña.');
        window.location.href = 'login.html';
      } else {
        msgEl.innerText = data.error || 'Error al actualizar la contraseña';
      }
    } catch (err) {
      console.error(err);
      msgEl.innerText = 'Error de conexión';
    }
  });
});