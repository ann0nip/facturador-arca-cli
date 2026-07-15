/**
 * Lógica pura del facturador: parseo, validación y formato.
 *
 * Este módulo no toca la red ni el disco: todo lo de acá es testeable sin
 * credenciales ni configuración. Las reglas de negocio vienen verificadas
 * contra el WSFE real (ver NOTAS-ARCA.md del proyecto hermano
 * facturador-ARCA, el bot de Telegram que inspiró este paquete).
 */

// ---------------------------------------------------------------------------
// Constantes del WSFE (códigos confirmados contra el web service)
// ---------------------------------------------------------------------------
export const FACTURA_C = 11;
export const NOTA_CREDITO_C = 13;

// Tipos de documento del receptor
export const DOC_TIPO_CUIT = 80;
export const DOC_TIPO_DNI = 96;
export const DOC_TIPO_CF = 99; // Consumidor Final sin identificar (DocNro 0)
export const DOC_NRO_CF = 0;
export const COND_IVA_CF = 5; // 5 = Consumidor Final

// Condiciones IVA del receptor válidas para comprobantes clase C
// (confirmadas contra FEParamGetCondicionIvaReceptor).
export const CONDICIONES_IVA: Record<number, string> = {
  1: "Resp. Inscripto",
  6: "Monotributo",
  4: "IVA Exento",
  15: "IVA No Alcanzado",
  5: "Consumidor Final",
};

// Qué se vende: 1 = Productos, 2 = Servicios, 3 = ambos. No es la letra del
// comprobante (siempre Factura C): es el campo Concepto del WSFE, y cambia
// las reglas (sin período de servicio y retroactividad de 5 días con productos).
export type Concepto = 1 | 2 | 3;

export const CONCEPTO_DESC: Record<Concepto, string> = {
  1: "Productos",
  2: "Servicios",
  3: "Productos y Servicios",
};

/** Las fechas de servicio (período) existen solo para conceptos 2 y 3. */
export function usaPeriodo(concepto: Concepto): boolean {
  return concepto !== 1;
}

/** WSFE acepta CbteFch hacia atrás: 10 días para servicios, 5 para productos. */
export function diasAtrasMax(concepto: Concepto): number {
  return usaPeriodo(concepto) ? 10 : 5;
}

// ---------------------------------------------------------------------------
// Fechas — siempre en hora argentina, sin objetos Date sueltos
// ---------------------------------------------------------------------------
// Un Date de JS arrastra la zona horaria del host y eso es exactamente el bug
// que queremos evitar (de 21:00 a 00:00 en un host UTC, "hoy" es mañana).
// Acá una fecha es un dato plano {y, m, d}; Date solo se usa internamente
// para aritmética en UTC.

export interface Fecha {
  y: number;
  m: number; // 1-12
  d: number; // 1-31
}

const TZ_AR = "America/Argentina/Buenos_Aires";

/** Crea una Fecha validando que exista en el calendario (31/02 → null). */
export function crearFecha(y: number, m: number, d: number): Fecha | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  const existe =
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  return existe ? { y, m, d } : null;
}

/** La fecha de HOY en Argentina, aunque el proceso corra en otra zona horaria. */
export function hoyAr(): Fecha {
  // en-CA formatea como YYYY-MM-DD, que es trivial de partir.
  const iso = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ_AR,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}

/** {2026, 7, 5} → 20260705 (el formato que exige el WSFE). */
export function fechaToInt(f: Fecha): number {
  return f.y * 10000 + f.m * 100 + f.d;
}

/** 20260705 (o "20260705") → {2026, 7, 5}. null si no es una fecha real. */
export function fechaFromInt(n: number | string): Fecha | null {
  const s = String(n);
  if (!/^\d{8}$/.test(s)) return null;
  return crearFecha(Number(s.slice(0, 4)), Number(s.slice(4, 6)), Number(s.slice(6, 8)));
}

/** {2026, 7, 5} → "2026-07-05" (para el QR y el log). */
export function fechaToIso(f: Fecha): string {
  const mm = String(f.m).padStart(2, "0");
  const dd = String(f.d).padStart(2, "0");
  return `${f.y}-${mm}-${dd}`;
}

/** {2026, 7, 5} → "05/07/2026" (para mostrarle al usuario). */
export function fmtFecha(f: Fecha): string {
  const mm = String(f.m).padStart(2, "0");
  const dd = String(f.d).padStart(2, "0");
  return `${dd}/${mm}/${f.y}`;
}

/** Negativo si a < b, 0 si iguales, positivo si a > b. */
export function cmpFecha(a: Fecha, b: Fecha): number {
  return fechaToInt(a) - fechaToInt(b);
}

