async function loadUsers(){
  try {
    const res = await fetch('api/users', { credentials:'include' });
    if (!res.ok) {
      alert('No autorizado o error al cargar usuarios');
      return;
    }
    const users = await res.json();
    const el = document.getElementById('usersList');
    el.innerHTML = '';
    (users||[]).forEach(u => {
      const div = document.createElement('div');
      div.className = 'product';
      const activo =
        u.activo === 1 || u.activo === '1' || u.activo === true || u.activo === 'true';
      const statusText = activo ? 'Activo' : 'Inactivo';
      const toggleLabel = activo ? 'Desactivar' : 'Activar';
      const bloqueado =
        u.blocked === 1 || u.blocked === '1' || u.blocked === true || u.blocked === 'true';

      const avatarInner = u.photo_url
        ? `<img class="user-avatar" src="${u.photo_url}" alt="${u.username}">`
        : `<div class="user-avatar placeholder">${(u.username||'U').slice(0,1).toUpperCase()}</div>`;
      div.innerHTML = `
        <div class="user-row">
          <button class="user-avatar-btn" data-id="${u.id}" data-username="${u.username}" data-photo="${u.photo_url || ''}" aria-label="Editar foto de ${u.username}">
            ${avatarInner}
          </button>
          <div>
            <strong>${u.username}</strong>
          <div class="muted">Rol: ${u.rol || u.role || 'user'} · Estado: ${statusText}</div>
          <div class="muted">Intentos fallidos: ${u.failed_attempts ?? 0} · ${bloqueado ? ' Bloqueado' : ' Desbloqueado'}</div>
          </div>
        </div>
        <div class="actions">
          <button class="btn-rol" data-id="${u.id}" data-rol="${u.rol}">Rol</button>
          <button class="btn-activo" data-id="${u.id}" data-activo="${activo ? 1 : 0}">${toggleLabel}</button>
          <button class="btn-bloqueo" data-id="${u.id}" data-bloqueado="${bloqueado ? 1 : 0}">${bloqueado ? 'Desbloquear' : 'Bloquear'}</button>
        </div>
      `;
      el.appendChild(div);
    });

    const quickInput = document.getElementById('quickPhotoInput');
    el.querySelectorAll('.user-avatar-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = Number(btn.getAttribute('data-id'));
        if (!quickInput || !id) return;
        quickInput.setAttribute('data-user-id', String(id));
        quickInput.click();
      });
    });

    el.querySelectorAll('.btn-bloqueo').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = Number(e.currentTarget.getAttribute('data-id'));
        const bloqueado = Number(e.currentTarget.getAttribute('data-bloqueado')) === 1;
        const confirmar = bloqueado ? '¿Desbloquear este usuario?' : '¿Bloquear este usuario?';
        if (!confirm(confirmar)) return;
        try {
          const resp = await fetch('api/user_block', {
            method:'POST',
            credentials:'include',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ id, bloquear: !bloqueado })
          });
          const data = await resp.json();
          if (!resp.ok || !data.ok) throw new Error(data.error || 'Error al actualizar bloqueo');
          alert(bloqueado ? 'Usuario desbloqueado' : 'Usuario bloqueado');
          loadUsers();
        } catch (err) {
          console.error(err);
          alert('Error: ' + err.message);
        }
      });
    });

 
    el.querySelectorAll('.btn-rol').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = Number(e.currentTarget.getAttribute('data-id'));
        const nuevo = prompt('Nuevo rol (admin/superadmin/user/secretaria/enfermeria/medico/cashier/cashierH/cashiee/contabilidad/recepcion/preconsulta/direccionmedica/consultorio2/consultorio3):', 'user');
        if (!nuevo) return;
        try {
          const resp = await fetch('api/users', {
            method:'PUT',
            credentials:'include',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ id, rol: nuevo.toLowerCase().trim() })
          });
          const data = await resp.json();
          if (!resp.ok || data.error) throw new Error(data.error || 'Error al actualizar rol');
          loadUsers();
        } catch (err) {
          alert('Error al actualizar rol: ' + err.message);
        }
      });
    });


    el.querySelectorAll('.btn-activo').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = Number(e.currentTarget.getAttribute('data-id'));
        const activo = Number(e.currentTarget.getAttribute('data-activo')) === 1;
        const nuevo = activo ? 0 : 1;
        try {
          const resp = await fetch('api/users?action=set_active', {
            method:'POST',
            credentials:'include',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ id, activo: nuevo })
          });
          const data = await resp.json();
          if (!resp.ok || data.error) throw new Error(data.error || 'Error al cambiar estado');
          loadUsers();
        } catch (err) {
          alert('Error al cambiar estado: ' + err.message);
        }
      });
    });

  } catch (err) {
    console.error(err);
    alert('Error al cargar usuarios');
  }
}

const backBtn = document.getElementById('backBtn');
if (backBtn) {
  backBtn.addEventListener('click', () => {
    window.location.href = 'inventario.html';
  });
}

const createForm = document.getElementById('createForm');
if (createForm) {
  createForm.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const overlay = document.getElementById('createUserOverlay');
    try { document.body.classList.add('creating-user'); } catch (_) {}
    if (overlay) overlay.setAttribute('aria-hidden', 'false');
    const submitBtn = createForm.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const formData = new FormData(createForm);
      const payload = Object.fromEntries(formData.entries());
      delete payload.photo_url;
      const fileInput = document.getElementById('photoFile');
      if (fileInput && fileInput.files && fileInput.files.length > 0) {
        const up = new FormData();
        up.append('photo', fileInput.files[0]);
        const upResp = await fetch('api/upload_photo', {
          method: 'POST',
          credentials: 'include',
          body: up
        });
        const upData = await upResp.json().catch(()=>({}));
        if (!upResp.ok || !upData.ok) {
          throw new Error(upData.error || 'Error subiendo foto');
        }
        payload.photo_url = upData.url;
      }
      const resp = await fetch('api/users', {
        method:'POST',
        credentials:'include',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(payload)
      });
      const data = await resp.json().catch(()=> ({}));
      if (!resp.ok || data.error) {
        throw new Error(data && data.error ? data.error : 'Error al crear usuario');
      }
      alert(`Usuario creado correctamente.\nContraseña temporal: ${data.password}`);
      createForm.reset();
      loadUsers();
    } catch (err) {
      console.error('create user error', err);
      alert(err.message || 'Error al crear usuario');
    } finally {
      if (submitBtn) submitBtn.disabled = false;
      try { document.body.classList.remove('creating-user'); } catch (_) {}
      if (overlay) overlay.setAttribute('aria-hidden', 'true');
    }
  });
}

loadUsers();

const quickInput = document.getElementById('quickPhotoInput');
if (quickInput) {
  quickInput.addEventListener('change', async () => {
    const id = Number(quickInput.getAttribute('data-user-id') || 0);
    const file = quickInput.files && quickInput.files[0];
    if (!id || !file) return;
    const up = new FormData();
    up.append('photo', file);
    const upResp = await fetch('api/upload_photo', {
      method: 'POST',
      credentials: 'include',
      body: up
    });
    const upData = await upResp.json().catch(() => ({}));
    if (!upResp.ok || !upData.ok) {
      alert(upData.error || 'Error subiendo foto');
      return;
    }
    try {
      const resp = await fetch('api/users', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, photo_url: upData.url })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data.error) throw new Error(data.error || 'Error al actualizar foto');
      quickInput.value = '';
      loadUsers();
    } catch (err) {
      alert(err.message || 'Error al actualizar');
    }
  });
}
