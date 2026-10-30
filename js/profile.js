const I18N = (() => {
  if (window.I18N) return window.I18N;
  const STORAGE_KEY = 'app_lang';
  const dict = {
    'Ver perfil': { en: 'View profile' },
    'Cerrar sesión': { en: 'Log out' },
    'Acceso restringido': { en: 'Restricted access' },
    Ajustes: { en: 'Settings' },
    Idioma: { en: 'Language' },
    Español: { en: 'Spanish' },
    Inglés: { en: 'English' },
    Guardar: { en: 'Save' },
    Cancelar: { en: 'Cancel' },
    Cerrar: { en: 'Close' },
    Buscar: { en: 'Search' },
    Volver: { en: 'Back' },
    Agregar: { en: 'Add' },
    Editar: { en: 'Edit' },
    Eliminar: { en: 'Delete' },
    Imprimir: { en: 'Print' },
    Ventas: { en: 'Sales' },
    'Historial de ventas': { en: 'Sales history' },
    'Corte de caja': { en: 'Cash cut' },
    Inventario: { en: 'Inventory' },
    'Productos por vencer': { en: 'Products nearing expiration' },
    'Total próximos a vencer': { en: 'Total nearing expiration' },
    'Todas las sucursales': { en: 'All branches' },
    'Buscar producto o lote': { en: 'Search product or lot' },
    'Nombre, lote, presentación...': { en: 'Name, lot, presentation...' },
    'Nivel de alerta': { en: 'Alert level' },
    'Todas las alertas': { en: 'All alerts' },
    'Alerta 60 días': { en: '60-day alert' },
    'Alerta 30 días': { en: '30-day alert' },
    'Alerta 15 días': { en: '15-day alert' },
    'Se muestran lotes con vencimiento dentro de los próximos 60 días.': { en: 'Lots expiring within the next 60 days are shown.' },
    Vence: { en: 'Expires' },
    'Días restantes': { en: 'Days left' },
    'Cargando productos próximos a vencer...': { en: 'Loading products nearing expiration...' },
    'Sin productos próximos a vencer con ese filtro.': { en: 'No products nearing expiration for this filter.' },
    'Error cargando productos próximos a vencer.': { en: 'Error loading products nearing expiration.' },
    Presentación: { en: 'Presentation' },
    'Principio activo': { en: 'Active ingredient' },
    'Traslado de productos': { en: 'Product transfer' },
    'Historial traslados': { en: 'Transfer history' },
    'Historial de traslados': { en: 'Transfer history' },
    'Historial de Traslados': { en: 'Transfer History' },
    Estado: { en: 'Status' },
    Activo: { en: 'Active' },
    Anulado: { en: 'Cancelled' },
    Anular: { en: 'Cancel transfer' },
    'Motivo de anulación del traslado (opcional):': { en: 'Transfer cancellation reason (optional):' },
    'Error anulando traslado': { en: 'Error cancelling transfer' },
    'Traslado anulado correctamente': { en: 'Transfer cancelled successfully' },
    '¿Desea anular el traslado #{id}? Esto devolverá el stock al origen.': { en: 'Do you want to cancel transfer #{id}? This will return stock to the source.' },
    Solicitante: { en: 'Requester' },
    'Nombre del solicitante': { en: 'Requester name' },
    Desde: { en: 'From' },
    Hasta: { en: 'To' },
    'Últimos traslados.': { en: 'Latest transfers.' },
    'Sin resultados.': { en: 'No results.' },
    'Historial de compras': { en: 'Purchase history' },
    'Registrar compra': { en: 'Register purchase' },
    'Precio de venta': { en: 'Sale price' },
    'Datos de compra inválidos': { en: 'Invalid purchase data' },
    'Ingrese un precio de venta válido': { en: 'Enter a valid sale price' },
    'Devoluciones proveedores': { en: 'Supplier returns' },
    'Número de factura': { en: 'Invoice number' },
    'Buscar': { en: 'Search' },
    'Limpiar': { en: 'Clear' },
    'Nombre proveedor': { en: 'Supplier name' },
    'Nombre producto': { en: 'Product name' },
    'Ej: A-12345': { en: 'Ex: A-12345' },
    'Anulaciones de ventas': { en: 'Sales cancellations' },
    'Anulación de ventas': { en: 'Sales cancellation' },
    'Historial devoluciones': { en: 'Returns history' },
    'Historial de anulaciones': { en: 'Cancellations history' },
    'Hist. Devoluciones venta': { en: 'Sales returns history' },
    Kardex: { en: 'Kardex' },
    Bitácora: { en: 'Logbook' },
    Usuarios: { en: 'Users' },
    Pacientes: { en: 'Patients' },
    Emergencia: { en: 'Emergency' },
    Hospitalización: { en: 'Hospitalization' },
    'Historial pacientes': { en: 'Patient history' },
    'Historial de pacientes': { en: 'Patient history' },
    'Historial INE': { en: 'INE history' },
    INE: { en: 'INE' },
    Contabilidad: { en: 'Accounting' },
    Recepción: { en: 'Reception' },
    Preconsulta: { en: 'Pre-consultation' },
    Médico: { en: 'Doctor' },
    'Turnos / Caja': { en: 'Shifts / Cash' },
    'Ventas / Caja': { en: 'Sales / Cash' },
    'Cobros Hospital / Emergencia': { en: 'Hospital / Emergency Charges' },
    Sucursal: { en: 'Branch' },
    Total: { en: 'Total' },
    Subtotal: { en: 'Subtotal' },
    Cantidad: { en: 'Quantity' },
    Precio: { en: 'Price' },
    Costo: { en: 'Cost' },
    Fecha: { en: 'Date' },
    Solicitante: { en: 'Requester' },
    Origen: { en: 'Source' },
    Destino: { en: 'Destination' },
    Usuario: { en: 'User' },
    Acciones: { en: 'Actions' },
    Comprobante: { en: 'Receipt' },
    'Comprobante de Venta': { en: 'Sales Receipt' },
    'Comprobante de traslado': { en: 'Transfer Receipt' },
    'Ver comprobante': { en: 'View receipt' },
    'Guardar traslado': { en: 'Save transfer' },
    'Abrir Caja': { en: 'Open Cash' },
    'Cerrar Caja': { en: 'Close Cash' },
    'Autorización de administrador': { en: 'Administrator authorization' },
    Validar: { en: 'Validate' },
    'Cobrar documento': { en: 'Charge document' },
    'Cobrar (Efectivo)': { en: 'Charge (Cash)' },
    'Cobros Hospital / Emergencia': { en: 'Hospital / Emergency Charges' },
    'Método de pago': { en: 'Payment method' },
    'Metodo de pago': { en: 'Payment method' },
    Efectivo: { en: 'Cash' },
    Tarjeta: { en: 'Card' },
    Mixto: { en: 'Mixed' },
    'Descuento (%)': { en: 'Discount (%)' },
    'Monto inicial': { en: 'Opening amount' },
    'Monto Final (Q)': { en: 'Final amount (Q)' },
    'Usuario administrador': { en: 'Administrator username' },
    'Contraseña del administrador': { en: 'Administrator password' },
    'Ingrese usuario administrador': { en: 'Enter administrator username' },
    'Ingrese contraseña de administrador': { en: 'Enter administrator password' },
    'Se requiere usuario y contraseña de un administrador para cerrar la caja': {
      en: 'An administrator username and password are required to close the cash register'
    },
    'Se requiere usuario y contraseña de un administrador para continuar': {
      en: 'An administrator username and password are required to continue'
    },
    'Debe autorizar el cierre con un administrador antes de continuar': {
      en: 'You must authorize the cash close with an administrator before continuing'
    },
    'Credenciales de administrador inválidas': { en: 'Invalid administrator credentials' },
    'El usuario ingresado no tiene permisos de administrador': { en: 'The entered user does not have administrator permissions' },
    'La cuenta del administrador está inactiva': { en: 'The administrator account is inactive' },
    'La cuenta del administrador está bloqueada': { en: 'The administrator account is blocked' },
    'Seleccione una sucursal antes de cerrar la caja': { en: 'Select a branch before closing the cash register' },
    'Monto Final': { en: 'Final amount' },
    'Monto Final (conteo)': { en: 'Final count' },
    'Monto Esperado': { en: 'Expected amount' },
    'Total Ventas': { en: 'Total sales' },
    'Total Neto': { en: 'Net total' },
    'Devoluciones de ventas': { en: 'Sales returns' },
    'Anulaciones de ventas': { en: 'Sales cancellations' },
    'Anulación de ventas': { en: 'Sales cancellation' },
    'Historial devoluciones': { en: 'Returns history' },
    'Historial de anulaciones': { en: 'Cancellations history' },
    'Historial de devoluciones': { en: 'Returns history' },
    'Historial de devoluciones venta': { en: 'Sales returns history' },
    'Registrar Compra': { en: 'Register purchase' },
    'Devolución a proveedores': { en: 'Supplier returns' },
    'Devoluciones a proveedores': { en: 'Supplier returns' },
    'Historial de compras': { en: 'Purchase history' },
    'Número de factura': { en: 'Invoice number' },
    'Buscar': { en: 'Search' },
    'Limpiar': { en: 'Clear' },
    'Nombre proveedor': { en: 'Supplier name' },
    'Nombre producto': { en: 'Product name' },
    'Ej: A-12345': { en: 'Ex: A-12345' },
    'Turnos de caja': { en: 'Cash shifts' },
    'Cierre de Caja': { en: 'Cash Close' },
    'Caja cerrada correctamente': { en: 'Cash closed successfully' },
    'Ingrese monto final válido': { en: 'Enter a valid final amount' },
    'No hay caja abierta': { en: 'There is no open cash register' },
    'Error al validar administrador': { en: 'Error validating administrator' },
    'Error al cerrar caja': { en: 'Error closing cash register' },
    'Editar producto': { en: 'Edit product' },
    'Agregar producto': { en: 'Add product' },
    'Buscar producto por nombre, principio activo...': { en: 'Search product by name, active ingredient...' },
    'Escanear código de barras (producto)...': { en: 'Scan barcode (product)...' },
    'Agregar al carrito': { en: 'Add to cart' },
    Carrito: { en: 'Cart' },
    'Carrito vacío': { en: 'Empty cart' },
    'Tipo cliente': { en: 'Client type' },
    'Condición de venta': { en: 'Sale condition' },
    'Monto (Q)': { en: 'Amount (Q)' },
    'Descripción servicio': { en: 'Service description' },
    'Agregar servicio (sin producto)': { en: 'Add service (no product)' },
    Proveedor: { en: 'Supplier' },
    Factura: { en: 'Invoice' },
    Productos: { en: 'Products' },
    'Total unidades': { en: 'Total units' },
    'Ver comprobante': { en: 'View receipt' },
    Paciente: { en: 'Patient' },
    Recibo: { en: 'Receipt' },
    Caja: { en: 'Cash box' },
    Cajero: { en: 'Cashier' },
    'Monto inicial': { en: 'Opening amount' },
    'Monto final': { en: 'Final amount' },
    Diferencia: { en: 'Difference' },
    Estado: { en: 'Status' },
    Buscar: { en: 'Search' },
    'Buscar por nombre': { en: 'Search by name' },
    'Buscar por fecha': { en: 'Search by date' },
    'Fecha inicio': { en: 'Start date' },
    'Fecha fin': { en: 'End date' },
    'Sin resultados': { en: 'No results' },
    'Sin resultados.': { en: 'No results.' },
    'Sin datos.': { en: 'No data.' },
    'Selecciona un proveedor...': { en: 'Select a supplier...' },
    'Seleccionar sucursal': { en: 'Select branch' },
    'Sucursal (cargando...)': { en: 'Branch (loading...)' },
    'Tipo de pago': { en: 'Payment type' },
    'Forma de pago': { en: 'Payment method' },
    Cuotas: { en: 'Installments' },
    Producto: { en: 'Product' },
    'Precio unitario': { en: 'Unit price' },
    '% de ganancia': { en: 'Profit margin %' },
    'Margen de ganancia': { en: 'Profit margin' },
    'Número de lote': { en: 'Lot number' },
    'Fecha de vencimiento': { en: 'Expiration date' },
    'Fecha de vencimiento del lote': { en: 'Lot expiration date' },
    'Seleccione...': { en: 'Select...' },
    'Seleccione una sucursal para listar productos.': { en: 'Select a branch to list products.' },
    'Cargando productos...': { en: 'Loading products...' },
    'No se encontraron productos.': { en: 'No products found.' },
    'Error cargando productos': { en: 'Error loading products' },
    'ID Caja': { en: 'Cash box ID' },
    'Exportar Excel': { en: 'Export Excel' },
    'Volver a Ventas': { en: 'Back to Sales' },
    'Documento (NIT / CUI)': { en: 'Document (NIT / CUI)' },
    'NIT o CUI': { en: 'NIT or CUI' },
    'Número de documento': { en: 'Document number' },
    'Abrir comprobante PDF': { en: 'Open PDF receipt' },
    Abrir: { en: 'Open' },
    'Monto Inicial (Q)': { en: 'Opening Amount (Q)' },
    'Monto a devolver (Q)': { en: 'Amount to return (Q)' },
    'Cliente de la venta': { en: 'Sale customer' },
    'Total de la venta': { en: 'Sale total' },
    'Venta sin producto': { en: 'Sale without product' },
    Servicios: { en: 'Services' },
    Servicio: { en: 'Service' },
    Motivo: { en: 'Reason' },
    'Registrar devolución': { en: 'Register return' },
    'Registrar compra': { en: 'Register purchase' },
    'Registrar depósito': { en: 'Register deposit' },
    'Guardar cuenta': { en: 'Save account' },
    'Guardar partida': { en: 'Save journal entry' },
    'Agregar línea': { en: 'Add line' },
    Generar: { en: 'Generate' },
    Filtrar: { en: 'Filter' },
    Consultar: { en: 'Query' },
    'Cargar venta': { en: 'Load sale' },
    'Cargar compra': { en: 'Load purchase' },
    'Cargue una compra': { en: 'Load a purchase' },
    'Motivo de la devolución (opcional)': { en: 'Return reason (optional)' },
    'Motivo de la devolución (obligatorio)': { en: 'Return reason (required)' },
    'Ej: 123': { en: 'Ex: 123' },
    'Ej: 1203': { en: 'Ex: 1203' },
    'Ej: 80.00': { en: 'Ex: 80.00' },
    'Ej: 2': { en: 'Ex: 2' },
    Opcional: { en: 'Optional' },
    'Seleccione caja': { en: 'Select cash box' },
    'No hay cajas abiertas': { en: 'No open cash boxes' },
    'Cargando...': { en: 'Loading...' }
  };

  const getLang = () => {
    const raw = (localStorage.getItem(STORAGE_KEY) || 'es').toLowerCase();
    return raw.startsWith('en') ? 'en' : 'es';
  };

  const setLang = (lang) => {
    const next = String(lang || 'es').toLowerCase().startsWith('en') ? 'en' : 'es';
    localStorage.setItem(STORAGE_KEY, next);
    document.documentElement.lang = next === 'en' ? 'en' : 'es';
    applyTranslations();
  };

  const t = (key) => {
    const lang = getLang();
    if (!key) return '';
    const entry = dict[key];
    if (!entry) return key;
    if (lang === 'en') return entry.en || key;
    return key;
  };

  const translateAttr = (el, attr, datasetKey) => {
    if (!el) return;
    const current = el.getAttribute(attr);
    if (!current) return;
    if (!el.dataset[datasetKey]) el.dataset[datasetKey] = current;
    el.setAttribute(attr, t(el.dataset[datasetKey]));
  };

  const originalText = new WeakMap();

  const translateTextNode = (node) => {
    const raw = node.nodeValue;
    if (raw == null) return;
    if (!originalText.has(node)) {
      originalText.set(node, raw);
    }
    const base = originalText.get(node);
    const trimmed = String(base || '').trim();
    if (!trimmed) return;
    let entry = dict[trimmed];
    let suffix = '';
    if (!entry && trimmed.endsWith(':')) {
      const core = trimmed.slice(0, -1).trim();
      entry = dict[core];
      suffix = ':';
    }
    if (!entry) {
      if (getLang() === 'es') node.nodeValue = base;
      return;
    }
    if (getLang() === 'en') {
      const translated = (entry.en || trimmed) + suffix;
      node.nodeValue = String(base).replace(trimmed, translated);
    } else {
      node.nodeValue = base;
    }
  };

  const applyTranslations = () => {
    if (document.title) {
      const root = document.documentElement;
      if (!root.dataset.i18nTitleOriginal) root.dataset.i18nTitleOriginal = document.title;
      document.title = t(root.dataset.i18nTitleOriginal);
    }
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (!key) return;
      if (!el.dataset.i18nOriginal) el.dataset.i18nOriginal = key;
      const baseKey = el.dataset.i18nOriginal;
      el.textContent = t(baseKey);
    });
    document.querySelectorAll('[title]').forEach((el) => translateAttr(el, 'title', 'i18nTitleOriginal'));
    document.querySelectorAll('[aria-label]').forEach((el) => translateAttr(el, 'aria-label', 'i18nAriaLabelOriginal'));
    document.querySelectorAll('[alt]').forEach((el) => translateAttr(el, 'alt', 'i18nAltOriginal'));
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const key = el.getAttribute('data-i18n-placeholder');
      if (!key) return;
      if (!el.dataset.i18nPlaceholderOriginal) el.dataset.i18nPlaceholderOriginal = key;
      const baseKey = el.dataset.i18nPlaceholderOriginal;
      el.setAttribute('placeholder', t(baseKey));
    });
    document.querySelectorAll('[placeholder]').forEach((el) => {
      const ph = el.getAttribute('placeholder');
      if (!ph) return;
      if (!el.dataset.i18nPlaceholderOriginal) el.dataset.i18nPlaceholderOriginal = ph;
      const baseKey = el.dataset.i18nPlaceholderOriginal;
      el.setAttribute('placeholder', t(baseKey));
    });
    document.querySelectorAll('input[type="button"], input[type="submit"], input[type="reset"]').forEach((el) => {
      const val = el.value || '';
      if (!val) return;
      if (!el.dataset.i18nValueOriginal) el.dataset.i18nValueOriginal = val;
      const baseKey = el.dataset.i18nValueOriginal;
      el.value = t(baseKey);
    });
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        if (!node.parentElement) return NodeFilter.FILTER_REJECT;
        const tag = node.parentElement.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n = walker.nextNode();
    while (n) {
      translateTextNode(n);
      n = walker.nextNode();
    }
  };

  let observer = null;
  const observe = () => {
    if (observer || !document.body) return;
    observer = new MutationObserver(() => {
      clearTimeout(observe._t);
      observe._t = setTimeout(() => applyTranslations(), 50);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  };

  const extend = (entries) => {
    if (!entries || typeof entries !== 'object') return;
    Object.assign(dict, entries);
    applyTranslations();
  };

  const api = { getLang, setLang, t, applyTranslations, observe, extend };
  window.I18N = api;
  return api;
})();

