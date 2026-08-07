/**
 * WSFEX — el web service de comprobantes de EXPORTACIÓN de ARCA (Factura E).
 *
 * Es un servicio APARTE del WSFEv1 de wsfe.ts, no una variante: otro endpoint,
 * otro namespace, otro modelo de datos y otro trámite de autorización. Está
 * verificado que el WSFEv1 no conoce el tipo 19 — su FEParamGetTiposCbte
 * devuelve 36 tipos y ninguno es de exportación (ver docs/factura-e-plan.md).
 *
 * ⚠️ El ORDEN de los campos importa (schema sequence). El de acá abajo está
 * tomado del WSDL real de homologación (ago-2026), tipo ClsFEXRequest:
 *
 *   Id, Fecha_cbte, Cbte_Tipo, Punto_vta, Cbte_nro, Tipo_expo,
 *   Permiso_existente, Permisos, Dst_cmp, Cliente, Cuit_pais_cliente,
 *   Domicilio_cliente, Id_impositivo, Moneda_Id, Moneda_ctz, CanMisMonExt,
 *   Obs_comerciales, Imp_total, Obs, Cmps_asoc, Forma_pago, Incoterms,
 *   Incoterms_Ds, Idioma_cbte, Items, Opcionales, Fecha_pago, Actividades
 *
 * Diferencias con WSFEv1 que rompen si se las ignora:
 *  - NO hay ImpNeto / ImpOpEx / ImpIVA / ImpTrib: un solo Imp_total.
 *  - NO hay Concepto ni FchServDesde/Hasta: hay Tipo_expo y Fecha_pago.
 *  - Los Items VIAJAN a ARCA (en la Factura C el renglón es solo del PDF).
 *  - Forma_pago es un campo del request, no un texto decorativo.
 *  - El request lleva un Id que asigna el cliente (FEXGetLast_ID + 1) y la
 *    respuesta trae Reproceso: reenviar el mismo Id devuelve el CAE original
 *    en vez de duplicar el comprobante.
 *  - Los errores vienen en UN bloque FEXErr con ErrCode/ErrMsg (ErrCode=0
 *    significa "sin error"), no en una lista de <Err> como WSFEv1.
 */

import {
  type Fecha,
  type Idioma,
  type Moneda,
  type ReceptorExterior,
  type TipoExpo,
  FACTURA_E,
  UMED_UNIDADES,
  fechaToInt,
  fechaFromInt,
} from "./domain.js";
import { escaparXml, textoTag } from "./wsaa.js";
import { postXml } from "./http.js";

const URL_WSFEX = {
  homologacion: "https://wswhomo.afip.gov.ar/wsfexv1/service.asmx",
  produccion: "https://servicios1.afip.gov.ar/wsfexv1/service.asmx",
};
// Igual que en wsfe.ts, la barra final es parte del targetNamespace del WSDL.
// Ojo: acá el namespace va en MINÚSCULA (fexv1), no como el FEV1 del WSFEv1.
const NS = "http://ar.gov.afip.dif.fexv1/";

/** El servicio que hay que pedirle a WSAA (distinto del "wsfe" de wsfe.ts). */
export const SERVICIO_WSAA = "wsfex";

export interface AuthWsfex {
  token: string;
  sign: string;
  cuit: number;
}

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------
export class WsfexError extends Error {
  readonly codigo: number;
  /**
   * true cuando NO sabemos si el comprobante llegó a emitirse (timeout, corte
   * de red). Es distinto de un rechazo: si ARCA contestó "R", no se emitió
   * nada. Acá el estado quedó en duda y hay que verificar antes de reintentar.
   */
  readonly indeterminado: boolean;

