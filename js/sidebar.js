async function loadSidebar() {
  const isAuthPage = !!document.body.classList.contains('auth');
  if (isAuthPage) return;

    const normalizeRole = (value) => {
      const raw = String(value || '').trim().toLowerCase();
      const map = {
        usuario: 'user',
        user: 'user',
        administrador: 'admin',
        admin: 'admin',
        emergencia: 'cashiee',
        hospital: 'cashierh',
        enfermeria: 'enfermeria',
        'enfermería': 'enfermeria',
        secretaria: 'secretaria',
        medico: 'medico',
        medicos: 'medico',
        'médicos': 'medico'
      };
      return map[raw] || raw;
    };

  const ensureNavTransition = () => {
    if (document.getElementById('navTransitionStyle')) return;
    const style = document.createElement('style');
    style.id = 'navTransitionStyle';
    style.textContent = `
      body.nav-exit { overflow: hidden; }
      .nav-transition-overlay {
        position: fixed;
        inset: 0;
        background:
          radial-gradient(480px 240px at 18% 18%, rgba(34,211,238,0.18), transparent 60%),
          radial-gradient(520px 260px at 82% 80%, rgba(59,130,246,0.16), transparent 62%),
          rgba(2,6,23,0.6);
        opacity: 0;
        pointer-events: none;
        transition: opacity .35s ease;
        z-index: 9999;
      }
      .nav-transition-overlay::before {
        content: '';
        position: absolute;
        left: -20%;
        right: -20%;
        top: 46%;
        height: 90px;
        background:
          linear-gradient(90deg, transparent 0%, rgba(34,211,238,0.85) 50%, transparent 100%);
        mask-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 120' fill='none' stroke='white' stroke-width='8'><path d='M0 60 H140 L170 20 L210 100 L250 60 H380 L420 60 L450 20 L490 100 L530 60 H700 L740 60 L770 20 L810 100 L850 60 H1200'/></svg>");
        mask-size: 1200px 120px;
        mask-repeat: repeat-x;
        opacity: 0;
        transform: translateX(-20%);
        transition: opacity .35s ease;
      }
      body.nav-exit .nav-transition-overlay { opacity: 1; }
      body.nav-exit .nav-transition-overlay::before {
        opacity: 0.6;
        animation: navEcg 0.5s linear forwards;
      }
      @keyframes navEcg {
        from { transform: translateX(-20%); }
        to { transform: translateX(20%); }
      }
    `;
    document.head.appendChild(style);
    const overlay = document.createElement('div');
    overlay.className = 'nav-transition-overlay';
    document.body.appendChild(overlay);
  };
  ensureNavTransition();

  let nav = document.getElementById('sideNav');
  if (!nav) {
    nav = document.createElement('nav');
    nav.id = 'sideNav';
    nav.className = 'side-nav';
    nav.style.display = 'none';
    const ul = document.createElement('ul');
    nav.appendChild(ul);
    document.body.insertBefore(nav, document.body.firstChild);
  }

  const list = nav.querySelector('ul') || nav.appendChild(document.createElement('ul'));

  try {
    const res = await fetch('api/auth_check', { credentials: 'include' });
    const data = await res.json();
    if (!data || !data.ok) return;
    const roleRaw = data.user?.rol || data.user?.role || '';
    const role = normalizeRole(roleRaw);

    let items = [];
    if (role === 'admin' || role === 'administrador') {
      items = [
        { text: 'Inventario', href: 'inventario.html' },
        { text: 'Alertas de stock', href: 'alertas_stock.html' },
        { text: 'Productos por vencer', href: 'productos_vencer.html' },
        { text: 'Mermas por vencimiento', href: 'mermas_vencimiento.html' },
        { text: 'Usuarios', href: 'users.html' },
        { text: 'Registrar compra', href: 'registrar_compra.html' },
        { text: 'Historial de compras', href: 'historial_compras.html' },
        { text: 'Traslado de productos', href: 'traslados.html' },
        { text: 'Historial traslados', href: 'historial_traslados.html' },
        { text: 'Devoluciones proveedores', href: 'devoluciones_proveedores.html' },
        { text: 'Anulación de ventas', href: 'devoluciones_ventas.html' },
        { text: 'Historial de anulaciones', href: 'historial_devoluciones_ventas.html' },
        { text: 'Turnos / Caja', href: 'turnos_caja.html' },
        { text: 'Registros', href: 'registros.html' },
        { text: 'Kardex', href: 'kardex.html' },
        { text: 'Bitácora', href: 'bitacora.html' }
      ];
    } else if (role === 'contabilidad') {
      items = [
        { text: 'Inventario', href: 'inventario.html' },
        { text: 'Productos por vencer', href: 'productos_vencer.html' },
        { text: 'Mermas por vencimiento', href: 'mermas_vencimiento.html' },
        { text: 'Registrar compra', href: 'registrar_compra.html' },
        { text: 'Historial de compras', href: 'historial_compras.html' },
        { text: 'Traslado de productos', href: 'traslados.html' },
        { text: 'Historial traslados', href: 'historial_traslados.html' },
        { text: 'Devoluciones proveedores', href: 'devoluciones_proveedores.html' },
        { text: 'Anulación de ventas', href: 'devoluciones_ventas.html' },
        { text: 'Historial de anulaciones', href: 'historial_devoluciones_ventas.html' },
        { text: 'Turnos / Caja', href: 'turnos_caja.html' },
        { text: 'Registros', href: 'registros.html' },
        { text: 'Kardex', href: 'kardex.html' },
        { text: 'Bitácora', href: 'bitacora.html' }
      ];
    } else if (role === 'farmacia' || role === 'cashier' || role === 'cajero') {
      items = [
        { text: 'Ventas', href: 'ventas.html' },
        { text: 'Historial de ventas', href: 'historial_ventas.html' },
        { text: 'Anulación de ventas', href: 'devoluciones_ventas.html' },
        { text: 'Corte de caja', href: 'corte_caja.html' },
        { text: 'Traslado de productos', href: 'traslados.html' },
        { text: 'Historial traslados', href: 'historial_traslados.html' },
        { text: 'Productos por vencer', href: 'productos_vencer.html' },
        { text: 'Inventario', href: 'inventario.html' }
      ];
    } else if (role === 'cashiee') {
      items = [
        { text: 'Pacientes', href: 'ventas_emergencia.html' },
        { text: 'Historial pacientes', href: 'historial_pacientes.html?area=emergencia' },
        { text: 'Traslado de productos', href: 'traslados.html?mode=eh' },
        { text: 'Productos por vencer', href: 'productos_vencer.html' },
        { text: 'Inventario', href: 'inventario.html?from=emergencia' }
      ];
    } else if (role === 'cashierh') {
      items = [
        { text: 'Hospitalización', href: 'hospitalizacion.html' },
        { text: 'Historial de pacientes', href: 'historial_pacientes.html?area=hospitalizacion' },
        { text: 'Traslado de productos', href: 'traslados.html?mode=eh' },
        { text: 'Productos por vencer', href: 'productos_vencer.html' },
        { text: 'Inventario', href: 'inventario.html' }
      ];
    } else if (role === 'medico') {
      const currentPage = (location.pathname || '').split('/').pop();
      const qs = new URLSearchParams(location.search || '');
      let area = (qs.get('area') || '').toLowerCase();
      const emergencyPages = new Set(['ventas_emergencia.html', 'historial_pacientes.html']);
      const hospitalPages = new Set(['hospitalizacion.html']);
      if (!area) {
        try { area = localStorage.getItem('hhg_medico_area') || ''; } catch (_) {}
      }
      if (!area) {
        if (emergencyPages.has(currentPage)) area = 'emergencia';
        if (hospitalPages.has(currentPage)) area = 'hospitalizacion';
      }
      if (!area) area = 'emergencia';
      try { localStorage.setItem('hhg_medico_area', area); } catch (_) {}
      if (area === 'hospitalizacion') {
        items = [
          { text: 'Cambiar módulo', href: 'medicos.html' },
          { text: 'Hospitalización', href: 'hospitalizacion.html' },
          { text: 'Historial de pacientes', href: 'historial_pacientes.html?area=hospitalizacion' }
        ];
      } else {
        items = [
          { text: 'Cambiar módulo', href: 'medicos.html' },
          { text: 'Pacientes', href: 'ventas_emergencia.html' },
          { text: 'Historial pacientes', href: 'historial_pacientes.html?area=emergencia' }
        ];
      }
    } else if (role === 'secretaria') {
      items = [
        { text: 'INE Emergencia', href: 'emergencia.html' },
        { text: 'Historial INE Emergencia', href: 'historial_ine.html' },
        { text: 'INE Hospitalización', href: 'hospitalizacion_ine_form.html' },
        { text: 'Historial INE Hospitalización', href: 'hospitalizacion_ine.html' }
      ];
    } else if (role === 'user') {
      items = [
        { text: 'Productos por vencer', href: 'productos_vencer.html' },
        { text: 'Inventario', href: 'inventario.html' }
      ];
    } else if (role === 'superadmin') {
      const currentPage = (location.pathname || '').split('/').pop();
      const qs = new URLSearchParams(location.search || '');
      let area = (qs.get('area') || '').toLowerCase();
      if (!area) {
        try {
          area = localStorage.getItem('hhg_super_area') || localStorage.getItem('hhg_nurse_area') || '';
        } catch (_) {}
      }
      const emergencyPages = new Set([
        'ventas_emergencia.html',
        'emergencia.html',
        'historial_ine.html',
        'historial_pacientes.html'
      ]);
      const hospitalPages = new Set([
        'hospitalizacion.html',
        'hospitalizacion_ine_form.html',
        'hospitalizacion_ine.html'
      ]);
      const cashierPages = new Set(['ventas.html', 'historial_ventas.html', 'corte_caja.html']);
      const contabilidadPages = new Set(['contabilidad.html', 'bancos.html', 'registros.html', 'mermas_vencimiento.html']);
      const adminPages = new Set([
        'inventario.html',
        'alertas_stock.html',
        'mermas_vencimiento.html',
        'users.html',
        'registrar_compra.html',
        'historial_compras.html',
        'traslados.html',
        'historial_traslados.html',
        'devoluciones_proveedores.html',
        'devoluciones_ventas.html',
        'historial_devoluciones_ventas.html',
        'turnos_caja.html',
        'registros.html',
        'kardex.html',
        'bitacora.html'
      ]);
      if (emergencyPages.has(currentPage)) area = 'emergencia';
      if (hospitalPages.has(currentPage)) area = 'hospitalizacion';
      if (!area) area = 'admin';
      try { localStorage.setItem('hhg_super_area', area); } catch (_) {}

      if (area === 'emergencia') {
        items = [
          { text: 'Pacientes', href: 'ventas_emergencia.html' },
          { text: 'Historial pacientes', href: 'historial_pacientes.html?area=emergencia' },
          { text: 'Traslado de productos', href: 'traslados.html?mode=eh' },
          { text: 'Productos por vencer', href: 'productos_vencer.html' },
          { text: 'Inventario', href: 'inventario.html?from=emergencia' }
        ];
      } else if (area === 'hospitalizacion') {
        items = [
          { text: 'Hospitalización', href: 'hospitalizacion.html' },
          { text: 'Historial de pacientes', href: 'historial_pacientes.html?area=hospitalizacion' },
          { text: 'Traslado de productos', href: 'traslados.html?mode=eh' },
          { text: 'Productos por vencer', href: 'productos_vencer.html' },
          { text: 'Inventario', href: 'inventario.html' }
        ];
      } else if (cashierPages.has(currentPage)) {
        items = [
          { text: 'Ventas', href: 'ventas.html' },
          { text: 'Historial de ventas', href: 'historial_ventas.html' },
          { text: 'Corte de caja', href: 'corte_caja.html' },
          { text: 'Productos por vencer', href: 'productos_vencer.html' },
          { text: 'Inventario', href: 'inventario.html' }
        ];
      } else if (area === 'contabilidad' || contabilidadPages.has(currentPage)) {
        items = [
          { text: 'Inventario', href: 'inventario.html' },
          { text: 'Productos por vencer', href: 'productos_vencer.html' },
          { text: 'Mermas por vencimiento', href: 'mermas_vencimiento.html' },
          { text: 'Registrar compra', href: 'registrar_compra.html' },
          { text: 'Historial de compras', href: 'historial_compras.html' },
          { text: 'Traslado de productos', href: 'traslados.html' },
          { text: 'Historial traslados', href: 'historial_traslados.html' },
          { text: 'Devoluciones proveedores', href: 'devoluciones_proveedores.html' },
          { text: 'Anulación de ventas', href: 'devoluciones_ventas.html' },
          { text: 'Historial de anulaciones', href: 'historial_devoluciones_ventas.html' },
          { text: 'Turnos / Caja', href: 'turnos_caja.html' },
          { text: 'Registros', href: 'registros.html' },
          { text: 'Kardex', href: 'kardex.html' },
          { text: 'Bitácora', href: 'bitacora.html' }
        ];
      } else if (adminPages.has(currentPage)) {
        items = [
          { text: 'Inventario', href: 'inventario.html' },
          { text: 'Alertas de stock', href: 'alertas_stock.html' },
          { text: 'Productos por vencer', href: 'productos_vencer.html' },
          { text: 'Mermas por vencimiento', href: 'mermas_vencimiento.html' },
          { text: 'Usuarios', href: 'users.html' },
          { text: 'Registrar compra', href: 'registrar_compra.html' },
          { text: 'Historial de compras', href: 'historial_compras.html' },
          { text: 'Traslado de productos', href: 'traslados.html' },
          { text: 'Historial traslados', href: 'historial_traslados.html' },
          { text: 'Devoluciones proveedores', href: 'devoluciones_proveedores.html' },
          { text: 'Anulación de ventas', href: 'devoluciones_ventas.html' },
          { text: 'Historial de anulaciones', href: 'historial_devoluciones_ventas.html' },
          { text: 'Turnos / Caja', href: 'turnos_caja.html' },
          { text: 'Registros', href: 'registros.html' },
          { text: 'Kardex', href: 'kardex.html' },
          { text: 'Bitácora', href: 'bitacora.html' }
        ];
      } else {
        items = [
          { text: 'Inventario', href: 'inventario.html' },
          { text: 'Alertas de stock', href: 'alertas_stock.html' },
          { text: 'Productos por vencer', href: 'productos_vencer.html' },
          { text: 'Mermas por vencimiento', href: 'mermas_vencimiento.html' },
          { text: 'Usuarios', href: 'users.html' },
          { text: 'Registrar compra', href: 'registrar_compra.html' },
          { text: 'Historial de compras', href: 'historial_compras.html' },
          { text: 'Traslado de productos', href: 'traslados.html' },
          { text: 'Historial traslados', href: 'historial_traslados.html' },
          { text: 'Devoluciones proveedores', href: 'devoluciones_proveedores.html' },
          { text: 'Anulación de ventas', href: 'devoluciones_ventas.html' },
          { text: 'Historial de anulaciones', href: 'historial_devoluciones_ventas.html' },
          { text: 'Turnos / Caja', href: 'turnos_caja.html' },
          { text: 'Registros', href: 'registros.html' },
          { text: 'Kardex', href: 'kardex.html' },
          { text: 'Bitácora', href: 'bitacora.html' }
        ];
      }
      if (items.length) {
        items.unshift({ text: 'Cambiar módulo', href: 'superadmin.html' });
      }
    } else if (role === 'enfermeria') {
      const currentPage = (location.pathname || '').split('/').pop();
      const qs = new URLSearchParams(location.search || '');
      const areaParam = (qs.get('area') || '').toLowerCase();
      const emergencyPages = new Set([
        'ventas_emergencia.html',
        'emergencia.html',
        'historial_ine.html',
        'historial_pacientes.html'
      ]);
      const hospitalPages = new Set([
        'hospitalizacion.html',
        'hospitalizacion_ine_form.html',
        'hospitalizacion_ine.html'
      ]);
      let area = areaParam;
      if (!area) {
        try { area = localStorage.getItem('hhg_nurse_area') || ''; } catch (_) {}
      }
      if (!area) {
        if (emergencyPages.has(currentPage)) area = 'emergencia';
        if (hospitalPages.has(currentPage)) area = 'hospitalizacion';
      }
      if (!area) area = 'emergencia';
      try { localStorage.setItem('hhg_nurse_area', area); } catch (_) {}
      if (area === 'hospitalizacion') {
        items = [
          { text: 'Cambiar módulo', href: 'enfermeria.html' },
          { text: 'Hospitalización', href: 'hospitalizacion.html' },
          { text: 'Historial de pacientes', href: 'historial_pacientes.html?area=hospitalizacion' },
          { text: 'Traslado de productos', href: 'traslados.html?mode=eh&area=hospitalizacion' },
          { text: 'Productos por vencer', href: 'productos_vencer.html' },
          { text: 'Inventario', href: 'inventario.html' }
        ];
      } else {
        items = [
          { text: 'Cambiar módulo', href: 'enfermeria.html' },
          { text: 'Pacientes', href: 'ventas_emergencia.html' },
          { text: 'Historial pacientes', href: 'historial_pacientes.html?area=emergencia' },
          { text: 'Traslado de productos', href: 'traslados.html?mode=eh&area=emergencia' },
          { text: 'Productos por vencer', href: 'productos_vencer.html' },
          { text: 'Inventario', href: 'inventario.html?from=emergencia' }
        ];
      }
    }

    if (!items.length) return;

    const current = (location.pathname || '').split('/').pop();
    list.innerHTML = '';
    items.forEach((item) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.textContent = item.text;
      a.setAttribute('data-i18n', item.text);
      a.href = item.href;
      if (item.target) {
        a.target = item.target;
        a.rel = 'noopener';
      }
      if (!item.href.startsWith('api/') && current === item.href) a.classList.add('active');
      a.addEventListener('click', (e) => {
        if (a.target === '_blank') return;
        if (a.href.startsWith('api/')) return;
        const same = a.getAttribute('href') === current;
        if (same) return;
        e.preventDefault();
        document.body.classList.add('nav-exit');
        setTimeout(() => {
          window.location.href = a.href;
        }, 320);
      });
      li.appendChild(a);
      list.appendChild(li);
    });

    if (window.I18N && typeof window.I18N.applyTranslations === 'function') {
      window.I18N.applyTranslations();
    }

    nav.style.display = 'block';
    document.body.style.marginLeft = '220px';
  } catch (_) {}
}

document.addEventListener('DOMContentLoaded', loadSidebar);
