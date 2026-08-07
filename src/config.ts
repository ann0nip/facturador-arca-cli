/**
 * Config del emisor y templates de receptores — archivos JSON legibles,
 * editables a mano, en la carpeta estándar de config de cada OS.
 *
 * Ubicación (override con la variable de entorno FACTURADOR_CONFIG_DIR):
 *   macOS/Linux: $XDG_CONFIG_HOME/facturador  (o ~/.config/facturador)
 *   Windows:     %APPDATA%\facturador
 *
 * Layout:
 *   config.json          ← el emisor (tu CUIT, PV, cert) y el modo test/producción
 *   templates/acme.json  ← un receptor con nombre: `facturar 1000 acme`
 *   comprobantes.jsonl   ← log local de todo lo emitido (store.ts)
 *   keys/                ← private key y certificados generados por el wizard
 *   wsaa/                ← cache de tickets de autenticación (12 h)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  Concepto,
  Idioma,
  Moneda,
  Receptor,
  ReceptorExterior,
  TipoExpo,
} from "./core/domain.js";
import { CONDICIONES_IVA, DOC_TIPO_CF, esCuitPais } from "./core/domain.js";

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------
export function configDir(): string {
  const override = process.env.FACTURADOR_CONFIG_DIR;
  if (override) return override;
  if (process.platform === "win32") {
    const base = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "facturador");
  }
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, "facturador");
}

export const configPath = () => path.join(configDir(), "config.json");
export const templatesDir = () => path.join(configDir(), "templates");
export const keysDir = () => path.join(configDir(), "keys");
export const wsaaCacheDir = () => path.join(configDir(), "wsaa");
export const logPath = () => path.join(configDir(), "comprobantes.jsonl");

// ---------------------------------------------------------------------------
// Emisor (config.json)
// ---------------------------------------------------------------------------
export interface Emisor {
  /** CUIT del emisor, sin guiones. */
  cuit: number;
  /** Punto de venta tipo Web Service (NO el de Comprobantes en Línea). */
  puntoVenta: number;
  /**
   * Punto de venta para Factura E. ARCA obliga a que sea OTRO: el de arriba se
   * da de alta como «Factura Electrónica - Monotributo - Webservices» y este
   * como «Comprobantes de Exportación - Webservices». Vacío = no se pueden
   * emitir comprobantes de exportación todavía.
   */
  puntoVentaExportacion?: number;
  /** Nombre tal como figura en ARCA (va impreso en el PDF). */
  razonSocial: string;
  domicilio?: string;
  /** dd/mm/aaaa, impreso en el PDF. */
  inicioActividades?: string;
  /** 1 = Productos, 2 = Servicios, 3 = ambos (campo Concepto del WSFE). */
  concepto: Concepto;
  /** false = homologación (facturas de práctica). true = FACTURAS REALES. */
  produccion: boolean;
  /** Rutas al certificado y la private key (el wizard las genera en keys/). */
  certPath: string;
  keyPath: string;
  /** Texto default del renglón del PDF cuando el template no trae uno. */
  descripcionDefault?: string;
  /** Dónde guardar los PDFs emitidos (default: el directorio actual). */
  pdfDir?: string;
  /** Umbral de identificación del CF (RG 5700/2025). Vacío = alerta apagada. */
  umbralCf?: number;
  /** Tope anual de tu categoría de monotributo. Vacío = alerta apagada. */
  monotributoTope?: number;
}

