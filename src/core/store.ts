/**
 * Log local de comprobantes — JSONL (una línea JSON por comprobante).
 *
 * Es la red de seguridad y la fuente de los reportes futuros (resumen, CSV,
 * tope): ARCA no reenvía lo que ya emitiste, así que este archivo es tu
 * registro. Append-only: los comprobantes son inmutables.
 *
 * Sin base de datos a propósito: un archivo de texto plano que el usuario
 * puede leer, versionar o respaldar como quiera.
 */

import fs from "node:fs";
import path from "node:path";

import type { Concepto, Moneda } from "./domain.js";
import { NOTA_CREDITO_C, NOTA_CREDITO_E } from "./domain.js";
import { logPath } from "../config.js";

export interface Comprobante {
  cbteTipo: number;
  ptoVta: number;
  numero: number;
  /** Fecha del comprobante, ISO (aaaa-mm-dd). */
  fecha: string;
  concepto: Concepto;
  // Snapshot del receptor tal como fue a ARCA (inmutable, no depende del template)
  docTipo: number;
  docNro: number;
  condIva: number;
  /** Expresado EN la moneda del comprobante. */
  importeTotal: number;
  moneda: Moneda;
  cotizacion: number;
  servDesde?: string;
  servHasta?: string;
  vtoPago?: string;
  cae: string;
  caeVto: string;
  descripcion?: string;
  /** Nombre del template usado (si hubo). */
  template?: string;
  /** Para NC: número de la factura asociada. */
  asociadoNro?: number;

  // --- solo comprobantes de exportación (cbteTipo 19/20/21, vía WSFEX) ------
  // Snapshot del receptor del exterior, que no entra en docTipo/docNro.
  cuitPais?: number;
  clienteExterior?: string;
  paisDestino?: number;
  tipoExpo?: number;
  /** Forma_pago: a diferencia de la Factura C, es dato del comprobante. */
  formaPago?: string;
  /** Fecha_pago del WSFEX, ISO (aaaa-mm-dd). */
  fechaPago?: string;
  /**
   * Id del request de WSFEX. Es la clave de idempotencia: si una emisión
   * quedó en duda, reenviar este mismo Id devuelve el CAE original en vez de
   * duplicar el comprobante.
   */
  idRequest?: number;
  /** false = homologación. Nunca mezclar al reportar. */
  produccion: boolean;
  /** Timestamp de emisión, ISO completo. */
  emitidoEn: string;
  pdfPath?: string;
}

/**
 * Agrega el comprobante al log. Lanza si falla (el que llama DEBE avisar).
 *
 * Solo lo lee el dueño (0600): el log tiene datos fiscales propios y de
 * terceros — CUIT/DNI de los receptores, y nombre y domicilio de los clientes
 * del exterior en las Facturas E. El `mode` solo aplica al crear el archivo:
 * un log viejo conserva sus permisos (ver `chmod` en el README).
 */
export function registrarComprobante(c: Comprobante): void {
  const p = logPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.appendFileSync(p, JSON.stringify(c) + "\n", { mode: 0o600 });
}

/** Todos los comprobantes del log (las líneas corruptas se saltean). */
export function leerComprobantes(): Comprobante[] {
  const p = logPath();
  if (!fs.existsSync(p)) return [];
  const resultado: Comprobante[] = [];
  for (const linea of fs.readFileSync(p, "utf8").split("\n")) {
    if (!linea.trim()) continue;
    try {
      resultado.push(JSON.parse(linea) as Comprobante);
    } catch {
      // línea corrupta (¿edición a mano?): se ignora, el resto del log sirve
    }
  }
  return resultado;
}

/**
 * Facturado neto (facturas − NC) de los últimos 12 meses, EN PESOS, como lo
 * mira ARCA para el monotributo. Moneda extranjera → pesos a la cotización
 * del comprobante. Solo cuenta el entorno indicado (test y real no se mezclan).
 *
 * Las Facturas E cuentan igual que las C: la exportación de servicios suma
 * para el tope de la categoría de monotributo.
 */
export function totalFacturado12m(produccion: boolean, hoyIso: string): number {
  const desde = new Date(new Date(hoyIso).getTime() - 365 * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  let total = 0;
  for (const c of leerComprobantes()) {
    if (c.produccion !== produccion) continue;
    if (c.fecha < desde || c.fecha > hoyIso) continue;
    const enPesos = c.importeTotal * (c.moneda === "PES" ? 1 : c.cotizacion);
    const esNc = c.cbteTipo === NOTA_CREDITO_C || c.cbteTipo === NOTA_CREDITO_E;
    total += esNc ? -enPesos : enPesos;
  }
  return Math.round(total * 100) / 100;
}
