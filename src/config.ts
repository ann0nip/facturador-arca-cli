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

import type { Concepto, Moneda, Receptor } from "./core/domain.js";
import { CONDICIONES_IVA, DOC_TIPO_CF } from "./core/domain.js";

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
export interface Template {
  /** Slug: el nombre que se tipea en `facturar 1000 <nombre>`. */
  nombre: string;
  /** null = consumidor final anónimo. */
  receptor: Receptor | null;
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
  return JSON.parse(fs.readFileSync(p, "utf8")) as Template;
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
  if (t.receptor === null || t.receptor.docTipo === DOC_TIPO_CF) {
    return "Consumidor Final";
  }
  const cond = CONDICIONES_IVA[t.receptor.condIva] ?? `cond. ${t.receptor.condIva}`;
  return `doc ${t.receptor.docNro} — ${cond}`;
}