/** Lista de problemas de config (vacía = todo OK). Mensajes para humanos. */
export function validarEmisor(e: Partial<Emisor>): string[] {
  const errores: string[] = [];
  if (!e.cuit || !Number.isInteger(e.cuit) || String(e.cuit).length !== 11) {
    errores.push("cuit: falta o no es un CUIT de 11 dígitos (sin guiones)");
  }
  if (!e.puntoVenta || !Number.isInteger(e.puntoVenta) || e.puntoVenta < 1) {
    errores.push("puntoVenta: falta o no es un número válido");
  }
  if (!e.razonSocial?.trim()) {
    errores.push("razonSocial: falta (tiene que coincidir con ARCA)");
  }
  if (e.concepto !== 1 && e.concepto !== 2 && e.concepto !== 3) {
    errores.push("concepto: tiene que ser 1 (productos), 2 (servicios) o 3 (ambos)");
  }
  if (!e.certPath?.trim()) {
    errores.push("certPath: falta la ruta al certificado (.crt)");
  } else if (!fs.existsSync(e.certPath)) {
    errores.push(`certPath: no existe el archivo ${e.certPath}`);
  } else {
    // Error clásico: apuntar al pedido (.csr) en vez de al certificado.
    const cabecera = fs.readFileSync(e.certPath, "utf8").slice(0, 120);
    if (cabecera.includes("CERTIFICATE REQUEST")) {
      errores.push(
        "certPath: apunta al PEDIDO de certificado (.csr), no al certificado. " +
          "Guardá el .crt que te dio ARCA y apuntá a ese archivo."
      );
    } else if (!cabecera.includes("BEGIN CERTIFICATE")) {
      errores.push("certPath: el archivo no parece un certificado PEM (.crt)");
    }
  }
  if (!e.keyPath?.trim()) {
    errores.push("keyPath: falta la ruta a la private key (.key)");
  } else if (!fs.existsSync(e.keyPath)) {
    errores.push(`keyPath: no existe el archivo ${e.keyPath}`);
  } else if (!fs.readFileSync(e.keyPath, "utf8").slice(0, 120).includes("PRIVATE KEY")) {
    errores.push("keyPath: el archivo no parece una clave privada (.key)");
  }
  return errores;
}

/** null si no existe config.json todavía (primera vez → correr `facturar init`). */
export function cargarConfig(): Emisor | null {
  const p = configPath();
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as Emisor;
}

