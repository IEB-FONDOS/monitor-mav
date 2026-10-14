# Monitor MAV · IEB

Dashboard de cheques, pagarés y FCE negociados en MAV. Sitio estático (GitHub Pages).

**Pestañas**
- **Mercado**: KPIs con variación d/d, curva de tasas por tramo, composición del volumen, mapa de tasas (tramo × categoría o × día), volumen por tramo, top 15 responsables y resumen por categoría de riesgo.
- **En vivo**: rueda del día (se refresca cada 5 min), curva de hoy vs. curva ajustada de ayer, operaciones fuera de curva, intradía y tabla de subastas.
- **Emisores**: perfil de un responsable (hasta 2 comparados): spread vs. mercado por tramo, vencimientos, agentes compradores y detalle de operaciones.
- **Curvas**: nube plazo × TNA con curva ajustada por segmento (TNA = a + b·ln(plazo)), tasas implícitas, evolución diaria y spread NG − Avalado.

**Datos**: Google Sheet publicado (pestañas `historico` y `hoy`), alimentado por Apps Script (`MAV_import.gs`) desde la API de MAV.
Configuración en `src/app.js`: `PUB_ID`, `GID`, `RT_GID`.

**Archivos**: `index.html`, `assets/styles.css`, `src/app.js`. Dependencia: Chart.js 4.4.0 (CDN).
