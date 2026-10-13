# NFC Lealtad

Fideliza a los clientes de restaurantes con **chips NFC**: el cliente apoya su teléfono (iPhone o Android), se registra una sola vez (nombre, WhatsApp, cumpleaños), suma **sellos** en cada visita y el restaurante conserva su base de contactos para enviarle **WhatsApp**: bienvenida, pedido de opinión, cumpleaños, reactivación y campañas.

- **Sin dependencias externas**: solo Node.js ≥ 22.13 (servidor HTTP, SQLite y criptografía integrados). No hay `npm install`.
- Multi-negocio y multi-sucursal (una cadena comparte tarjeta entre locales).
- Todo en español.

## Arranque rápido

```bash
node src/cli.js seed-demo        # crea un negocio de ejemplo con clientes
node src/server.js               # http://localhost:3000
```

Datos de la demo → panel `http://localhost:3000/admin` (`demo@example.com` / `demo-password-123`), personal `http://localhost:3000/o/demo/staff` (PIN `1234`). El enlace del chip se imprime al crear la demo; ábrelo en el navegador para simular el toque.

Negocio real:

```bash
node src/cli.js create-org --slug=mi-restaurante --name="Mi Restaurante" \
  --email=dueno@correo.com --password='una-clave-larga' --pin=4321 --goal=8 \
  --reward="Un postre de regalo" --tz=America/Bogota --cc=57
```

Pruebas: `npm test` (14 pruebas de extremo a extremo).

## Cómo funciona

1. **Toque** → `GET /t/<token>`. Si el teléfono es nuevo, muestra el formulario de registro y guarda la visita en espera; si ya es cliente (cookie del dispositivo), suma el sello.
2. **Registro** → crea al cliente, reclama la visita pendiente (primer sello) y encola el WhatsApp de bienvenida.
3. **Tarjeta** → `/c/<token>`: sellos, premios con código, enlace a opinión y (opcional) botón de Google Wallet.
4. **Mesero/caja** → `/o/<slug>/staff` (PIN): busca por código de premio, teléfono, nombre o número de socio; **canjea premios** (una sola vez) y puede **sumar una visita manual**.
5. **Panel del dueño** → `/admin`: métricas, clientes (CSV), chips, sucursales, campañas, mensajes, opiniones y ajustes.
6. **Automatizaciones** (cada minuto): opinión X min después de la visita, saludo de cumpleaños X días antes, reactivación tras X días sin venir, campañas por segmento.

Reglas que ya incluye: mínimo de horas entre sellos por cliente (anti-abuso), horario de envío (marketing 9–21 h, opinión 8–23 h, hora local del negocio), baja con “BAJA”, consentimiento obligatorio en el registro y reintentos con espera.

## Chips NFC en iPhone y Android

Guía completa: [`docs/NFC-IPHONE-ANDROID.md`](docs/NFC-IPHONE-ANDROID.md). Resumen: etiqueta NTAG213/215 con un registro **URL** apuntando al enlace del chip. iPhone XS/XR o superior (iOS 14+) y casi todos los Android lo leen sin instalar nada.

## Configuración (variables de entorno)

| Variable | Para qué | Por defecto |
|---|---|---|
| `BASE_URL` | URL pública con HTTPS (se usa en enlaces de chips y mensajes) | `http://localhost:3000` |
| `PORT` | Puerto | `3000` |
| `DATA_DIR` / `DB_FILE` | Carpeta de datos / archivo SQLite | `./data` |
| `SESSION_SECRET` | Firma de sesiones y cifrado del token de WhatsApp (≥16 car.) | se genera en `data/.secret` |
| `TRUST_PROXY=1` | Usar `X-Forwarded-For` detrás de un proxy (Caddy/Nginx) | desactivado |
| `OWNER_PASSWORD` | Activa la zona del propietario `/owner` con el botón de respaldo (mín. 12 caracteres) | desactivada |
| `WA_VERIFY_TOKEN`, `WA_APP_SECRET` | Webhook de WhatsApp (bajas) | — |
| `WA_API_VERSION` | Versión de la Graph API | `v21.0` |
| `GOOGLE_WALLET_ISSUER_ID`, `GOOGLE_WALLET_SA_EMAIL`, `GOOGLE_WALLET_SA_KEY` | Google Wallet | — |

## WhatsApp (Cloud API de Meta)

1. Crea la app y el número en Meta for Developers, obtén el **Phone number ID** y un **token permanente**.
2. En `/admin/settings` → WhatsApp: pega ambos (el token se guarda **cifrado** y nunca se vuelve a mostrar).
3. **Plantillas.** WhatsApp solo permite escribir primero a un cliente con **plantillas aprobadas** (fuera de la ventana de 24 h). Crea estas (categoría Utilidad/Marketing, idioma `es`) y regístralas en Ajustes como JSON, p. ej. `{"welcome":{"name":"bienvenida_club","lang":"es"}}`. Orden de los parámetros que envía la app:

