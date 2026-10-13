# Monitor MAV – Cheques y Pagarés

Dashboard estático (HTML + JS) de operaciones negociadas de cheques, pagarés y FCE en MAV.
Adaptado de [imarinione618/Reporte-MAV](https://github.com/imarinione618/Reporte-MAV).

## Datos
- Google Sheet `1xrJOqC7UoFQoyqFErfXFjbLfp2h13K5Tzs7YE1S9uv8`, pestaña `historico` (gid `1748110732`), publicada como CSV.
- Carga automática: API MAV (`cpd-subastas-listado-csv_v2`) c/5 min vía Apps Script.
- Carga manual (respaldo): CSV diario de MAV → carpeta Drive `MAV_entrada` → menú **MAV → Importar CSVs pendientes** (Apps Script `MAV_import.gs`).
- Configuración en `src/app.js` (constantes `SHEET_ID`, `PUB_ID`, `GID`).

## Cambios respecto al original
- Apunta al Sheet propio.
- Tiempo Real lee la pestaña `hoy` (constante `RT_GID`), que el Apps Script actualiza c/5 min vía API MAV.
- Segmento + columna CALIFICADO → "No Garantizado Calificado", etc.
- Sin logo de one618.

## Publicar
Sitio 100% estático: GitHub Pages (Settings → Pages → Deploy from a branch → main / root) o Vercel.