  constructor(mensaje: string, codigo = 0, indeterminado = false) {
    let texto = codigo === 0 ? mensaje : `[${codigo}] ${mensaje}`;
    if (codigo === 1800) {
      texto +=
        "\n💡 WSFEX no publica cotización para PES (es la moneda local): para " +
        "emitir en pesos va Moneda_ctz = 1, sin consultar.";
    }
    if (codigo === 602 || /punto de venta/i.test(mensaje)) {
      texto +=
        "\n💡 El punto de venta de exportación es OTRO que el de la Factura C: " +
        "hay que darlo de alta como «Comprobantes de Exportación - Webservices».";
    }
    if (codigo === 1535) {
      texto +=
        "\n💡 Numeración cronológica: la fecha no puede ser anterior a la del último " +
        "comprobante de exportación de ese punto de venta. OJO con el efecto colateral " +
        "de las fechas futuras — WSFEX las acepta (hasta +5 días), pero después bloquean " +
        "todo lo que quieras emitir con fecha anterior. Probá con una fecha más reciente.";
    }
    if (codigo === 1500) {
      texto +=
        "\n💡 WSFEX solo acepta fechas dentro de ±5 días de hoy (a diferencia de la " +
        "Factura C, que admite 10 días hacia atrás y ningún día hacia adelante).";
    }
    super(texto);
    this.name = "WsfexError";
    this.codigo = codigo;
    this.indeterminado = indeterminado;
  }
}

/** El bloque FEXErr de una respuesta, o null si vino ErrCode=0. */
export function extraerError(xml: string): { codigo: number; mensaje: string } | null {
  const bloque = xml.match(/<FEXErr>[\s\S]*?<\/FEXErr>/)?.[0];
  if (!bloque) return null;
  const codigo = Number(textoTag(bloque, "ErrCode") ?? 0);
  if (codigo === 0) return null;
  return { codigo, mensaje: (textoTag(bloque, "ErrMsg") ?? "").trim() };
}

function lanzarSiError(xml: string): void {
  const e = extraerError(xml);
  if (e !== null) throw new WsfexError(e.mensaje, e.codigo);
}

/** Los FEXEvent no bloqueantes que ARCA adjunta a una respuesta. */
export function extraerEventos(xml: string): string[] {
  const bloques = xml.match(/<ClsFEXEvents>[\s\S]*?<\/ClsFEXEvents>/g) ?? [];
  return bloques
    .map((b) => {
      const codigo = (textoTag(b, "EventCode") ?? "0").trim();
      const msg = (textoTag(b, "EventMsg") ?? "").trim();
      return codigo === "0" || msg === "" ? "" : `[${codigo}] ${msg}`;
    })
    .filter((s) => s !== "");
}

// ---------------------------------------------------------------------------
// Transporte SOAP
// ---------------------------------------------------------------------------
/** Hook de test: reemplaza el POST real. */
export type PostFn = (
  url: string,
  headers: Record<string, string>,
  body: string
) => Promise<string>;

async function postHttp(
  url: string,
  headers: Record<string, string>,
  body: string
): Promise<string> {
  let res: Awaited<ReturnType<typeof postXml>>;
  try {
    res = await postXml(url, headers, body);
  } catch (e) {
    // Timeout o corte de red: la petición pudo haber llegado igual, así que
    // el resultado queda INDETERMINADO. emitirExportacion() se encarga de
    // averiguar qué pasó en vez de dejarle el problema al usuario.
    const detalle =
      e instanceof Error && e.name === "TimeoutError"
        ? "WSFEX no respondió en 60 segundos."
        : `Se cortó la conexión con WSFEX: ${e instanceof Error ? e.message : e}`;
    throw new WsfexError(detalle, 0, true);
  }
  const texto = await res.text();
  if (!res.ok && !texto.includes("faultstring")) {
    throw new WsfexError(`WSFEX devolvió HTTP ${res.status}:\n${texto.slice(0, 500)}`, 0, true);
  }
  return texto;
}

