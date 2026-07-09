#!/usr/bin/env node
/* Construye docs/index.html del DoubleDigit Fleet Agreement Tracker.
 *
 * - Lee la lista de flotas del Google Sheet "Madrid Grouping" (SHEET_CSV_URL,
 *   URL de "Publicar en la web" en formato CSV): filas con columna C = DOUBLEDIGIT.
 * - Consulta Databricks (REST SQL) con las mismas queries validadas del tracker:
 *   actividad (etl_partner_data), horas pico (etl_partner_data_order) y campañas
 *   CarBranding (conditional_campaigns_*).
 * - Solo semanas CERRADAS (a semana vencida). Si la última semana cerrada aún no
 *   tiene datos en el ETL/campañas, sale sin escribir: el cron reintenta cada hora.
 * - Embebe los datos crudos en template.html -> docs/index.html. Toda la lógica de
 *   niveles y Fleet Bonus vive en el HTML (idéntica al artifact de Cowork).
 *
 * Secrets/env: DATABRICKS_HOST  DATABRICKS_TOKEN  DATABRICKS_WAREHOUSE_ID  SHEET_CSV_URL
 */
"use strict";
const fs = require("fs");
const path = require("path");

const HOST = (process.env.DATABRICKS_HOST || "").replace(/\/$/, "");
const TOKEN = process.env.DATABRICKS_TOKEN || "";
const WAREHOUSE = process.env.DATABRICKS_WAREHOUSE_ID || "";
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || "";
if (!HOST || !TOKEN || !WAREHOUSE || !SHEET_CSV_URL) {
  console.error("Faltan env vars: DATABRICKS_HOST, DATABRICKS_TOKEN, DATABRICKS_WAREHOUSE_ID, SHEET_CSV_URL");
  process.exit(1);
}

const ROOT = __dirname;
const FIRST_MONTH = "2026-05"; // primer mes del acuerdo mostrado

const PD = "main.ng_public.etl_partner_data";
const PDO = "main.ng_public.etl_partner_data_order";
const NG = "main.ng_public";
// Ventanas pico según la campaña CarBranding. DAYOFWEEK: 1=Dom..7=Sáb
const PEAK_CASE = "(DAYOFWEEK(created_hour_local) IN (2,3,4) AND (HOUR(created_hour_local) BETWEEN 7 AND 9 OR HOUR(created_hour_local) BETWEEN 17 AND 19)) OR (DAYOFWEEK(created_hour_local)=5 AND (HOUR(created_hour_local) BETWEEN 7 AND 9 OR HOUR(created_hour_local) BETWEEN 17 AND 23)) OR (DAYOFWEEK(created_hour_local)=6 AND (HOUR(created_hour_local) BETWEEN 0 AND 1 OR HOUR(created_hour_local) BETWEEN 7 AND 9 OR HOUR(created_hour_local) BETWEEN 13 AND 23)) OR (DAYOFWEEK(created_hour_local) IN (1,7) AND (HOUR(created_hour_local) BETWEEN 0 AND 6 OR HOUR(created_hour_local) BETWEEN 11 AND 23))";
const CXL = "p.client_cancelled_after_accepted_tries+p.client_cancelled_after_arrived_tries+p.client_cancelled_after_pickup_tries+p.client_noshows_tries+p.payment_booking_fails_tries";

