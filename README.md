# SistemaHHG — Seminario de Tecnologías de Información

Sistema web de farmacia, inventario por lotes, caja, contabilidad y hospitalización
del Proyecto de Graduación. Esta versión incorpora dos aportes para el curso de Seminario:

| # | Aporte | Área del curso | Riesgo que atiende |
|---|--------|----------------|--------------------|
| 1 | **Idempotencia y contrato en `POST /api/register_sale`** | APIs REST: contratos, validación e idempotencia | Ventas duplicadas (doble cobro y doble descuento de stock) cuando la respuesta se pierde por la red y el cajero vuelve a cobrar |
| 2 | **Pruebas de integración con PostgreSQL real** | Pruebas automatizadas (unitarias e integración con dependencias reales) | El flujo de venta (FEFO, transacciones, bloqueos, idempotencia) no tenía ninguna verificación automatizada |

**Versión entregada:** etiqueta `v1.0-seminario`. El commit `Versión base del Proyecto de Graduación`
contiene el sistema tal como estaba antes del curso; los commits siguientes son lo desarrollado en Seminario.

## Requisitos

- Node.js 22 o superior (probado con 22 y 24)
- Docker Desktop (para PostgreSQL 16 de desarrollo y de pruebas)

## Instalación y ejecución local

```bash
npm install
cp .env.development.example .env      # configuración local sin secretos
docker compose up -d --wait db        # PostgreSQL 16 en :5432 con pos_retail.sql
npm run migrate                       # aplica migrations/*.sql (también se aplican al arrancar)
node scripts/seed-demo.js             # usuario demo / Demo2026! (rol cajero) y medicamentos de prueba
npm start                             # http://127.0.0.1:3000/login.html
```

Para producción se usa `.env.example` como plantilla (HTTPS, cookies seguras, SMTP, FEL).
Ningún archivo `.env` real, certificado, factura, avatar ni log se versiona.

## Verificación del Aporte 2 (pruebas)

```bash
npm run db:test:up        # PostgreSQL desechable en :5433 (tmpfs)
npm test                  # 6 unitarias + 23 de integración
npm run test:report       # además genera test-results/junit.xml
```

Cada archivo de integración borra y recrea el esquema (`pos_retail.sql` + arranque del servidor),
y cada caso vacía las tablas, así el estado inicial siempre es el mismo. Por seguridad,
`tests/setup-env.js` se niega a correr si el nombre de la base no contiene `test`.

En GitHub Actions (`.github/workflows/tests.yml`) la misma suite corre en cada push y pull request
con un servicio `postgres:16` y publica el reporte JUnit como artefacto.

**Demostrar que las pruebas detectan defectos:** en `evidencias/defectos/` hay parches que rompen el
sistema a propósito. Se aplican, se corre la suite y se revierten:

```bash
git apply evidencias/defectos/01-fefo-invertido.patch      # vende primero el lote que vence después
npm run test:integration                                   # -> falla "descuenta primero el lote que vence antes"
git apply -R evidencias/defectos/01-fefo-invertido.patch
```

| Parche | Defecto | Pruebas que lo detectan |
|--------|---------|-------------------------|
| `01-fefo-invertido.patch` | Orden FEFO invertido | 1 (FEFO) |
| `02-sin-idempotencia.patch` | Ruta sin middleware de idempotencia | 10 (reintentos, contrato, recuperación) |
| `03-sin-bloqueo-de-lote.patch` | Sin `FOR UPDATE` al leer lotes | 1 (concurrencia) |

Resultados guardados en `evidencias/defectos/resultados.txt` y `evidencias/resultados-pruebas.txt`.

## Verificación del Aporte 1 (idempotencia)

Con el servidor corriendo y la base de demo cargada:

```bash
node scripts/demo-idempotencia.js     # misma venta x3, 5 envíos simultáneos, 422, 400 y 409
node scripts/medir-latencia.js        # costo: 60 ventas sin llave, con llave y repetidas
```

Medición local (`evidencias/medicion-latencia.txt`): mediana 406 ms sin llave, 429 ms con llave y 16 ms
en una repetición (no vuelve a ejecutar la venta).

Salida esperada de la demo (ver `evidencias/demo-idempotencia.txt`): tres intentos con la misma llave devuelven
la misma venta (`HTTP 200 (repetida)`), cinco envíos simultáneos crean una sola venta y el resto recibe
409; al final hay +2 ventas y −3 unidades.

