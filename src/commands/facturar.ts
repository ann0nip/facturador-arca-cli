/**
 * `facturar <monto> [template] [opciones]` — el comando principal.
 *
 * Flujo: parsear → autenticar (WSAA local) → cotización si hace falta →
 * PREVIEW con confirmación → emitir (WSFE) → log local → PDF.
 *
 * Patrón de errores heredado del bot: la emisión es irreversible. Si algo
 * falla DESPUÉS del CAE (log, PDF), se avisa explícito y fuerte — nunca en
 * silencio.
 */

import fs from "node:fs";
import path from "node:path";

import * as p from "@clack/prompts";
import pc from "picocolors";

import { valor } from "./comun.js";
import {
  type Doc,
  type Fecha,
  type Moneda,
  type Receptor,
  CONCEPTO_DESC,
  CONDICIONES_IVA,
  DOC_TIPO_CF,
  FACTURA_C,
  RECEPTOR_CF,
  SIMBOLO_MONEDA,
  descripcionReceptor,
  fechaToIso,
  fmtArs,
  fmtDoc,
  fmtFecha,
  hoyAr,
  cmpFecha,
  nombreComprobante,
  numeroCompleto,
  parsearDoc,
  parsearFecha,
  parsearMonto,
  parsearPeriodo,
  usaPeriodo,
  validarFecha,
} from "../core/domain.js";
import { obtenerTicket } from "../core/wsaa.js";
import { type EmisionParams, cotizacionOficial, emitirComprobante } from "../core/wsfe.js";
import { generarPdf } from "../core/pdf.js";
import { registrarComprobante, totalFacturado12m } from "../core/store.js";
import {
  type Template,
  cargarConfig,
  cargarTemplate,
  listarTemplates,
  validarEmisor,
  wsaaCacheDir,
} from "../config.js";

interface Opciones {
  template?: Template;
  docAdHoc?: Doc;
  fecha?: Fecha;
  periodo?: [Fecha, Fecha];
  vto?: Fecha;
  detalle?: string;
  cotizacion?: number;
  moneda?: Moneda;
  sinConfirmar: boolean;
}

/** Parsea flags y posicionales. Lanza Error con mensaje para el usuario. */
function parsearArgs(resto: string[]): Opciones {
  const op: Opciones = { sinConfirmar: false };

  const necesita = (flag: string, v: string | undefined): string => {
    if (v === undefined) throw new Error(`El flag ${flag} necesita un valor.`);
    return v;
  };

  for (let i = 0; i < resto.length; i++) {
    const a = resto[i];
    switch (a) {
      case "--fecha": {
        const f = parsearFecha(necesita(a, resto[++i]));
        if (f === null) throw new Error("No entendí la fecha. Ej: --fecha 26/06");
        op.fecha = f;
        break;
      }
      case "--periodo": {
        const per = parsearPeriodo(necesita(a, resto[++i]));
        if (per === null) throw new Error("No entendí el período. Ej: --periodo 01/06-30/06");
        op.periodo = per;
        break;
      }
      case "--vto": {
        const f = parsearFecha(necesita(a, resto[++i]));
        if (f === null) throw new Error("No entendí el vencimiento. Ej: --vto 10/07");
        op.vto = f;
        break;
      }
      case "--detalle":
      case "-d":
        op.detalle = necesita(a, resto[++i]);
        break;
      case "--cotizacion": {
        const c = Number(necesita(a, resto[++i]).replace(",", "."));
        if (!Number.isFinite(c) || c <= 0) throw new Error("Cotización inválida. Ej: --cotizacion 1461");
        op.cotizacion = c;
        break;
      }
      case "--moneda": {
        const m = necesita(a, resto[++i]).toUpperCase();
        if (m !== "PES" && m !== "DOL") throw new Error("Moneda inválida: usá PES o DOL.");
        op.moneda = m;
        break;
      }
      case "--si":
      case "-y":
        op.sinConfirmar = true;
        break;
      default: {
        if (a.startsWith("-")) throw new Error(`Flag desconocido: ${a} (ver facturar --help)`);
        // posicionales: CUIT/DNI, período, fecha o nombre de template
        const doc = parsearDoc(a);
        if (doc !== null) {
          op.docAdHoc = doc;
          break;
        }
        const per = parsearPeriodo(a);
        if (per !== null) {
          op.periodo = per;
          break;
        }
        const f = parsearFecha(a);
        if (f !== null) {
          op.fecha = f;
          break;
        }
        const t = cargarTemplate(a);
        if (t === null) {
          const nombres = listarTemplates().map((x) => x.nombre);
          throw new Error(
            `No existe el template «${a}».` +
              (nombres.length
                ? ` Los que hay: ${nombres.join(", ")}.`
                : ` Creá uno con: facturar template add ${a}`)
          );
        }
        op.template = t;
      }
    }
  }

  if (op.template && op.docAdHoc) {
    throw new Error("Elegí una cosa: template O un CUIT/DNI suelto (no los dos).");
  }
  return op;
}

