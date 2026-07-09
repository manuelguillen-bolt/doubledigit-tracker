# DoubleDigit — Fleet Agreement Tracker (GitHub Pages)

Dashboard estático del acuerdo con DoubleDigit, a semana vencida. Un GitHub Action lo regenera los lunes (cada hora de 8:00 a 18:00 hora de Madrid) hasta que el ETL tiene la última semana cerrada; solo publica si hay datos nuevos.

## Cómo funciona

```
template.html                  plantilla del dashboard (toda la lógica de niveles y Fleet Bonus vive aquí)
build.js                       consulta Databricks + el sheet Madrid Grouping y genera docs/index.html
docs/index.html                el dashboard publicado (GitHub Pages)
.github/workflows/refresh-dd.yml   cron lunes 06-16 UTC (8:00-18:00 Madrid en verano)
```

Fuentes: `ng_public.etl_partner_data` (actividad), `etl_partner_data_order` (horas pico de respaldo), `conditional_campaigns_*` (Branding Bonus, OH/PH/AR y facturación oficiales de campaña) y el Google Sheet *Madrid Grouping* (columna C = DOUBLEDIGIT define las flotas; altas y bajas se recogen solas en el siguiente build).

Reglas: semanas Lun–Dom asignadas al mes en el que terminan; Branding válido 0/6/8% (otros valores se marcan ⚠); Fleet Bonus = máx(0, 12% N1 / 15% N2 × facturación semanal − Branding); niveles N1 25 OH/15 PH/85 AR y N2 35 OH/25 PH/85 AR.

## Puesta en marcha

1. Crear un repo y subir esta carpeta (`git init && git add -A && git commit -m "DD tracker" && git push`).
2. Settings → Secrets → Actions, crear (los tres primeros son los mismos que usan los otros trackers):
   - `DATABRICKS_HOST` (p. ej. `https://bolt.cloud.databricks.com`)
   - `DATABRICKS_TOKEN`
   - `DATABRICKS_WAREHOUSE_ID`
   - `SHEET_CSV_URL`: en el sheet Madrid Grouping → Archivo → Compartir → Publicar en la web → pestaña de flotas en formato CSV → copiar la URL.
3. Settings → Pages → Deploy from a branch → `main` / carpeta `/docs`.
4. Actions → "Refresh DoubleDigit tracker" → Run workflow (primera ejecución manual para generar `docs/index.html`).

## Notas

- El cron corre en UTC (`0 6-16 * * 1`): 8:00–18:00 Madrid en verano, 7:00–17:00 en invierno.
- `build.js` sale sin escribir si la última semana cerrada aún no tiene actividad o cálculo de campañas; las ejecuciones horarias hacen de reintento.
- Para regenerar a mano: exporta las 4 variables de entorno y `node build.js`.
