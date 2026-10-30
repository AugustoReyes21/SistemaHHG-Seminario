let CART = [];

const $ = (sel) => document.querySelector(sel);

function formatCurrency(value) {
  const n = Number(value || 0);
  return 'Q' + n.toFixed(2);
}

function parseMoney(value) {
  if (value == null) return null;
  let raw = String(value).trim();
  if (!raw) return null;
  raw = raw.replace(/\s/g, '').replace(/[^0-9,.\-]/g, '');
  if (!raw) return null;
  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    if (lastComma > lastDot) {
      raw = raw.replace(/\./g, '').replace(',', '.');
    } else {
      raw = raw.replace(/,/g, '');
    }
  } else if (lastComma !== -1) {
    raw = raw.replace(',', '.');
  }
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function getToken() {
  return localStorage.getItem('token');
}
function getAuthHeaders(extra = {}) {
  const token = getToken();
  const base = { 'Content-Type': 'application/json', ...extra };
  if (token) base['Authorization'] = 'Bearer ' + token;
  return base;
}

async function parseJSON(res) {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('application/json')) return await res.json();
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { throw new Error(txt || 'Respuesta no válida'); }
}

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  window.location.href = 'login.html';
}

async function fetchProductos(q = '') {
  const url = q ? ('api/productos?q=' + encodeURIComponent(q)) : 'api/productos';
  const res = await fetch(url, {
    headers: getAuthHeaders(),
    credentials: 'include'
  });
  if (res.status === 401) { logout(); return []; }
  if (!res.ok) throw new Error('Error al obtener productos');
  const data = await parseJSON(res);
  if (!Array.isArray(data)) throw new Error('Respuesta inválida de productos');
  return data;
}

function renderProductos(items) {
  const lista = $('#lista');
  if (!lista) return;
  lista.innerHTML = '';
  items.forEach(p => {
    const d = document.createElement('div');
    d.className = 'product';
    const casa = p.casa_nombre || p.casa || '';
    const precio = (p.precio_publico != null) ? Number(p.precio_publico) : 0;
    const stock = (p.stock != null) ? p.stock : 0;
    d.innerHTML = `
      <div>
        <strong>${p.nombre_comercial}</strong>
        <div><small>${p.presentacion || ''} - ${p.principio_activo || ''} - ${casa}</small></div>
        <small>Stock: ${stock} | ${formatCurrency(precio)}</small>
      </div>
      <div>
        <button data-id="${p.id}" class="add">Agregar</button>
        <button data-id="${p.id}" class="edit">Editar</button>
        <button data-id="${p.id}" class="del">Eliminar</button>
      </div>`;
    lista.appendChild(d);
  });
}

function renderCart() {
  const cont = $('#cartItems');
  if (!cont) return;
  cont.innerHTML = '';
  let total = 0;
  CART.forEach(it => {
    const pu = Number(it.precio_unit || 0);
    const subtotal = Number(it.cantidad || 0) * pu;
    total += subtotal;
    const div = document.createElement('div');
    div.className = 'cart-item';
    div.innerHTML = `
      <div>${it.nombre} x ${it.cantidad}</div>
      <div>${formatCurrency(subtotal)} <button class="rm" data-id="${it.producto_id}">x</button></div>`;
    cont.appendChild(div);
  });
  const totalEl = $('#cartTotal');
  if (totalEl) totalEl.innerText = formatCurrency(total);
}

function addToCart(prod) {
  const precio = Number(prod.precio_publico || 0);
  const exists = CART.find(x => String(x.producto_id) === String(prod.id));
  if (exists) {
    exists.cantidad += 1;
  } else {
    CART.push({
      producto_id: prod.id,
      nombre: prod.nombre_comercial,
      cantidad: 1,
      precio_unit: precio
    });
  }
  renderCart();
}

async function load(q = '') {
  try {
    const items = await fetchProductos(q);
    renderProductos(items);
  } catch (err) {
    console.error(err);
    alert('No se pudieron cargar los productos');
  }
}

const btnBuscar = $('#buscar');
if (btnBuscar && $('#q')) {
  btnBuscar.addEventListener('click', () => load($('#q').value.trim()));
}
const inputQ = $('#q');
if (inputQ) {
  inputQ.addEventListener('input', (e) => load((e.target.value || '').trim()));
}