export function guardarConfig(e: Emisor): void {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(e, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Templates (receptores con nombre)
// ---------------------------------------------------------------------------
/**
 * Los datos de un cliente del EXTERIOR: convierten al template en una
 * Factura E, que se emite por WSFEX en vez del WSFEv1.
 *
 * Los nombres de país (`cuitPaisDesc`, `paisDestinoDesc`) se guardan al crear
 * el template para que el PDF no dependa de la red: son los que devuelven
 * FEXGetPARAM_DST_CUIT y FEXGetPARAM_DST_pais.
 */
export interface DatosExportacion extends ReceptorExterior {
  /** "SUECIA - Persona Jurídica", tal como lo imprime ARCA junto al CUIT País. */
  cuitPaisDesc?: string;
  /** "SUECIA": el "Destino del Comprobante" del PDF. */
  paisDestinoDesc?: string;
  /** 1 = Bienes, 2 = Servicios, 4 = Otros. Default: 2. */
  tipoExpo?: TipoExpo;
  /** 1 = Español, 2 = Inglés, 3 = Portugués. Default: 1. */
  idioma?: Idioma;
  /**
   * Medio de pago, ej. "Criptomonedas". OJO: a diferencia de `condicionVenta`
   * de la Factura C, este campo SÍ viaja a ARCA (Forma_pago del WSFEX).
   */
  formaPago?: string;
  /** Solo exportación de bienes. */
  incoterms?: string;
  incotermsDesc?: string;
}

export interface Template {
  /** Slug: el nombre que se tipea en `facturar 1000 <nombre>`. */
  nombre: string;
  /** null = consumidor final anónimo. Se ignora si hay `exterior`. */
  receptor: Receptor | null;
  /** Presente ⇒ es un cliente del exterior ⇒ Factura E por WSFEX. */
  exterior?: DatosExportacion;
  /** Nombre / razón social del receptor, para imprimir en el PDF. */
  razonSocial?: string;
  /** Domicilio del receptor, para el PDF. */
  domicilio?: string;
  /** Moneda del comprobante (default: PES). */
  moneda?: Moneda;
  /** true = el pago se cancela en la misma moneda extranjera (CanMisMonExt=S). */
  pagoEnMonedaExtranjera?: boolean;
  /** Texto de "Condición de venta" del PDF (ARCA no lo recibe). */
  condicionVenta?: string;
  /** Texto del renglón del PDF (pisa el descripcionDefault del emisor). */
  descripcion?: string;
  /** Para mandar el comprobante por email (v2). */
  email?: string;
}

/** Solo letras/números/guiones: tiene que ser tipeable y servir de filename. */
export function nombreTemplateValido(nombre: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(nombre);
}

const templatePath = (nombre: string) =>
  path.join(templatesDir(), `${nombre.toLowerCase()}.json`);

export function cargarTemplate(nombre: string): Template | null {
  if (!nombreTemplateValido(nombre)) return null;
  const p = templatePath(nombre);
  if (!fs.existsSync(p)) return null;
  const t = JSON.parse(fs.readFileSync(p, "utf8")) as Template;
  // Los templates son editables a mano: validar lo que después viaja a ARCA,
  // con error legible acá en vez de un rechazo críptico del web service.
  if (t.moneda !== undefined && t.moneda !== "PES" && t.moneda !== "DOL") {
    throw new Error(
      `El template «${nombre}» tiene una moneda inválida: «${t.moneda}» (usá PES o DOL).`
    );
  }
  if (t.receptor !== null && t.receptor !== undefined) {
    const { docTipo, docNro, condIva } = t.receptor;
    if (![Number.isInteger(docTipo), Number.isInteger(docNro), Number.isInteger(condIva)].every(Boolean)) {
      throw new Error(
        `El template «${nombre}» tiene un receptor mal formado: docTipo, docNro y ` +
          `condIva tienen que ser números (¿se editó a mano?).`
      );
    }
  }
  if (t.exterior !== undefined) {
    validarExportacion(nombre, t.exterior);
  }
  return t;
}

/** Chequeos del bloque de exportación, con mensajes para humanos. */
function validarExportacion(nombre: string, e: DatosExportacion): void {
  const mal = (detalle: string): never => {
    throw new Error(`El template «${nombre}» tiene el bloque «exterior» mal formado: ${detalle}`);
  };
  if (!esCuitPais(e.cuitPais)) {
    mal(
      `cuitPais «${e.cuitPais}» no es un CUIT País (11 dígitos que arrancan con 50, 51 o 55). ` +
        `El del cliente lo da ARCA en la tabla de CUIT País, no lo inventes.`
    );
  }
  if (!e.nombre?.trim()) mal("falta nombre (el campo Cliente que va a ARCA).");
  if (!e.domicilio?.trim()) mal("falta domicilio del cliente en el exterior.");
  if (!Number.isInteger(e.paisDestino) || e.paisDestino <= 0) {
    mal("paisDestino tiene que ser el código numérico de país que usa ARCA.");
  }
  if (e.tipoExpo !== undefined && ![1, 2, 4].includes(e.tipoExpo)) {
    mal(`tipoExpo «${e.tipoExpo}» inválido (1 = bienes, 2 = servicios, 4 = otros).`);
  }
  if (e.idioma !== undefined && ![1, 2, 3].includes(e.idioma)) {
    mal(`idioma «${e.idioma}» inválido (1 = español, 2 = inglés, 3 = portugués).`);
  }
}

export function guardarTemplate(t: Template): void {
  if (!nombreTemplateValido(t.nombre)) {
    throw new Error(
      `Nombre de template inválido: «${t.nombre}» (solo letras, números y guiones).`
    );
  }
  fs.mkdirSync(templatesDir(), { recursive: true });
  fs.writeFileSync(templatePath(t.nombre), JSON.stringify(t, null, 2) + "\n");
}

export function borrarTemplate(nombre: string): boolean {
  // Validar SIEMPRE antes del path.join: sin esto, un nombre tipo
  // "../config" borraría archivos fuera de templates/.
  if (!nombreTemplateValido(nombre)) return false;
  const p = templatePath(nombre);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

export function listarTemplates(): Template[] {
  const dir = templatesDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Template)
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
}

/** Descripción humana de un template para listados y previews. */
export function descripcionTemplate(t: Template): string {
  if (t.exterior) {
    const donde = t.exterior.paisDestinoDesc ?? `país ${t.exterior.paisDestino}`;
    return `Exterior (${donde}) — CUIT País ${t.exterior.cuitPais}`;
  }
  if (t.receptor === null || t.receptor.docTipo === DOC_TIPO_CF) {
    return "Consumidor Final";
  }
  const cond = CONDICIONES_IVA[t.receptor.condIva] ?? `cond. ${t.receptor.condIva}`;
  return `doc ${t.receptor.docNro} — ${cond}`;
}
