// Panel de chips: copiar enlace y escribirlo en una etiqueta NFC (Web NFC: solo Chrome en Android, requiere HTTPS).
(function () {
  const status = document.getElementById('nfc-status');
  const say = (t) => { if (status) status.textContent = t; };

  document.querySelectorAll('.copy').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.url); say('Enlace copiado.'); } catch { say('No se pudo copiar; selecciona el enlace manualmente.'); }
  }));

  document.querySelectorAll('.write-nfc').forEach((b) => b.addEventListener('click', async () => {
    if (!('NDEFReader' in window)) {
      say('Este navegador no puede escribir etiquetas NFC. En Android usa Chrome; en iPhone usa la app NFC Tools con el enlace copiado.');
      return;
    }
    try {
      say('Acerca la etiqueta NFC a la parte trasera del teléfono…');
      await new NDEFReader().write({ records: [{ recordType: 'url', data: b.dataset.url }] });
      say('✅ Listo: la etiqueta quedó grabada. Pruébala acercando otro teléfono.');
    } catch (e) {
      say('No se pudo escribir: ' + (e && e.message ? e.message : e));
    }
  }));
})();