const btnNuevo = $('#nuevo');
if (btnNuevo) {
  btnNuevo.addEventListener('click', () => {
    const section = $('#formSection');
    const form = $('#prodForm');
    if (!section || !form) return;
    section.style.display = '';
    form.reset();
    const title = $('#formTitle');
    if (title) title.innerText = 'Nuevo producto';
  });
}

const btnCancel = $('#cancel');
if (btnCancel) {
  btnCancel.addEventListener('click', () => {
    const section = $('#formSection');
    if (section) section.style.display = 'none';
  });
}

const prodForm = $('#prodForm');
if (prodForm) {
  prodForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const obj = Object.fromEntries(fd.entries());
    const url = obj.id ? `api/productos?id=${encodeURIComponent(obj.id)}` : 'api/productos';
    const method = obj.id ? 'PUT' : 'POST';
    try {
      const res = await fetch(url, {
        method,
        headers: getAuthHeaders(),
        credentials: 'include',
        body: JSON.stringify(obj)
      });
      const data = await parseJSON(res).catch(() => ({}));
      if (!res.ok) {
        alert(obj.id ? (data.error || 'Error al actualizar') : (data.error || 'Error al crear'));
        return;
      }
      const section = $('#formSection');
      if (section) section.style.display = 'none';
      load();
    } catch (err) {
      console.error(err);
      alert('Error al guardar producto');
    }
  });
}