async function llamar(
  metodo: string,
  contenido: string,
  produccion: boolean,
  _post?: PostFn
): Promise<string> {
  const url = produccion ? URL_WSFEX.produccion : URL_WSFEX.homologacion;
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${NS}">
  <soap:Body><ar:${metodo}>${contenido}</ar:${metodo}></soap:Body>
</soap:Envelope>`;

  const post = _post ?? postHttp;
  const texto = await post(
    url,
    { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${NS}${metodo}"` },
    envelope
  );
  const fault = textoTag(texto, "faultstring");
  if (fault !== null) throw new WsfexError(`WSFEX rechazó la llamada: ${fault}`);
  return texto;
}

function xmlAuth(auth: AuthWsfex): string {
  return (
    `<ar:Auth><ar:Token>${auth.token}</ar:Token>` +
    `<ar:Sign>${auth.sign}</ar:Sign><ar:Cuit>${auth.cuit}</ar:Cuit></ar:Auth>`
  );
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------
/**
 * Número del último comprobante autorizado en ese PV+tipo (0 si no hay).
 *
 * ⚠️ Acá el PtoVta y el CbteTipo van DENTRO del bloque Auth (tipo
 * ClsFEX_LastCMP del WSDL), no como parámetros hermanos: es distinto del
 * FECompUltimoAutorizado del WSFEv1.
 */
export async function ultimoAutorizado(
  auth: AuthWsfex,
  produccion: boolean,
  ptoVta: number,
  cbteTipo: number,
  _post?: PostFn
): Promise<number> {
  const xml = await llamar(
    "FEXGetLast_CMP",
    `<ar:Auth><ar:Token>${auth.token}</ar:Token><ar:Sign>${auth.sign}</ar:Sign>` +
      `<ar:Cuit>${auth.cuit}</ar:Cuit><ar:Pto_venta>${ptoVta}</ar:Pto_venta>` +
      `<ar:Cbte_Tipo>${cbteTipo}</ar:Cbte_Tipo></ar:Auth>`,
    produccion,
    _post
  );
  lanzarSiError(xml);
  const nro = textoTag(xml, "Cbte_nro");
  if (nro === null) throw new WsfexError("Respuesta sin Cbte_nro:\n" + xml.slice(0, 300));
  return Number(nro);
}

/**
 * Último Id de request usado por este CUIT (0 si nunca emitió).
 *
 * El Id es la clave de idempotencia de WSFEX: identifica al PEDIDO, no al
 * comprobante. Si una respuesta se pierde, reenviar el mismo Id devuelve el
 * CAE ya otorgado con Reproceso="S" en vez de emitir dos veces.
 */
export async function ultimoIdRequest(
  auth: AuthWsfex,
  produccion: boolean,
  _post?: PostFn
): Promise<number> {
  const xml = await llamar("FEXGetLast_ID", xmlAuth(auth), produccion, _post);
  lanzarSiError(xml);
  const id = textoTag(xml, "Id");
  if (id === null) throw new WsfexError("Respuesta sin Id:\n" + xml.slice(0, 300));
  return Number(id);
}

/**
 * Cotización oficial de WSFEX para la moneda.
 *
 * OJO: para PES el servicio responde error 1800 ("inexistente o SIN
 * cotización") — es esperable, la moneda local no cotiza contra sí misma. Por
 * eso emitir en pesos usa cotización 1 fija y NO llama acá.
 */
export async function cotizacionOficial(
  auth: AuthWsfex,
  produccion: boolean,
  moneda: Moneda,
  _post?: PostFn
): Promise<number> {
  const xml = await llamar(
    "FEXGetPARAM_Ctz",
    `${xmlAuth(auth)}<ar:Mon_id>${moneda}</ar:Mon_id>`,
    produccion,
    _post
  );
  lanzarSiError(xml);
  const ctz = textoTag(xml, "Mon_ctz");
  if (ctz === null) throw new WsfexError("ARCA no devolvió cotización:\n" + xml.slice(0, 300));
  return Number(ctz);
}

/** Todos los <bloque>…</bloque> de una respuesta, con los campos pedidos. */
function filas(xml: string, bloque: string, campos: string[]): Record<string, string>[] {
  const re = new RegExp(`<${bloque}>[\\s\\S]*?</${bloque}>`, "g");
  return (xml.match(re) ?? []).map((b) => {
    const fila: Record<string, string> = {};
    for (const c of campos) fila[c] = (textoTag(b, c) ?? "").trim();
    return fila;
  });
}

export interface PaisDestino {
  codigo: number;
  nombre: string;
}

/** Países de destino del comprobante (FEXGetPARAM_DST_pais). Suecia = 429. */
export async function paisesDestino(
  auth: AuthWsfex,
  produccion: boolean,
  _post?: PostFn
): Promise<PaisDestino[]> {
  const xml = await llamar("FEXGetPARAM_DST_pais", xmlAuth(auth), produccion, _post);
  lanzarSiError(xml);
  return filas(xml, "ClsFEXResponse_DST_pais", ["DST_Codigo", "DST_Ds"])
    .map((f) => ({ codigo: Number(f.DST_Codigo), nombre: f.DST_Ds }))
    .filter((p) => Number.isInteger(p.codigo) && p.nombre !== "");
}

export interface CuitPais {
  cuitPais: number;
  /** "SUECIA - Persona Jurídica". */
  descripcion: string;
}

/**
 * CUIT País de los clientes del exterior (FEXGetPARAM_DST_CUIT): 777 entradas,
 * una por país y tipo de persona. Es LA tabla que decide si un CUIT País es
 * válido — el dígito verificador no sirve para eso (ver esCuitPais en domain).
 */
export async function cuitsPais(
  auth: AuthWsfex,
  produccion: boolean,
  _post?: PostFn
): Promise<CuitPais[]> {
  const xml = await llamar("FEXGetPARAM_DST_CUIT", xmlAuth(auth), produccion, _post);
  lanzarSiError(xml);
  return filas(xml, "ClsFEXResponse_DST_cuit", ["DST_CUIT", "DST_Ds"])
    .map((f) => ({ cuitPais: Number(f.DST_CUIT), descripcion: f.DST_Ds }))
    .filter((c) => Number.isInteger(c.cuitPais) && c.descripcion !== "");
}

/**
 * Trae de ARCA un comprobante ya autorizado (FEXGetCMP). null si ese número
 * todavía no existe.
 *
 * Es la consulta que desempata después de un timeout: dice si el comprobante
 * llegó a emitirse o no. Un error de red acá SÍ se propaga — "no pude
 * preguntar" no es lo mismo que "no existe".
 */
export async function consultarComprobante(
  auth: AuthWsfex,
  produccion: boolean,
  cbteTipo: number,
  ptoVta: number,
  numero: number,
  _post?: PostFn
): Promise<{ cae: string; caeVto: Fecha } | null> {
  const xml = await llamar(
    "FEXGetCMP",
    `${xmlAuth(auth)}<ar:Cmp><ar:Cbte_tipo>${cbteTipo}</ar:Cbte_tipo>` +
      `<ar:Punto_vta>${ptoVta}</ar:Punto_vta><ar:Cbte_nro>${numero}</ar:Cbte_nro></ar:Cmp>`,
    produccion,
    _post
  );
  // Si el comprobante no existe, ARCA contesta con un FEXErr: eso no es una
  // falla, es la respuesta "todavía no está".
  if (extraerError(xml) !== null) return null;
  const cae = textoTag(xml, "Cae");
  const caeVto = fechaFromInt((textoTag(xml, "Fch_venc_Cae") ?? "").trim());
  if (!cae?.trim() || !caeVto) return null;
  return { cae: cae.trim(), caeVto };
}

// ---------------------------------------------------------------------------
// Emisión
// ---------------------------------------------------------------------------
export interface ExportacionParams {
  ptoVta: number;
  /** 19 = Factura E, 20 = ND E, 21 = NC E. */
  cbteTipo: number;
  /** 1 = Bienes, 2 = Servicios, 4 = Otros. */
  tipoExpo: TipoExpo;
  fecha: Fecha;
  receptor: ReceptorExterior;
  /** Expresado EN la moneda del comprobante. */
  importeTotal: number;
  moneda: Moneda;
  /** Cotización. Para PES es 1 y no se consulta (ver cotizacionOficial). */
  cotizacion?: number;
  /** true = el pago se cancela en la misma moneda extranjera (CanMisMonExt=S). */
  pagoMonedaExtranjera?: boolean;
  /** Descripción del renglón. A diferencia de la Factura C, VIAJA a ARCA. */
  descripcion: string;
  /** Unidad de medida (FEXGetPARAM_UMed). Default: 7 = unidades. */
  unidadMedida?: number;
  /** Idioma del comprobante. Default: 1 = Español. */
  idioma?: Idioma;
  /** Medio de pago, ej. "Criptomonedas". Campo REAL del WS, no del PDF. */
  formaPago?: string;
  /** Solo para exportación de bienes. */
  incoterms?: string;
  incotermsDesc?: string;
  /**
   * Fecha de pago (reemplaza al FchVtoPago del WSFEv1). OBLIGATORIA para
   * servicios; si no se indica, se usa la fecha de emisión.
   */
  fechaPago?: Fecha;
  /** Observaciones libres impresas en el comprobante. */
  observaciones?: string;
  obsComerciales?: string;
  /** Código de actividad del emisor (FEXGetPARAM_Actividades). */
  actividad?: number;
  /**
   * Permiso de embarque. Solo se setea para exportación de BIENES: para
   * servicios el default (vacío) es el único valor que ARCA acepta.
   */
  permisoExistente?: "S" | "N" | "";
  /** Para NC/ND: el comprobante original que ajusta. */
  asociado?: { tipo: number; ptoVta: number; nro: number; cuit: number };
}

/**
 * El ClsFEXRequest como XML, respetando el orden del WSDL.
 * Separado de la llamada para poder testearlo sin red (igual que
 * armarFecaeDet en wsfe.ts).
 */
export function armarCmpExpo(p: ExportacionParams, numero: number, id: number): string {
  const esPes = p.moneda === "PES";
  if (!esPes && !p.cotizacion) {
    throw new WsfexError(
      `Falta la cotización para emitir en ${p.moneda} (consultala con cotizacionOficial()).`
    );
  }
  if (!p.receptor.nombre.trim()) {
    throw new WsfexError("Falta el nombre del cliente del exterior (campo Cliente).");
  }

  const imp = p.importeTotal.toFixed(2);
  const t = (tag: string, valor: string | number) => `<ar:${tag}>${valor}</ar:${tag}>`;
  /** Tag con texto libre del usuario: SIEMPRE escapado. */
  const tx = (tag: string, valor: string) => t(tag, escaparXml(valor));

  const partes = [
    t("Id", id),
    t("Fecha_cbte", fechaToInt(p.fecha)),
    t("Cbte_Tipo", p.cbteTipo),
    t("Punto_vta", p.ptoVta),
    t("Cbte_nro", numero),
    t("Tipo_expo", p.tipoExpo),
  ];

  // Permiso de embarque. Dos reglas que ARCA solo revela emitiendo, y que
  // contradicen tanto al WSDL (minOccurs=0) como al folclore de "omitilo si
  // son servicios" — ambas verificadas en homologación (ago-2026):
  //   omitir el tag      → [1550] "...madatorio: Debe ser S, N o vacio (debe enviarse tag)"
  //   mandar "N" en expo → [1550] "...Debe ser 'vacio' para ... Tipo_expo=2 o 4"
  // O sea: el tag va SIEMPRE, y para servicios/otros va VACÍO.
  const soloBienes = p.tipoExpo === 1;
  partes.push(t("Permiso_existente", soloBienes ? (p.permisoExistente ?? "N") : ""));

  partes.push(
    t("Dst_cmp", p.receptor.paisDestino),
    tx("Cliente", p.receptor.nombre),
    t("Cuit_pais_cliente", p.receptor.cuitPais),
    tx("Domicilio_cliente", p.receptor.domicilio)
  );
  if (p.receptor.idImpositivo) partes.push(tx("Id_impositivo", p.receptor.idImpositivo));

  partes.push(t("Moneda_Id", p.moneda), t("Moneda_ctz", esPes ? "1" : String(p.cotizacion)));
  if (!esPes) partes.push(t("CanMisMonExt", p.pagoMonedaExtranjera ? "S" : "N"));

  if (p.obsComerciales) partes.push(tx("Obs_comerciales", p.obsComerciales));
  partes.push(t("Imp_total", imp));
  if (p.observaciones) partes.push(tx("Obs", p.observaciones));

  if (p.asociado) {
    partes.push(
      "<ar:Cmps_asoc><ar:Cmp_asoc>" +
        t("Cbte_tipo", p.asociado.tipo) +
        t("Cbte_punto_vta", p.asociado.ptoVta) +
        t("Cbte_nro", p.asociado.nro) +
        t("Cbte_cuit", String(p.asociado.cuit)) +
        "</ar:Cmp_asoc></ar:Cmps_asoc>"
    );
  }

  if (p.formaPago) partes.push(tx("Forma_pago", p.formaPago));
  if (p.incoterms) {
    partes.push(tx("Incoterms", p.incoterms));
    if (p.incotermsDesc) partes.push(tx("Incoterms_Ds", p.incotermsDesc));
  }
  partes.push(t("Idioma_cbte", p.idioma ?? 1));

  // Un solo ítem: el monto facturado ES el total (el modelo de este CLI).
  partes.push(
    "<ar:Items><ar:Item>" +
      t("Pro_codigo", "0001") +
      tx("Pro_ds", p.descripcion) +
      t("Pro_qty", "1") +
      t("Pro_umed", p.unidadMedida ?? UMED_UNIDADES) +
      t("Pro_precio_uni", imp) +
      t("Pro_bonificacion", "0") +
      t("Pro_total_item", imp) +
      "</ar:Item></ar:Items>"
  );

  // Fecha_pago: el WSDL la marca opcional, pero ARCA la exige para servicios
  // y "otros" —[1672]— y además pide que no sea anterior a la de emisión
  // —[1674]—. Default = fecha del comprobante, que cumple las dos.
  const fechaPago = p.fechaPago ?? (soloBienes ? undefined : p.fecha);
  if (fechaPago) {
    if (fechaToInt(fechaPago) < fechaToInt(p.fecha)) {
      throw new WsfexError(
        "La fecha de pago no puede ser anterior a la de emisión del comprobante."
      );
    }
    partes.push(t("Fecha_pago", fechaToInt(fechaPago)));
  }
  if (p.actividad) {
    partes.push(
      `<ar:Actividades><ar:Actividad>${t("Id", p.actividad)}</ar:Actividad></ar:Actividades>`
    );
  }
  return partes.join("");
}

export interface ResultadoExportacion {
  numero: number;
  cae: string;
  caeVto: Fecha;
  /** El Id de request usado (guardarlo: es la clave para reintentar sin duplicar). */
  id: number;
  /** "S" si ARCA devolvió un comprobante ya emitido en vez de crear uno nuevo. */
  reproceso: boolean;
  /**
   * true si el CAE no vino de la emisión sino de consultarlo después de un
   * timeout: el comprobante existía igual. El que llama debe avisarlo.
   */
  recuperado?: boolean;
  /** Motivos u observaciones no bloqueantes que ARCA adjuntó al aprobar. */
  observaciones: string[];
}

/** FEXAuthorize para un número e Id ya elegidos. Lanza si no sale "A". */
export async function autorizarExportacion(
  auth: AuthWsfex,
  produccion: boolean,
  p: ExportacionParams,
  numero: number,
  id: number,
  _post?: PostFn
): Promise<ResultadoExportacion> {
  const contenido =
    `${xmlAuth(auth)}<ar:Cmp>${armarCmpExpo(p, numero, id)}</ar:Cmp>`;

  const xml = await llamar("FEXAuthorize", contenido, produccion, _post);
  lanzarSiError(xml);

  const resultado = textoTag(xml, "Resultado");
  const motivos = (textoTag(xml, "Motivos_Obs") ?? "").trim();
  if (resultado !== "A") {
    throw new WsfexError(
      `ARCA rechazó el comprobante (Resultado=${resultado ?? "?"})` +
        (motivos ? `:\n${motivos}` : ".")
    );
  }

  const cae = textoTag(xml, "Cae");
  const caeVto = fechaFromInt((textoTag(xml, "Fch_venc_Cae") ?? "").trim());
  if (!cae || !caeVto) {
    throw new WsfexError("Aprobado pero sin CAE legible:\n" + xml.slice(0, 400));
  }

  const observaciones = extraerEventos(xml);
  if (motivos) observaciones.unshift(motivos);

  return {
    numero,
    cae,
    caeVto,
    id,
    reproceso: (textoTag(xml, "Reproceso") ?? "").trim() === "S",
    observaciones,
  };
}

/**
 * Emisión completa: consulta el último comprobante y el último Id de request,
 * y autoriza el siguiente. Es LA operación irreversible — si devuelve OK, el
 * comprobante existe en ARCA, y todo lo que siga (log, PDF) debe avisar
 * explícito si falla, nunca esconder el error.
 *
 * Si la llamada queda en el aire (timeout, corte de red), NO deja el problema
 * abierto: le pregunta a ARCA si el comprobante existe. Si existe, lo devuelve
 * marcado como `recuperado` para que igual se loguee y se genere el PDF; si no
 * existe, el error dice el número y el Id que se intentaron, que es lo único
 * que sirve para reintentar sin duplicar.
 */
export async function emitirExportacion(
  auth: AuthWsfex,
  produccion: boolean,
  p: ExportacionParams,
  _post?: PostFn
): Promise<ResultadoExportacion> {
  const ultimo = await ultimoAutorizado(auth, produccion, p.ptoVta, p.cbteTipo, _post);
  const ultimoId = await ultimoIdRequest(auth, produccion, _post);
  const numero = ultimo + 1;
  const id = ultimoId + 1;

  try {
    return await autorizarExportacion(auth, produccion, p, numero, id, _post);
  } catch (e) {
    if (!(e instanceof WsfexError) || !e.indeterminado) throw e;

    // Quedó en duda: preguntar antes de que el usuario reintente y duplique.
    let existente: { cae: string; caeVto: Fecha } | null = null;
    try {
      existente = await consultarComprobante(auth, produccion, p.cbteTipo, p.ptoVta, numero, _post);
    } catch {
      // No pudimos verificar. Eso NO significa que no se emitió: el mensaje
      // de abajo tiene que dejarlo clarísimo.
      throw new WsfexError(
        `${e.message}\n\n⚠️ Intenté emitir el comprobante N° ${numero} (Id de request ${id}) y ` +
          `tampoco pude verificar si salió.\n` +
          `NO reintentes a ciegas: podrías emitirlo dos veces. Volvé a correr el comando ` +
          `cuando ARCA responda — si el N° ${numero} ya existe, se va a ver en el próximo intento.`,
        e.codigo,
        true
      );
    }

    if (existente !== null) {
      return {
        numero,
        cae: existente.cae,
        caeVto: existente.caeVto,
        id,
        reproceso: false,
        recuperado: true,
        observaciones: [],
      };
    }
    throw new WsfexError(
      `${e.message}\n\n✅ Verifiqué con ARCA: el comprobante N° ${numero} NO se emitió ` +
        `(Id de request ${id}). Podés reintentar sin riesgo de duplicar.`,
      e.codigo
    );
  }
}

/** Los parámetros por default de una exportación de SERVICIOS (el caso base). */
export function paramsServicios(
  base: Omit<ExportacionParams, "cbteTipo" | "tipoExpo">
): ExportacionParams {
  return { ...base, cbteTipo: FACTURA_E, tipoExpo: 2 };
}