async function loadProfileIntoHeader() {
  const header = document.querySelector('header.app-header') || document.querySelector('header');
  if (!header) return;
  if (header.querySelector('.profile-pill')) return;
  try {
    const res = await fetch('api/auth_check', { credentials: 'include' });
    const data = await res.json();
    if (!data || !data.ok || !data.user) return;
    const user = data.user;
    const photo = user.photo_url;
    const username = user.username || 'Usuario';
    const role = user.rol || user.role || 'user';

    const pill = document.createElement('div');
    pill.className = 'profile-pill';
    const img = photo
      ? `<img src="${photo}" alt="${username}">`
      : `<div class="user-avatar">${username.slice(0, 1).toUpperCase()}</div>`;
    pill.innerHTML = `
      ${img}
      <div>
        <div>${username}</div>
        <div class="role">${role}</div>
      </div>
      <div class="caret">▾</div>
    `;
    const menu = document.createElement('div');
    menu.className = 'profile-menu';
    menu.innerHTML = `
      <button type="button" class="profile-menu-item" id="profileViewBtn" data-i18n="Ver perfil">Ver perfil</button>
      <button type="button" class="profile-menu-item" id="profileSettingsBtn" data-i18n="Ajustes">Ajustes</button>
      <button type="button" class="profile-menu-item" id="profileLogoutBtn" data-i18n="Cerrar sesión">Cerrar sesión</button>
    `;

    const wrapper = document.createElement('div');
    wrapper.className = 'profile-wrapper';
    wrapper.appendChild(pill);
    wrapper.appendChild(menu);
    header.appendChild(wrapper);

    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      wrapper.classList.toggle('open');
    });
    document.addEventListener('click', () => {
      wrapper.classList.remove('open');
    });

    const logoutBtn = wrapper.querySelector('#profileLogoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        try {
          await fetch('api/logout', { method: 'POST', credentials: 'include' });
        } catch (_) {}
        window.location.href = 'login.html';
      });
    }

    const makeAvatarDataUrl = (label) => {
      const text = (label || 'U').slice(0, 1).toUpperCase();
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="100%" height="100%" fill="#e2e8f0"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="64" fill="#1f2937">${text}</text></svg>`;
      return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    };

    const viewBtn = wrapper.querySelector('#profileViewBtn');
    if (viewBtn) {
      viewBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const modal = document.getElementById('profileModal');
        if (!modal) return;
        const nameEl = modal.querySelector('[data-profile-name]');
        const userEl = modal.querySelector('[data-profile-username]');
        const roleEl = modal.querySelector('[data-profile-role]');
        const photoEl = modal.querySelector('[data-profile-photo]');
        const displayName = user.name || user.username || username;
        if (nameEl) nameEl.textContent = displayName;
        if (userEl) {
          const uname = user.username || '';
          userEl.textContent = uname ? `Usuario: ${uname}` : '';
          userEl.style.display = uname && uname !== displayName ? '' : 'none';
        }
        if (roleEl) roleEl.textContent = role;
        if (photoEl) {
          photoEl.src = photo || makeAvatarDataUrl(username);
          photoEl.style.display = '';
        }
        modal.style.display = 'flex';
      });
    }

    const settingsBtn = wrapper.querySelector('#profileSettingsBtn');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const modal = document.getElementById('settingsModal');
        if (modal) modal.style.display = 'flex';
      });
    }

    // Oculta botones antiguos de cerrar sesión si existen
    document.querySelectorAll('#logoutBtn, #logout, .logoutBtn, .btn-logout').forEach((btn) => {
      btn.style.display = 'none';
    });
    I18N.applyTranslations();
  } catch (_) {}
}

document.addEventListener('click', (e) => {
  const modal = document.getElementById('profileModal');
  if (!modal) return;
  if (e.target && e.target.classList && e.target.classList.contains('profile-menu-item')) {
    return;
  }
  const box = modal.querySelector('.box');
  if (modal.style.display === 'flex' && box && !box.contains(e.target)) {
    modal.style.display = 'none';
  }
});

document.addEventListener('DOMContentLoaded', loadProfileIntoHeader);
document.addEventListener('DOMContentLoaded', () => {
  I18N.applyTranslations();
  I18N.observe();
  document.documentElement.lang = I18N.getLang() === 'en' ? 'en' : 'es';

  if (!document.getElementById('settingsModal')) {
    const modal = document.createElement('div');
    modal.id = 'settingsModal';
    modal.className = 'modal';
    modal.style.display = 'none';
    modal.innerHTML = `
      <div class="box" style="max-width:420px;">
        <h3 style="margin-top:0;" data-i18n="Ajustes">Ajustes</h3>
        <div style="display:flex;flex-direction:column;gap:12px;">
          <label style="font-size:13px;color:#4b5563;" data-i18n="Idioma">Idioma</label>
          <select id="langSelect" style="padding:8px;border:1px solid #cbd5e1;border-radius:8px;">
            <option value="es" data-i18n="Español">Español</option>
            <option value="en" data-i18n="Inglés">Inglés</option>
          </select>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
          <button type="button" class="secondary" id="settingsCloseBtn" data-i18n="Cerrar">Cerrar</button>
          <button type="button" class="primary" id="settingsSaveBtn" data-i18n="Guardar">Guardar</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const select = modal.querySelector('#langSelect');
    if (select) select.value = I18N.getLang();
    const closeBtn = modal.querySelector('#settingsCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', () => (modal.style.display = 'none'));
    const saveBtn = modal.querySelector('#settingsSaveBtn');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const lang = select ? select.value : 'es';
        I18N.setLang(lang);
        modal.style.display = 'none';
      });
    }
    I18N.applyTranslations();
  }
});