const lista = $('#lista');
if (lista) {
  lista.addEventListener('click', async (e) => {
    const t = e.target;
    if (!t || !t.dataset) return;
    const id = t.dataset.id;
    if (!id) return;

    let items = [];
    try { items = await fetchProductos(); } catch(_) {}
    const p = items.find(x => String(x.id) === String(id));

    if (t.matches('.edit') && p) {
      const form = $('#prodForm');
      const section = $('#formSection');
      if (!form || !section) return;
      form.nombre_comercial.value = p.nombre_comercial || '';
      form.presentacion.value     = p.presentacion || '';
      form.principio_activo.value = p.principio_activo || '';
      form.casa.value             = p.casa || p.casa_nombre || '';
      form.expira.value           = p.expira ? String(p.expira).split(' ')[0] : '';
      form.stock.value            = p.stock ?? 0;
      form.precio_costo.value     = p.precio_costo ?? 0;
      form.precio_publico.value   = p.precio_publico ?? 0;
      form.id.value               = p.id;
      section.style.display = '';
      const title = $('#formTitle');
      if (title) title.innerText = 'Editar producto';
      section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    if (t.matches('.del')) {
      if (!confirm('¿Eliminar producto?')) return;
      try {
        const res = await fetch(`api/productos?id=${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: getAuthHeaders(),
          credentials: 'include'
        });
        const data = await parseJSON(res).catch(() => ({}));
        if (!res.ok) {
          alert(data.error || 'Error al eliminar');
          return;
        }
        load();
      } catch (err) {
        console.error(err);
        alert('Error al eliminar');
      }
    }

    if (t.matches('.add') && p) addToCart(p);
  });
}

const cartItems = $('#cartItems');
if (cartItems) {
  cartItems.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.matches('.rm')) {
      const id = t.dataset.id;
      CART = CART.filter(x => String(x.producto_id) !== String(id));
      renderCart();
    }
  });
}

function readPaymentForm() {
  const cands = [
    '#paymentForm', '#payment_method', '#metodoPago', '#metodo',
    'select[name="payment_form"]', 'input[name="payment_form"]:checked'
  ];
  for (const sel of cands) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const v = ('value' in el) ? el.value : (el.getAttribute('value') || '');
    if (v !== '') return v.toLowerCase();
  }
  return 'efectivo';
}
function readPaymentType() {
  const cands = [
    '#paymentType', '#tipoPago', 'select[name="payment_type"]', 'input[name="payment_type"]:checked'
  ];
  for (const sel of cands) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const v = ('value' in el) ? el.value : (el.getAttribute('value') || '');
    if (v !== '') return v.toLowerCase();
  }
  return 'contado';
}

const checkoutBtn = $('#checkoutBtn');
if (checkoutBtn) {
  checkoutBtn.addEventListener('click', async () => {
    if (CART.length === 0) { alert('Carrito vacío'); return; }

    const total = CART.reduce((s, i) => s + (Number(i.cantidad || 0) * Number(i.precio_unit || 0)), 0);
    const payload = {
      items: CART.map(i => ({
        producto_id: i.producto_id,
        cantidad: i.cantidad,
        precio_unit: i.precio_unit
      })),
      total,
      payment_form: readPaymentForm(),
      payment_type: readPaymentType()
    };

    payload.customer_type     = $('#cartCustomerType') ? $('#cartCustomerType').value
                                : ($('#customerType') ? $('#customerType').value : 'consumidor_final');
    payload.customer_document = $('#cartCustomerDocument') ? $('#cartCustomerDocument').value
                                : ($('#customerDocument') ? $('#customerDocument').value : '');
    payload.note              = $('#cartNote') ? $('#cartNote').value : '';
    payload.branch_id         = $('#branchSelect') ? $('#branchSelect').value : null;

    try {
      const res = await fetch('api/checkout', {
        method: 'POST',
        headers: getAuthHeaders(),
        credentials: 'include',
        body: JSON.stringify(payload)
      });

      const data = await parseJSON(res);
      if (!res.ok || !data) {
        alert((data && data.error) ? data.error : 'Error al cobrar');
        return;
      }

      const ventaId = data.venta_id || data.sale_id || data.id || null;
      if (!ventaId) {
        alert('La venta se registró, pero el servidor no devolvió el ID de la venta.');
      }

      CART = [];
      renderCart();
      load();

      const modal = $('#successModal');
      const totalEl = $('#successTotal');
      if (modal && totalEl) {
        totalEl.innerText = `Total: ${formatCurrency(total)}`;
        modal.style.display = 'flex';
        const btnOpen = $('#openPDF');
        if (btnOpen) {
          btnOpen.onclick = () => {
            const lang = (window.I18N && window.I18N.getLang) ? window.I18N.getLang() : (localStorage.getItem('app_lang') || 'es');
            window.open(`api/invoice_print?venta_id=${encodeURIComponent(ventaId || 0)}&lang=${encodeURIComponent(lang)}`, '_blank');
          };
        }
        const btnClose = $('#closeModal');
        if (btnClose) btnClose.onclick = () => { modal.style.display = 'none'; };
      } else {
        if (ventaId) {
          const lang = (window.I18N && window.I18N.getLang) ? window.I18N.getLang() : (localStorage.getItem('app_lang') || 'es');
          window.open(`api/invoice_print?venta_id=${encodeURIComponent(ventaId)}&lang=${encodeURIComponent(lang)}`, '_blank');
        }
      }

    } catch (error) {
      console.error('Error en checkout:', error);
      alert('Error al procesar la venta.');
    }
  });
}

const logoutBtn = $('#logoutBtn');
if (logoutBtn) logoutBtn.addEventListener('click', logout);

const backupBtn = $('#backup');
if (backupBtn) {
  backupBtn.addEventListener('click', async () => {
    const originalText = backupBtn.textContent;
    backupBtn.textContent = 'Generando...';
    backupBtn.disabled = true;
    try {
      const res = await fetch('api/backup', { credentials: 'include' });
      if (!res.ok) {
        const msg = await res.text().catch(() => '');
        alert(msg || 'Error al generar el respaldo');
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition') || '';
      const match = disposition.match(/filename="([^"]+)"/i);
      const filename = match ? match[1] : 'backup.sql';
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      alert('Backup generado y descargado.');
    } catch (err) {
      console.error(err);
      alert('No se pudo generar el backup.');
    } finally {
      backupBtn.textContent = originalText;
      backupBtn.disabled = false;
    }
  });
}

function _cashPanel() {
  return document.querySelector('#detallesCaja, #panelDetallesCaja, .caja-detalles, .card-detalles-caja, #cashDetails, #cashboxDetails') || null;
}
function _q(v){ return 'Q' + Number(v || 0).toFixed(2); }

function mostrarDetallesCaja(caja) {
  const panel = _cashPanel();
  if (!panel) return;

  if (!caja) {
    panel.style.display = '';
    panel.innerHTML = `
      <h3 style="margin:0 0 8px;">Detalles de Caja</h3>
      <p><em>No hay caja abierta</em></p>
    `;
    const btnCerrar = document.querySelector('#btnCerrarCaja, [data-action="cerrar-caja"], .btn-cerrar-caja');
    if (btnCerrar) btnCerrar.style.display = 'none';
    const btnAbrir = document.querySelector('#btnAbrirCaja, [data-action="abrir-caja"], .btn-abrir-caja');
    if (btnAbrir) btnAbrir.style.display = '';
    return;
  }

  const fechaApertura = caja.fecha_apertura || caja.fecha || '';
  const montoInicial  = caja.monto_apertura ?? caja.monto_inicial ?? 0;
  const totalVentas   = caja.total_ventas ?? 0;
  const montoFinal    = (caja.monto_final != null) ? _q(caja.monto_final) : 'Pendiente';

  panel.style.display = '';
  panel.innerHTML = `
    <h3 style="margin:0 0 8px;">Detalles de Caja</h3>
    <p><strong>Fecha Apertura:</strong> ${fechaApertura}</p>
    <p><strong>Monto Inicial:</strong> ${_q(montoInicial)}</p>
    <p><strong>Total Ventas:</strong> ${_q(totalVentas)}</p>
    <p><strong>Monto Final:</strong> ${montoFinal}</p>
  `;
  const btnCerrar = document.querySelector('#btnCerrarCaja, [data-action="cerrar-caja"], .btn-cerrar-caja');
  if (btnCerrar) btnCerrar.style.display = '';
  const btnAbrir = document.querySelector('#btnAbrirCaja, [data-action="abrir-caja"], .btn-abrir-caja');
  if (btnAbrir) btnAbrir.style.display = 'none';
}

async function cerrarCaja(monto_final) {
  const tText = (key) => ((window.I18N && typeof window.I18N.t === 'function') ? window.I18N.t(key) : key);
  const readNumber = (...selectors) => {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const raw = (typeof el.value !== 'undefined') ? el.value : el.textContent;
      const n = parseMoney(raw);
      if (n != null) return n;
    }
    return null;
  };

  try {
    const mf = (monto_final != null)
      ? Number(monto_final)
      : readNumber('#montoCierre', '#monto_final', '[name="monto_cierre"]', '#montoFinal', '.monto-cierre');

    if (mf == null || isNaN(mf)) {
      alert(tText('Ingrese monto final válido'));
      return { ok:false, error:'Monto final inválido' };
    }

    const adminUsername = window.prompt(tText('Ingrese usuario administrador'), '') || '';
    if (!adminUsername.trim()) {
      return { ok:false, error:tText('Ingrese usuario administrador') };
    }
    const adminPassword = window.prompt(tText('Ingrese contraseña de administrador'), '') || '';
    if (!adminPassword) {
      return { ok:false, error:tText('Ingrese contraseña de administrador') };
    }

    const res = await fetch('api/cash_close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ monto_final: mf, admin_username: adminUsername.trim(), admin_password: adminPassword })
    });

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const d = ct.includes('application/json') ? await res.json() : { ok:false, error: await res.text() };
    if (!res.ok || !d || !d.ok) throw new Error((d && d.error) ? d.error : tText('Error al cerrar caja'));

    try { if (typeof CAJA_ABIERTA !== 'undefined') CAJA_ABIERTA = null; } catch(_) {}
    window.__suppressCashPanel = true;
    mostrarDetallesCaja(null);

    if (d.cierre_id) {
      const mfParam = mf != null ? `&monto_final=${encodeURIComponent(mf)}` : '';
      window.open(`api/cierre_pdf?cierre_id=${encodeURIComponent(d.cierre_id)}${mfParam}`, '_blank');
    }

    return { ok:true, cierre_id:d.cierre_id || null, estado:d.estado || null };
  } catch (e) {
    console.error(e);
    return { ok:false, error: e.message || 'Error' };
  }
}

const btnCerrarCaja = document.querySelector('#btnCerrarCaja, [data-action="cerrar-caja"], .btn-cerrar-caja');
if (btnCerrarCaja) btnCerrarCaja.onclick = () => cerrarCaja();

if (typeof CAJA_ABIERTA === 'undefined' || !CAJA_ABIERTA) {
  mostrarDetallesCaja(null);
}

load();
renderCart();