export async function cmdFacturar(montoTexto: string, resto: string[]): Promise<void> {
  const monto = parsearMonto(montoTexto);

  const config = cargarConfig();
  if (config === null) {
    console.error(pc.red("Todavía no hay configuración. Empezá por: facturar init"));
    process.exitCode = 1;
    return;
  }
  const problemas = validarEmisor(config);
  if (problemas.length > 0) {
    console.error(pc.red("La configuración está incompleta:"));
    for (const e of problemas) console.error(pc.red(`  · ${e}`));
    console.error("Corré facturar init de nuevo, o editá el config.json a mano.");
    process.exitCode = 1;
    return;
  }

  const op = parsearArgs(resto);
  const t = op.template;

  // --- reglas de fechas ------------------------------------------------------
  const fecha = op.fecha ?? hoyAr();
  const errorFecha = validarFecha(fecha, config.concepto);
  if (errorFecha) throw new Error(errorFecha);
  if (!usaPeriodo(config.concepto) && (op.periodo || op.vto)) {
    throw new Error(
      "Esta instancia factura productos (concepto 1): no existe el período de servicio ni el vto. de pago."
    );
  }
  if (op.vto && cmpFecha(op.vto, fecha) < 0) {
    throw new Error("El vencimiento de pago no puede ser anterior a la fecha de emisión.");
  }

  // --- receptor ----------------------------------------------------------------
  let receptor: Receptor;
  if (t) {
    receptor = t.receptor ?? RECEPTOR_CF;
  } else if (op.docAdHoc) {
    p.intro("🧾 facturar");
    const condIva = valor(
      await p.select({
        message: `${fmtDoc(op.docAdHoc.docTipo, op.docAdHoc.docNro)} — ¿condición frente al IVA del receptor?`,
        options: [1, 6, 4, 15, 5].map((c) => ({ value: c, label: CONDICIONES_IVA[c] })),
      })
    );
    receptor = { ...op.docAdHoc, condIva };
  } else {
    receptor = RECEPTOR_CF;
  }

  const moneda: Moneda = op.moneda ?? t?.moneda ?? "PES";
  const sim = SIMBOLO_MONEDA[moneda];
  const descripcion = op.detalle ?? t?.descripcion ?? config.descripcionDefault ?? "Servicios";

  // --- autenticación + cotización -------------------------------------------------
  const certPem = fs.readFileSync(config.certPath, "utf8");
  const keyPem = fs.readFileSync(config.keyPath, "utf8");

  const sp = p.spinner();
  sp.start(`Autenticando con ARCA${config.produccion ? "" : " (homologación)"}`);
  let auth;
  try {
    const ticket = await obtenerTicket({
      certPem,
      keyPem,
      produccion: config.produccion,
      cacheDir: wsaaCacheDir(),
    });
    auth = { token: ticket.token, sign: ticket.sign, cuit: config.cuit };
    sp.stop("Autenticado ✓");
  } catch (e) {
    sp.stop(pc.red("Falló la autenticación"));
    throw e;
  }

  let cotizacion = 1;
  if (moneda !== "PES") {
    if (op.cotizacion) {
      cotizacion = op.cotizacion;
    } else {
      sp.start("Consultando la cotización oficial");
      try {
        const r = await cotizacionOficial(auth, config.produccion, moneda);
        cotizacion = r.cotizacion;
        sp.stop(
          `Cotización oficial ${moneda}: $ ${fmtArs(cotizacion)}` +
            (r.fechaCotiz ? ` (del ${fmtFecha(r.fechaCotiz)})` : "")
        );
      } catch (e) {
        sp.stop(pc.red("No pude traer la cotización"));
        throw e;
      }
    }
  }

  // --- preview -----------------------------------------------------------------
  const montoPesos = Math.round(monto * cotizacion * 100) / 100;
  const lineas: string[] = [
    `Factura C — ${CONCEPTO_DESC[config.concepto]}`,
    `Receptor: ${t?.razonSocial ? `${t.razonSocial} — ` : ""}${descripcionReceptor(receptor)}`,
    `Total: ${sim} ${fmtArs(monto)}` +
      (moneda !== "PES" ? `  (≈ $ ${fmtArs(montoPesos)} al cambio ${cotizacion})` : ""),
    `Detalle: ${descripcion}`,
    `Fecha: ${fmtFecha(fecha)}${cmpFecha(fecha, hoyAr()) === 0 ? " (hoy)" : ""}`,
  ];
  if (usaPeriodo(config.concepto)) {
    lineas.push(
      op.periodo
        ? `Período: ${fmtFecha(op.periodo[0])} al ${fmtFecha(op.periodo[1])}`
        : "Período: = fecha de emisión"
    );
    lineas.push(`Vto. de pago: ${fmtFecha(op.vto ?? fecha)}`);
  }
  const condicionVenta = t?.condicionVenta;
  if (condicionVenta) lineas.push(`Condición de venta: ${condicionVenta}`);
  if (config.umbralCf && receptor.docTipo === DOC_TIPO_CF && montoPesos >= config.umbralCf) {
    lineas.push(
      "",
      pc.red(
        `🛑 OJO: $ ${fmtArs(montoPesos)} alcanza el umbral de $ ${fmtArs(config.umbralCf)} — ` +
          `a consumidor final ANÓNIMO no se puede: identificá al receptor (CUIT/DNI).`
      )
    );
  }
  p.note(
    lineas.join("\n"),
    config.produccion
      ? pc.red("🔴 PRODUCCIÓN — la factura va a ser REAL")
      : "⚠️ MODO PRÁCTICA (homologación) — no es real"
  );

  if (!op.sinConfirmar) {
    const ok = valor(await p.confirm({ message: "¿Confirmás la emisión?", initialValue: true }));
    if (!ok) {
      p.cancel("Cancelado. No se emitió nada.");
      return;
    }
  }

  // --- emisión (la operación irreversible) -----------------------------------------
  const params: EmisionParams = {
    ptoVta: config.puntoVenta,
    cbteTipo: FACTURA_C,
    concepto: config.concepto,
    docTipo: receptor.docTipo,
    docNro: receptor.docNro,
    condIvaReceptor: receptor.condIva,
    importeTotal: monto,
    fecha,
    moneda,
    cotizacion,
    pagoMonedaExtranjera: t?.pagoEnMonedaExtranjera ?? moneda !== "PES",
    servDesde: op.periodo?.[0],
    servHasta: op.periodo?.[1],
    vtoPago: op.vto,
  };

  sp.start("Emitiendo en ARCA");
  let res;
  try {
    res = await emitirComprobante(auth, config.produccion, params);
  } catch (e) {
    sp.stop(pc.red("❌ ARCA no autorizó el comprobante (no se emitió nada)"));
    throw e;
  }
  sp.stop(
    `✅ Emitida: ${numeroCompleto(config.puntoVenta, res.numero)} — CAE ${res.cae} ` +
      `(vto ${fmtFecha(res.caeVto)})`
  );
  for (const obs of res.observaciones) p.log.warn(`Observación de ARCA: ${obs}`);

  // --- log local (si falla, avisar FUERTE: la factura ya existe) --------------------
  try {
    registrarComprobante({
      cbteTipo: FACTURA_C,
      ptoVta: config.puntoVenta,
      numero: res.numero,
      fecha: fechaToIso(fecha),
      concepto: config.concepto,
      docTipo: receptor.docTipo,
      docNro: receptor.docNro,
      condIva: receptor.condIva,
      importeTotal: monto,
      moneda,
      cotizacion,
      ...(op.periodo && {
        servDesde: fechaToIso(op.periodo[0]),
        servHasta: fechaToIso(op.periodo[1]),
      }),
      ...(op.vto && { vtoPago: fechaToIso(op.vto) }),
      cae: res.cae,
      caeVto: fechaToIso(res.caeVto),
      descripcion,
      ...(t && { template: t.nombre }),
      produccion: config.produccion,
      emitidoEn: new Date().toISOString(),
    });
  } catch (e) {
    p.log.error(
      `⚠️ La factura SE EMITIÓ (CAE ${res.cae}) pero no pude guardarla en el log local: ` +
        `${e instanceof Error ? e.message : e}. Anotala a mano.`
    );
  }

  // --- PDF (si falla, la factura sigue siendo válida) --------------------------------
  try {
    const bytes = await generarPdf({
      emisor: {
        cuit: config.cuit,
        razonSocial: config.razonSocial,
        domicilio: config.domicilio,
        inicioActividades: config.inicioActividades,
      },
      receptor:
        receptor.docTipo === DOC_TIPO_CF
          ? null
          : { ...receptor, razonSocial: t?.razonSocial, domicilio: t?.domicilio },
      cbteTipo: FACTURA_C,
      ptoVta: config.puntoVenta,
      numero: res.numero,
      fecha,
      concepto: config.concepto,
      servDesde: op.periodo?.[0],
      servHasta: op.periodo?.[1],
      vtoPago: op.vto,
      moneda,
      cotizacion,
      importeTotal: monto,
      descripcion,
      condicionVenta,
      cae: res.cae,
      caeVto: res.caeVto,
    });
    const destino = path.resolve(
      config.pdfDir ?? process.cwd(),
      `${nombreComprobante(FACTURA_C, config.puntoVenta, res.numero)}.pdf`
    );
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, bytes);
    p.log.success(`PDF: ${destino}`);
  } catch (e) {
    p.log.warn(
      `⚠️ La factura está emitida OK, pero falló el PDF: ` +
        `${e instanceof Error ? e.message : e}. Podés bajarlo de Mis Comprobantes en ARCA.`
    );
  }

  // --- alerta de tope de monotributo -------------------------------------------------
  if (config.monotributoTope) {
    try {
      const total = totalFacturado12m(config.produccion, fechaToIso(hoyAr()));
      const pct = (total / config.monotributoTope) * 100;
      if (pct >= 100) {
        p.log.error(
          `🚨 TOPE SUPERADO: llevás $ ${fmtArs(total)} en 12 meses (${pct.toFixed(0)}% de tu categoría). Hablá con tu contador YA.`
        );
      } else if (pct >= 80) {
        p.log.warn(
          `⚠️ Ojo al tope: llevás $ ${fmtArs(total)} en 12 meses (${pct.toFixed(0)}% de tu categoría de monotributo).`
        );
      }
    } catch {
      // la alerta es best-effort: no puede tapar el resultado de la emisión
    }
  }

  p.outro(config.produccion ? "Listo." : "Listo (práctica: la factura no es real).");
}