**En el navegador:** inicie sesión como `demo`, abra caja, agregue un medicamento y cobre. En DevTools →
Network, clic derecho sobre `register_sale` → *Replay XHR*: la respuesta trae `Idempotent-Replayed: true`
y el Historial de ventas sigue mostrando una sola venta.

**Respuesta perdida en la interfaz real** (requiere Edge o Chrome):

```bash
npm i --no-save puppeteer-core@23
node evidencias/ui-respuesta-perdida.js
```

Corta la primera respuesta *después* de que el servidor registró la venta, el cajero vuelve a cobrar y
la base sigue con una sola venta. Capturas en `evidencias/capturas/`.

### Contrato

`docs/api/register_sale.openapi.yaml` (OpenAPI 3.0) describe el encabezado `Idempotency-Key`,
las respuestas y los códigos de error:

| Situación | Respuesta |
|-----------|-----------|
| Llave nueva | Se ejecuta la venta → `200 {venta_id}` |
| Misma llave + mismo cuerpo | `200` con la respuesta original y `Idempotent-Replayed: true` |
| Misma llave, primera aún en proceso | `409 IDEMPOTENCY_IN_PROGRESS` + `Retry-After` |
| Misma llave + cuerpo distinto | `422 IDEMPOTENCY_KEY_REUSED` |
| Llave mal formada | `400 IDEMPOTENCY_KEY_INVALID` |
| Stock insuficiente / lote no disponible | `409 INSUFFICIENT_STOCK` / `OUT_OF_STOCK` (antes 500) |
| Efectivo menor al total | `422 CASH_INSUFFICIENT` (antes 500) |
| Sin encabezado | Comportamiento anterior (compatibilidad) |

## Archivos por aporte

**Aporte 1 — Idempotencia y contrato**

- `server/middleware/idempotency.js` — reserva atómica, repetición, 409/422, liberación en error
- `server/utils/idempotency.js` — validación de llave y hash SHA-256 del cuerpo canónico
- `migrations/001_idempotency_keys.sql` — tabla `idempotency_keys` (UNIQUE, CHECK, FK)
- `server/utils/migrations.js` — aplica migraciones versionadas (`schema_migrations`)
- `server/routes/sales.js` — ruta `/register_sale`: middleware, `markCommitted` dentro de la transacción, errores 409/422
- `server/utils/httpError.js` y manejador de errores en `server/app.js`
- `ventas.html` — `prepareSaleAttempt()`: una llave por intento, reenvío del mismo cuerpo al reintentar
- `docs/api/register_sale.openapi.yaml`, `scripts/demo-idempotencia.js`, `scripts/medir-latencia.js`, `scripts/seed-demo.js`

**Aporte 2 — Pruebas de integración**

- `tests/integration/register-sale.test.js` — FEFO, lotes vencidos, rollback, caja, comprobante, 401, concurrencia
- `tests/integration/idempotency.test.js` — reintentos, simultaneidad, contrato, caída, expiración
- `tests/unit/idempotency-utils.test.js` — funciones puras
- `tests/helpers/db.js`, `tests/setup-env.js` — esquema real, datos semilla, sesión JWT
- `server/app.js` — `createApp()` separado de `index.js` para probar sin abrir puerto
- `server/utils/dbMaintenance.js` — corrige dos defectos de instalaciones nuevas que detectaron las pruebas: la primera venta se colgaba (esquema contable creado dentro de la transacción) y dos primeras ventas simultáneas fallaban con 500 (índices creados durante la venta)
- `docker-compose.yml` (`db-test`), `.env.test.example`, `.github/workflows/tests.yml`
- `evidencias/` — resultados, defectos introducidos, capturas

## Diagramas

Fuentes editables en Mermaid (`docs/diagramas/*.mmd`) y su PNG:
arquitectura, modelo de datos, secuencia de la venta, estados de la llave y flujo de verificación.
Se editan en <https://mermaid.live> o con `npx @mermaid-js/mermaid-cli -i archivo.mmd -o archivo.png`.

## Estructura general

```
server/        API Express (app.js, index.js, routes/, middleware/, utils/)
migrations/    cambios de esquema versionados (nuevo)
tests/         pruebas unitarias e integración (nuevo)
docs/          contrato OpenAPI y diagramas (nuevo)
evidencias/    resultados de verificación (nuevo)
*.html, js/    interfaz web
pos_retail.sql esquema base PostgreSQL
```
