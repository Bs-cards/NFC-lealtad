# Chips NFC con iPhone y Android

La app **no necesita instalarse en el teléfono del cliente**: cada chip NFC guarda una dirección web (`https://tu-dominio/t/XXXX`). Al acercar el teléfono, el sistema operativo abre esa página en el navegador. Eso funciona igual en iPhone y Android.

## 1. Qué comprar

| Qué | Recomendación |
|---|---|
| Etiqueta/chip | **NTAG213** (suficiente para una URL) o **NTAG215/216** (más memoria). Formato sticker, llavero o tarjeta PVC. |
| Sobre metal (caja registradora, soporte metálico) | Etiquetas **anti-metal** (con capa de ferrita); las normales no leen. |
| Cantidad | 1 chip por punto de toque (caja, cada mesa o el llavero del mesero). Todos pueden apuntar al mismo negocio. |

## 2. Cómo grabar el enlace en el chip

1. En el panel (`/admin/chips`) crea un chip. Verás su enlace único.
2. Grábalo como registro **NDEF → URL/URI** (no como texto):
   - **Android + Chrome:** botón **“Escribir en chip”** del panel (usa Web NFC; requiere que el panel esté en HTTPS). Acerca la etiqueta al teléfono.
   - **iPhone o Android (cualquiera):** app gratuita **NFC Tools** → *Escribir → Añadir un registro → URL/URI* → pega el enlace → *Escribir* → acerca la etiqueta.
3. **Pruébalo** con otro teléfono antes de pegarlo.
4. Opcional: bloquear en solo lectura (NFC Tools → *Otros → Bloquear etiqueta*). **Es irreversible**; hazlo solo cuando estés seguro de que el enlace es el definitivo.

> Si cambias de dominio, hay que regrabar los chips. Usa un dominio propio y estable desde el principio.

## 3. Cómo lo lee el teléfono del cliente

| | iPhone | Android |
|---|---|---|
| Modelos | **iPhone XS / XR y posteriores** con iOS 14+ leen etiquetas NDEF **sin abrir ninguna app**. iPhone 7/8/X necesitan activar el lector desde el Centro de control o usar el código QR. | Prácticamente todos los modelos con NFC. |
| Requisitos | Pantalla encendida y desbloqueada. | NFC activado en Ajustes y pantalla desbloqueada. |
| Qué ocurre | Aparece una notificación emergente “Abrir en Safari”; al tocarla se abre la tarjeta. | Se abre directamente en el navegador. |
| Zona de lectura | Parte **superior trasera** del teléfono. | Normalmente el **centro/superior trasero** (varía por modelo). |

Para el mesero/cajero: indica al cliente “acerca la parte de arriba del teléfono al llavero”. La primera vez verá el formulario (nombre, WhatsApp, cumpleaños); desde la segunda, solo apoya y el sello se suma solo.

## 4. Plan B: código QR

Para teléfonos sin NFC o iPhone antiguos, imprime un **código QR con el mismo enlace del chip** (cualquier generador gratuito). Funciona igual que el toque.

## 5. Probar sin hardware

Abre en el navegador el enlace del chip (`/t/XXXX`). Es exactamente lo que abre el teléfono al leer el chip. Usa ventana privada para simular un cliente nuevo.

## 6. Convertirlo en app nativa (opcional, más adelante)

El enfoque web cubre el caso completo. Si más adelante quieres una app en tiendas, se puede envolver esta misma web con **Capacitor** o hacer una app Flutter/React Native que llame a la misma API; solo haría falta si necesitas funciones nativas (por ejemplo, que el **mesero lea el chip del cliente** con su propia app, o notificaciones push). Para eso hay que añadir una API JSON; el modelo de datos ya lo soporta.