| Tipo | Parámetros `{{1}}, {{2}}, …` |
|---|---|
| `welcome` | nombre, negocio, enlace de tarjeta |
| `review` | nombre, negocio, enlace de opinión |
| `birthday` | nombre, negocio, promo, enlace de tarjeta |
| `winback` | nombre, negocio, promo, enlace de tarjeta |
| `link` | nombre, negocio, enlace de tarjeta |
| `campaign` | nombre, texto de la campaña |

   Ejemplo de cuerpo para `birthday`: “🎂 ¡Feliz cumpleaños, {{1}}! En {{2}} queremos celebrarlo contigo: {{3}}. Tu tarjeta: {{4}}. Responde BAJA para no recibir más mensajes.” Si un tipo no tiene plantilla, se envía como texto libre (solo se entrega dentro de la ventana de 24 h).
4. Webhook: apunta Meta a `https://tu-dominio/webhook/whatsapp` con `WA_VERIFY_TOKEN` y `WA_APP_SECRET`; así “BAJA/STOP” da de baja al cliente.

Mientras no conectes WhatsApp, los mensajes se **simulan** (quedan registrados en `/admin/messages`), útil para probar el flujo completo.

## Google Wallet y Apple Wallet

- **Google Wallet**: define las 3 variables y un **logo https** del negocio en Ajustes; la tarjeta mostrará “Agregar a Google Wallet”.
- **Apple Wallet**: **no implementado** (exige certificado de Apple Developer y un servicio de actualización por push). Mientras tanto la tarjeta web funciona en iPhone y se puede guardar en la pantalla de inicio.

## Despliegue

Un único proceso Node con disco persistente (SQLite). Ejemplo en un VPS o servicio con volumen (Fly.io, Railway, Render con disco):

```bash
BASE_URL=https://club.tudominio.com TRUST_PROXY=1 node src/server.js
```

Pon **HTTPS** delante (Caddy: `club.tudominio.com { reverse_proxy localhost:3000 }`). Haz **copias de seguridad** del directorio `data/` (con el servidor detenido o usando `sqlite3 lealtad.db ".backup copia.db"`). No ejecutes dos instancias a la vez.

## Respaldo de la base de datos

1. Define `OWNER_PASSWORD` (mínimo 12 caracteres) en las variables del servidor y vuelve a desplegar.
2. Entra a `https://tu-dominio/owner`, inicia sesión y pulsa **Descargar copia de seguridad**. Se descarga `lealtad-AAAA-MM-DD.db`, una copia coherente (`VACUUM INTO`) aunque haya clientes tocando chips en ese momento.
3. Hazlo con regularidad (por ejemplo, cada semana) y guarda el archivo **fuera** del servidor.

Esta zona es solo para ti como propietario de la plataforma: la copia incluye los datos de **todos** los restaurantes, por eso los administradores de cada negocio no tienen este botón (ellos exportan sus clientes en CSV desde su panel). El archivo contiene datos personales: guárdalo en un lugar privado.

**Restaurar:** con el servidor detenido, reemplaza `lealtad.db` en la carpeta de datos por la copia y borra los archivos `lealtad.db-wal` y `lealtad.db-shm` si existen. Guarda aparte tu `SESSION_SECRET`: sin él no se pueden descifrar los tokens de WhatsApp de la copia.

## Seguridad

Sesiones firmadas (HMAC) con CSRF, contraseñas/PIN con scrypt, límites de intentos, escape de todo HTML, cabeceras CSP/HSTS, token de WhatsApp cifrado en reposo (AES-256-GCM), CSV protegido contra inyección de fórmulas, y un teléfono ya registrado **no** concede acceso a la tarjeta: se envía un enlace al WhatsApp del titular.

## Alcance y límites conocidos

- **Probado**: lógica de negocio, flujo web completo, seguridad, automatizaciones, formato de llamadas a WhatsApp (con API simulada) y firma de Google Wallet — mediante las pruebas automáticas.
- **No probado con servicios reales**: lectura NFC en teléfonos físicos, envío real por WhatsApp Cloud API, Google Wallet y escritura Web NFC; requieren tus credenciales/dispositivos. Los formatos siguen la documentación de cada servicio, pero haz una prueba piloto antes de salir a producción.
- Códigos QR (plan B para teléfonos sin NFC): genera el QR con cualquier herramienta usando el enlace del chip.
- Cumplimiento: pide consentimiento (ya incluido), publica una política de privacidad y revisa la normativa local de datos personales (p. ej. Ley 1581 en Colombia).
- Los números se normalizan con el código de país del negocio; casos especiales (p. ej. móviles de Argentina con “9”) pueden requerir ajuste.
