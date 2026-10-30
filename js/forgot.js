document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('forgotForm');
  const msgEl = document.getElementById('msg');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const inputVal = document.getElementById('username').value.trim();
    if (!inputVal) {
      msgEl.style.color = 'red';
      msgEl.innerText = 'Debes ingresar un usuario o correo electrónico';
      return;
    }
    
    const payload = {};
    if (inputVal.includes('@')) {
      payload.email = inputVal;
    } else {
      payload.username = inputVal;
    }
    msgEl.style.color = '#333';
    msgEl.innerText = 'Procesando...';
    try {
      const res = await fetch('api/forgot_password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        
        const enlace = data.link || '';
        msgEl.style.color = 'green';
        if (enlace) {
          msgEl.innerHTML = `Enlace generado. <a href="${enlace}">Restablecer contraseña</a>`;
        } else {
          msgEl.innerText = 'Se ha generado un enlace para restablecer la contraseña. Revisa tu correo.';
        }
      } else {
        msgEl.style.color = 'red';
        msgEl.innerText = data.error || data.message || 'Error al generar el enlace';
      }
    } catch (err) {
      console.error(err);
      msgEl.style.color = 'red';
      msgEl.innerText = 'Error de conexión';
    }
  });
});