/** Suma (o resta, con negativo) días de calendario. */
export function addDias(f: Fecha, dias: number): Fecha {
  const dt = new Date(Date.UTC(f.y, f.m - 1, f.d + dias));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** Acepta dd/mm, dd/mm/aaaa, dd-mm, dd-mm-aa u "hoy". null si no parsea. */
export function parsearFecha(texto: string): Fecha | null {
  const t = texto.trim().toLowerCase().replaceAll("-", "/");
  if (t === "hoy") return hoyAr();
  const partes = t.split("/");
  if (partes.length !== 2 && partes.length !== 3) return null;
  if (partes.some((p) => !/^\d+$/.test(p))) return null;

  const d = Number(partes[0]);
  const m = Number(partes[1]);
  let y = partes.length === 3 ? Number(partes[2]) : hoyAr().y;
  if (partes.length === 3 && y < 100) y += 2000;
  return crearFecha(y, m, d);
}

/**
 * null si la fecha es emitible; si no, el mensaje de error para el usuario.
 * OJO: esto valida la ventana retroactiva general; ARCA además exige que la
 * fecha no sea anterior a la del último comprobante del PV (error 10016).
 */
export function validarFecha(f: Fecha, concepto: Concepto): string | null {
  const hoy = hoyAr();
  const max = diasAtrasMax(concepto);
  if (cmpFecha(f, hoy) > 0) {
    return "La fecha no puede ser futura.";
  }
  const limite = addDias(hoy, -max);
  if (cmpFecha(f, limite) < 0) {
    return `Máximo ${max} días para atrás (desde el ${fmtFecha(limite)}).`;
  }
  return null;
}

/** Dos fechas en un texto: "01/06-30/06", "01/06 al 30/06"... null si no. */
export function parsearPeriodo(texto: string): [Fecha, Fecha] | null {
  const fechas = texto.match(/\d{1,2}\/\d{1,2}(?:\/\d{2,4})?/g);
  if (fechas === null || fechas.length !== 2) return null;
  const desde = parsearFecha(fechas[0]);
  const hasta = parsearFecha(fechas[1]);
  if (desde === null || hasta === null || cmpFecha(desde, hasta) > 0) return null;
  return [desde, hasta];
}

// ---------------------------------------------------------------------------
// Montos
// ---------------------------------------------------------------------------
export class MontoInvalidoError extends Error {
  constructor(texto: string) {
    super(`Monto inválido: «${texto}»`);
    this.name = "MontoInvalidoError";
  }
}

/**
 * Acepta formato argentino Y estadounidense, con o sin $:
 * 15000 / 15.000 / 15.000,50 / 15000,50 / 15,000 / 15,000.00 / 15000.5
 *
 * Regla anti-ambigüedad: si aparecen ambos separadores, el que está más a
 * la DERECHA es el decimal. Si hay uno solo agrupando de a 3, son miles.
 * Devuelve el monto redondeado a 2 decimales. Lanza MontoInvalidoError si
 * no es un monto válido o es <= 0.
 */
export function parsearMonto(texto: string): number {
  let t = texto.trim().replace(/\s+/g, "").replace(/^\$+/, "");
  if (t.includes(",") && t.includes(".")) {
    if (t.lastIndexOf(",") > t.lastIndexOf(".")) {
      t = t.replaceAll(".", "").replace(",", "."); // 450.000,00 (AR)
    } else {
      t = t.replaceAll(",", ""); // 450,000.00 (US)
    }
  } else if (/^\d{1,3}([.,]\d{3})+$/.test(t)) {
    t = t.replace(/[.,]/g, ""); // 15.000 / 450,000 → miles
  } else {
    t = t.replace(",", "."); // 15000,50 → decimal
  }
  if (!/^\d+(\.\d+)?$/.test(t)) throw new MontoInvalidoError(texto);
  const monto = Math.round(parseFloat(t) * 100) / 100;
  if (!Number.isFinite(monto) || monto <= 0) throw new MontoInvalidoError(texto);
  return monto;
}

/** 15000.5 → "15.000,50" (formato argentino). */
export function fmtArs(monto: number): string {
  return monto.toLocaleString("es-AR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// ---------------------------------------------------------------------------
// Documentos del receptor (CUIT / DNI)
// ---------------------------------------------------------------------------

/** Valida un CUIT (con o sin guiones) incluido el dígito verificador. */
export function parsearCuit(texto: string): number | null {
  const t = texto.trim().replace(/[-.\s]/g, "");
  if (!/^\d{11}$/.test(t)) return null;
  const digitos = t.split("").map(Number);
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const resto = pesos.reduce((acc, p, i) => acc + digitos[i] * p, 0) % 11;
  const verificador = resto === 0 ? 0 : 11 - resto;
  if (verificador === 10 || verificador !== digitos[10]) return null;
  return Number(t);
}

export interface Doc {
  docTipo: number;
  docNro: number;
}

/**
 * Detecta CUIT (11 dígitos, valida verificador) o DNI (7-8 dígitos).
 * null si no es ni una cosa ni la otra.
 */
export function parsearDoc(texto: string): Doc | null {
  const t = texto.trim().replace(/[-.\s]/g, "");
  if (/^\d{11}$/.test(t)) {
    const cuit = parsearCuit(t);
    return cuit === null ? null : { docTipo: DOC_TIPO_CUIT, docNro: cuit };
  }
  if (/^\d{7,8}$/.test(t)) {
    return { docTipo: DOC_TIPO_DNI, docNro: Number(t) };
  }
  return null;
}

/** 20409378472 → "20-40937847-2". */
export function fmtCuit(cuit: number): string {
  const s = String(cuit);
  return `${s.slice(0, 2)}-${s.slice(2, 10)}-${s.slice(10)}`;
}

export function fmtDoc(docTipo: number, nro: number): string {
  if (docTipo === DOC_TIPO_CUIT) return `CUIT ${fmtCuit(nro)}`;
  return `DNI ${nro.toLocaleString("es-AR")}`;
}

export interface Receptor {
  docTipo: number;
  docNro: number;
  condIva: number;
}

export const RECEPTOR_CF: Receptor = {
  docTipo: DOC_TIPO_CF,
  docNro: DOC_NRO_CF,
  condIva: COND_IVA_CF,
};

export function descripcionReceptor(r: Receptor): string {
  if (r.docTipo === DOC_TIPO_CUIT || r.docTipo === DOC_TIPO_DNI) {
    const cond = CONDICIONES_IVA[r.condIva] ?? `cond. ${r.condIva}`;
    return `${fmtDoc(r.docTipo, r.docNro)} — ${cond}`;
  }
  return "Consumidor Final";
}

// ---------------------------------------------------------------------------
// Monedas
// ---------------------------------------------------------------------------
// El WSFE acepta moneda extranjera: MonId + MonCotiz (cotización oficial que
// publica ARCA, consultable vía FEParamGetCotizacion). Los importes del
// comprobante van expresados EN esa moneda; el PDF debe imprimir además el
// total en pesos al tipo de cambio consignado.
export type Moneda = "PES" | "DOL";

export const MONEDA_DESC: Record<Moneda, string> = {
  PES: "Pesos Argentinos",
  DOL: "Dólar Estadounidense",
};

export const SIMBOLO_MONEDA: Record<Moneda, string> = {
  PES: "$",
  DOL: "USD",
};

// ---------------------------------------------------------------------------
// QR obligatorio (RG 4892/2020) y nombres de archivo
// ---------------------------------------------------------------------------
export interface DatosQr {
  fecha: Fecha;
  cuitEmisor: number;
  ptoVta: number;
  cbteTipo: number;
  cbteNro: number;
  importe: number;
  moneda: Moneda;
  /** Cotización: 1 para PES; el tipo de cambio oficial para moneda extranjera. */
  ctz: number;
  docTipoRec: number;
  docNroRec: number;
  cae: string;
}

/** URL oficial del QR: https://www.afip.gob.ar/fe/qr/?p=<base64(json)>. */
export function urlQrArca(d: DatosQr): string {
  const datos = {
    ver: 1,
    fecha: fechaToIso(d.fecha),
    cuit: d.cuitEmisor,
    ptoVta: d.ptoVta,
    tipoCmp: d.cbteTipo,
    nroCmp: d.cbteNro,
    importe: Math.round(d.importe * 100) / 100,
    moneda: d.moneda,
    ctz: d.ctz,
    tipoDocRec: d.docTipoRec,
    nroDocRec: d.docNroRec,
    tipoCodAut: "E", // E = CAE
    codAut: Number(d.cae),
  };
  const payload = Buffer.from(JSON.stringify(datos)).toString("base64");
  return `https://www.afip.gob.ar/fe/qr/?p=${payload}`;
}

/** "Factura-C-00003-00000042" / "NC-C-...": nombre de archivo del comprobante. */
export function nombreComprobante(cbteTipo: number, ptoVta: number, nro: number): string {
  const prefijo = cbteTipo === NOTA_CREDITO_C ? "NC-C" : "Factura-C";
  return `${prefijo}-${String(ptoVta).padStart(5, "0")}-${String(nro).padStart(8, "0")}`;
}

/** "00003-00000042": número completo como figura impreso. */
export function numeroCompleto(ptoVta: number, nro: number): string {
  return `${String(ptoVta).padStart(5, "0")}-${String(nro).padStart(8, "0")}`;
}