// ---------- Databricks REST ----------
async function runSql(query) {
  let res = await fetch(`${HOST}/api/2.0/sql/statements`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ warehouse_id: WAREHOUSE, statement: query, wait_timeout: "50s", format: "JSON_ARRAY" }),
  }).then(r => r.json());
  while (res.status && ["PENDING", "RUNNING"].includes(res.status.state)) {
    await new Promise(r => setTimeout(r, 2500));
    res = await fetch(`${HOST}/api/2.0/sql/statements/${res.statement_id}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }).then(r => r.json());
  }
  if (!res.status || res.status.state !== "SUCCEEDED") {
    throw new Error("SQL falló: " + JSON.stringify(res.status || res).slice(0, 400));
  }
  const cols = res.manifest.schema.columns.map(c => c.name);
  return (res.result && res.result.data_array || []).map(v => Object.fromEntries(cols.map((c, i) => [c, v[i]])));
}

// ---------- Google Sheet ----------
function csvRows(text) {
  const rows = []; let row = [], cur = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += ch; }
    else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cur); cur = ""; rows.push(row); row = []; }
    else cur += ch;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
async function loadFleets() {
  const csv = await fetch(SHEET_CSV_URL).then(r => { if (!r.ok) throw new Error("Sheet CSV HTTP " + r.status); return r.text(); });
  const map = {};
  csvRows(csv).forEach(c => {
    if (c.length < 3) return;
    const raw = String(c[1]).trim();
    if (!/^\d+$/.test(raw)) return;
    if (String(c[2]).trim().toUpperCase().replace(/\s+/g, "") === "DOUBLEDIGIT") {
      map[parseInt(raw, 10)] = String(c[0]).replace(/^(OLD\s+\+?)?Madrid\s*Fleet\s*/i, "").trim() || ("#" + raw);
    }
  });
  return map;
}

// ---------- fechas (UTC-safe, semanas Lun-Dom que TERMINAN en el mes) ----------
const D = (y, m, d) => new Date(Date.UTC(y, m, d));
const iso = d => d.toISOString().slice(0, 10);
const addD = (d, n) => new Date(d.getTime() + n * 86400000);
function isoWeek(d) { const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const dn = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - dn + 3); const f = new Date(Date.UTC(t.getUTCFullYear(), 0, 4)); return 1 + Math.round(((t - f) / 86400000 - 3 + ((f.getUTCDay() + 6) % 7)) / 7); }
const MES = ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"];
function madridToday() {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const [y, m, d] = p.split("-").map(Number);
  return D(y, m - 1, d);
}
function closedWeeksFor(ym, today) {
  const [y, m] = ym.split("-").map(Number);
  const first = D(y, m - 1, 1), last = D(y, m, 0);
  let mon = addD(first, -((first.getUTCDay() + 6) % 7));
  const out = [];
  while (true) {
    const sun = addD(mon, 6);
    if (sun > last) break;
    if (sun >= first && sun < today) { // solo semanas CERRADAS
      out.push({ start: iso(mon), end: iso(sun), label: "W" + isoWeek(mon) + " · " + mon.getUTCDate() + " " + MES[mon.getUTCMonth()] });
    }
    mon = addD(mon, 7);
  }
  return out;
}
function monthRange(ym) { const [y, m] = ym.split("-").map(Number); return { s: iso(D(y, m - 1, 1)), e: iso(D(y, m, 0)) }; }
function prevYm(ym) { const [y, m] = ym.split("-").map(Number); return m === 1 ? (y - 1) + "-12" : y + "-" + String(m - 1).padStart(2, "0"); }
function monthList(today) {
  const cur = iso(today).slice(0, 7);
  const out = []; let [y, m] = FIRST_MONTH.split("-").map(Number);
  while (true) {
    const ym = y + "-" + String(m).padStart(2, "0");
    if (ym > cur) break;
    out.push(ym);
    m++; if (m > 12) { m = 1; y++; }
    if (out.length > 48) break;
  }
  return out;
}

// ---------- queries ----------
function campQuery(inIds, preS, spanE) {
  return `WITH calc AS (
    SELECT pe.target_id id,
      CAST(CONVERT_TIMEZONE('Europe/Madrid', pe.start) AS DATE) wk,
      bc.condition_id,
      MAX(fc.reg_number) c_reg,
      MAX(fc.company_id) c_cid,
      MAX(CASE WHEN b.id IS NOT NULL AND COALESCE(b.state,'') NOT IN ('cancelled','failed') THEN CAST(GET_JSON_OBJECT(b.earning,'$.amount') AS DOUBLE) END) amt,
      MAX(CASE WHEN b.id IS NOT NULL AND COALESCE(b.state,'') NOT IN ('cancelled','failed') THEN CAST(GET_JSON_OBJECT(cond.bonus,'$.value.bonus.percentage') AS DOUBLE) END) pct,
      MAX(CAST(GET_JSON_OBJECT(bc.calculation_state,'$.online_hours') AS DOUBLE)) c_oh,
      MAX(CAST(GET_JSON_OBJECT(bc.calculation_state,'$.online_hours_during_peak_hours') AS DOUBLE)) c_ph,
      MAX(CAST(GET_JSON_OBJECT(bc.calculation_state,'$.acceptance_rate') AS DOUBLE)) c_ar,
      MAX(AGGREGATE(TRANSFORM(REGEXP_EXTRACT_ALL(bc.calculation_state,'"total_trip_price":\\\\s*([0-9.]+)',1), x -> CAST(x AS DOUBLE)), CAST(0 AS DOUBLE), (a,x) -> a+x)) c_gmv
    FROM ${NG}.conditional_campaigns_period_enrollment pe
    JOIN ${NG}.conditional_campaigns_campaign camp ON pe.campaign_id=camp.id AND camp.name LIKE '%CarBranding%'
    JOIN ${NG}.fleet_car fc ON pe.target_id=fc.id AND fc.company_id IN (${inIds})
    JOIN ${NG}.conditional_campaigns_bonus_calculation bc ON bc.period_enrollment_id=pe.id
    LEFT JOIN ${NG}.conditional_campaigns_condition cond ON bc.condition_id=cond.id
    LEFT JOIN ${NG}.conditional_campaigns_bonus b ON bc.bonus_id=b.id
    WHERE pe.target_type='car'
      AND pe.start >= TIMESTAMP'${preS} 00:00:00' - INTERVAL 1 DAY
      AND pe.start < TIMESTAMP'${spanE} 00:00:00'
    GROUP BY 1,2,3
  )
  SELECT id, wk,
    MAX(c_reg) reg, MAX(c_cid) cid,
    ROUND(SUM(COALESCE(amt,0)),2) brand_amt,
    ROUND(SUM(COALESCE(pct,0)),1) brand_pct,
    ROUND(MAX(c_oh),1) c_oh, ROUND(MAX(c_ph),1) c_ph, ROUND(MAX(c_ar)*100,0) c_ar, ROUND(MAX(c_gmv),2) c_gmv
  FROM calc GROUP BY 1,2 LIMIT 5000`;
}

async function fetchMonth(ym, inIds, today) {
  const wks = closedWeeksFor(ym, today);
  if (!wks.length) return null;
  const spanS = wks[0].start, spanE = wks[wks.length - 1].end;
  const preS = iso(addD(new Date(spanS + "T00:00:00Z"), -7));
  const mr = monthRange(ym), pr = monthRange(prevYm(ym));
  const [cw, pk, camp, cm, dm, dp, pa] = await Promise.all([
    runSql(`SELECT p.driver_car_id id, MAX(c.reg_number) reg, p.company_id cid, CAST(DATE_TRUNC('week',p.created_date_local) AS DATE) wk, ROUND(SUM((p.has_order+p.waiting_orders)/60.0),1) oh, ROUND(SUM(p.has_order/60.0),1) busy, ROUND(SUM(p.gmv_eur),2) gmv, SUM(p.finished_rides) rides, SUM(p.accepted_orders_tries) acc, SUM(${CXL}) cxl FROM ${PD} p LEFT JOIN ${NG}.fleet_car c ON p.driver_car_id=c.id WHERE p.company_id IN (${inIds}) AND p.driver_car_id > 0 AND p.created_date_local BETWEEN '${preS}' AND '${spanE}' GROUP BY 1,3,4 LIMIT 5000`),
    runSql(`SELECT driver_car_id id, CAST(DATE_TRUNC('week',CAST(created_hour_local AS DATE)) AS DATE) wk, ROUND(SUM(CASE WHEN ${PEAK_CASE} THEN has_order+waiting_orders ELSE 0 END)/60.0,1) peak FROM ${PDO} WHERE company_id IN (${inIds}) AND driver_car_id > 0 AND created_hour_local >= '${preS}' AND created_hour_local < DATE_ADD(DATE'${spanE}',1) GROUP BY 1,2 LIMIT 5000`),
    runSql(campQuery(inIds, preS, spanE)),
    runSql(`SELECT p.driver_car_id id, MAX(c.reg_number) reg, p.company_id cid, ROUND(SUM((p.has_order+p.waiting_orders)/60.0),1) oh, ROUND(SUM(p.has_order/60.0),1) busy, ROUND(SUM(p.gmv_eur),2) gmv, SUM(p.finished_rides) rides FROM ${PD} p LEFT JOIN ${NG}.fleet_car c ON p.driver_car_id=c.id WHERE p.company_id IN (${inIds}) AND p.driver_car_id > 0 AND p.created_date_local BETWEEN '${mr.s}' AND '${mr.e}' GROUP BY 1,3 LIMIT 5000`),
    runSql(`SELECT p.driver_id id, MAX(COALESCE(NULLIF(TRIM(CONCAT_WS(' ',d.first_name,d.last_name)),''),d.display_name)) name, MAX(p.company_id) cid, ROUND(SUM(p.gmv_eur),2) gmv, ROUND(SUM((p.has_order+p.waiting_orders)/60.0),1) oh, ROUND(SUM(p.has_order/60.0),1) busy, SUM(p.finished_rides) rides, SUM(p.accepted_orders_tries) acc, SUM(${CXL}) cxl FROM ${PD} p LEFT JOIN ${NG}.vw_fleet_driver d ON d.target_id=p.driver_id AND d.company_id=p.company_id WHERE p.company_id IN (${inIds}) AND p.created_date_local BETWEEN '${mr.s}' AND '${mr.e}' GROUP BY 1 LIMIT 2000`),
    runSql(`SELECT driver_id id, ROUND(SUM(CASE WHEN ${PEAK_CASE} THEN has_order+waiting_orders ELSE 0 END)/60.0,1) peak FROM ${PDO} WHERE company_id IN (${inIds}) AND created_hour_local >= '${mr.s}' AND created_hour_local < DATE_ADD(DATE'${mr.e}',1) GROUP BY 1 LIMIT 2000`),
    runSql(`SELECT ROUND(SUM(gmv_eur),2) gmv, ROUND(SUM((has_order+waiting_orders)/60.0),1) oh, ROUND(SUM(has_order/60.0),1) busy, SUM(finished_rides) rides, COUNT(DISTINCT CASE WHEN finished_rides>0 THEN driver_car_id END) active FROM ${PD} WHERE company_id IN (${inIds}) AND driver_car_id > 0 AND created_date_local BETWEEN '${pr.s}' AND '${pr.e}' LIMIT 10`),
  ]);
  return { wks, preS, cw, pk, camp, cm, dm, dp, pa };
}

// ---------- main ----------
(async () => {
  const today = madridToday();
  const fleets = await loadFleets();
  const ids = Object.keys(fleets);
  if (!ids.length) { console.error("El sheet no tiene filas con FO=DOUBLEDIGIT"); process.exit(1); }
  console.log(`Flotas DD: ${ids.length}`);
  const inIds = ids.join(",");

  const months = {};
  for (const ym of monthList(today)) {
    process.stdout.write(`Mes ${ym}… `);
    const M = await fetchMonth(ym, inIds, today);
    if (!M) { console.log("sin semanas cerradas, omitido"); continue; }
    months[ym] = M;
    console.log(`${M.wks.length} semanas · ${M.cw.length} filas coche-semana · ${M.camp.length} filas campaña`);
  }
  const ymList = Object.keys(months).sort();
  if (!ymList.length) { console.error("Sin meses con semanas cerradas"); process.exit(1); }

  // Frescura: la última semana cerrada debe tener actividad Y cálculo de campaña.
  const lastYm = ymList[ymList.length - 1];
  const lastM = months[lastYm];
  const lastWk = lastM.wks[lastM.wks.length - 1].start;
  const okEtl = lastM.cw.some(r => r.wk === lastWk);
  const okCamp = lastM.camp.some(r => r.wk === lastWk);
  if (!okEtl || !okCamp) {
    console.log(`La semana ${lastWk} aún no está completa en el ETL (actividad: ${okEtl}, campañas: ${okCamp}). No escribo; el cron reintentará.`);
    process.exit(0);
  }

  const buildTs = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", dateStyle: "medium", timeStyle: "short" }).format(new Date());
  const data = { fleets, months };
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const tpl = fs.readFileSync(path.join(ROOT, "template.html"), "utf8");
  const html = tpl.replace("__DD_DATA__", json).replace("__BUILD_TS__", buildTs);
  fs.mkdirSync(path.join(ROOT, "docs"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "docs", "index.html"), html);
  console.log(`OK: docs/index.html (${(html.length / 1024).toFixed(0)} KB) · última semana ${lastWk} · ${buildTs}`);
})().catch(e => { console.error(e); process.exit(1); });
