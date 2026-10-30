document.getElementById('loginForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const res = await fetch('api/login', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    credentials: 'include',
    body: JSON.stringify({username,password})
  });
  const data = await res.json();
  if (res.ok) {
    const rawRole = ((data && data.user && (data.user.rol || data.user.role)) || '').toString().trim().toLowerCase();
    let role = rawRole;
    
    if (!role) role = 'user';
    if (role.includes('recep')) role = 'recepcion';
    if (role.includes('pre') && role.includes('consulta')) role = 'preconsulta';
    if (role.includes('direc')) role = 'direccionmedica';
    if (role.includes('consultorio2')) role = 'consultorio2';
    if (role.includes('consultorio3')) role = 'consultorio3';
    if (role !== 'direccionmedica' && role !== 'consultorio2' && role !== 'consultorio3' && role.includes('medic')) role = 'medico';
    if (role.includes('enfer')) role = 'enfermeria';
    if (role.includes('secret')) role = 'secretaria';
    if (role.includes('super')) role = 'superadmin';
    if (role.includes('emerg')) role = 'cashiee';

    const map = {
      'enfermeria': 'enfermeria.html',
      'secretaria': 'emergencia.html',
      'superadmin': 'superadmin.html',
      'cashiee': 'ventas_emergencia.html',
      'cashier': 'ventas.html',
      'farmacia': 'ventas.html',
      'cashierh': 'inventario.html', 
      'contabilidad': 'contabilidad.html',
      'recepcion': 'recepcion.html',
      'preconsulta': 'preconsulta.html',
      'medico': 'medicos.html',
      'direccionmedica': 'medico.html',
      'consultorio2': 'medico.html',
      'consultorio3': 'medico.html'
    };
    const dest = map[role] || 'inventario.html';
    try {
      document.body.classList.add('login-exit');
    } catch (_) {}
    setTimeout(() => {
      window.location.href = dest;
    }, 650);
  } else {
    if (data && data.cambio) {
      const token = data.token || '';
      const user = data.username || username;
      alert('Debe cambiar su contraseña antes de continuar.');
      window.location.href = `change_password.html?user=${encodeURIComponent(user)}&token=${encodeURIComponent(token)}`;
      return;
    }
    document.getElementById('msg').innerText = data.error || 'Error';
  }
});