// Global "Cargando..." overlay for button clicks
(function setupGlobalLoadingOverlay() {
  const ensureOverlay = () => {
    let overlay = document.querySelector('.global-loading-overlay');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'global-loading-overlay';
    overlay.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;">
        <div class="global-loading-spinner"></div>
        <div class="global-loading-text">Cargando...</div>
      </div>
    `;
    document.body.appendChild(overlay);
    return overlay;
  };

  const showOverlay = () => {
    const overlay = ensureOverlay();
    overlay.classList.add('show');
    clearTimeout(showOverlay._t);
    showOverlay._t = setTimeout(() => {
      overlay.classList.remove('show');
    }, 900);
  };

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button, input[type="submit"]');
    if (!btn) return;
    if (btn.disabled) return;
    if (btn.dataset && btn.dataset.noLoading === 'true') return;
    showOverlay();
  });

  window.addEventListener('pageshow', () => {
    const overlay = document.querySelector('.global-loading-overlay');
    if (overlay) overlay.classList.remove('show');
  });
})();

(function disableBackForward() {
  const lock = () => {
    try {
      history.pushState(null, '', location.href);
      history.pushState(null, '', location.href);
    } catch (_) {}
  };
  lock();
  window.addEventListener('popstate', () => {
    try {
      history.forward();
    } catch (_) {}
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
      try { history.forward(); } catch (_) {}
    }
  });
})();
