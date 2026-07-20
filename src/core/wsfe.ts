/**
 * WSFE — el web service de facturación electrónica de ARCA (WSFEv1).
 *
 * SOAP 1.1 armado a mano con fetch + templates XML: el servicio es chico y
 * estable, no amerita un cliente SOAP genérico. ⚠️ El ORDEN de los campos
 * importa (schema sequence): el de acá abajo está verificado contra el WSDL
 * real de homologación (jul-2026), no contra el manual:
 *
 *   Concepto, DocTipo, DocNro, CbteDesde, CbteHasta, CbteFch,
 *   ImpTotal, ImpTotConc, ImpNeto, ImpOpEx, ImpTrib, ImpIVA,
 *   FchServDesde, FchServHasta, FchVtoPago, MonId, MonCotiz,
 *   CanMisMonExt, CondicionIVAReceptorId, CbtesAsoc, ...
 *
 * Autenticación: el ticket (token + sign) viene de wsaa.ts.
 */

import {
  type Concepto,
  type Fecha,
  type Moneda,
  fechaToInt,
  fechaFromInt,
  usaPeriodo,
} from "./domain.js";
import { textoTag } from "./wsaa.js";
import { postXml } from "./http.js";

const URL_WSFE = {
  homologacion: "https://wswhomo.afip.gov.ar/wsfev1/service.asmx",
  produccion: "https://servicios1.afip.gov.ar/wsfev1/service.asmx",
};
// ⚠️ La barra final NO es decorativa: es el targetNamespace EXACTO del WSDL.
// Sin ella, ARCA encuentra el método (el SOAPAction queda idéntico de
// casualidad) pero no deserializa los campos → error 500 "Campo Auth no fue
// ingresado". Costó un rato de debugging — no la borres.
const NS = "http://ar.gov.afip.dif.FEV1/";

export interface AuthWsfe {
  token: string;
  sign: string;
  cuit: number;
}

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------
export interface CodigoMsg {
  code: string;
  msg: string;
}

export class WsfeError extends Error {
  readonly codigos: CodigoMsg[];

  constructor(titulo: string, codigos: CodigoMsg[] = []) {
    let mensaje = [titulo, ...codigos.map((c) => `[${c.code}] ${c.msg}`)].join("\n");
    if (codigos.some((c) => c.code === "10016")) {
      mensaje +=
        "\n💡 El 10016 suele ser por la fecha: no puede ser anterior a la del " +
        "último comprobante emitido en ese punto de venta (numeración " +
        "cronológica). Probá con una fecha más reciente o con hoy.";
    }
    if (codigos.some((c) => c.code === "10015")) {
      mensaje +=
        "\n💡 Si estás en modo práctica (homologación): ese entorno tiene su " +
        "propio padrón y no conoce los CUIT reales. Probá facturándote a tu " +
        "propio CUIT. En producción este error solo aparece si el CUIT " +
        "realmente no está registrado en ARCA.";
    }
    super(mensaje);
    this.name = "WsfeError";
    this.codigos = codigos;
  }
}

/** Todos los <Err> o <Obs> de una respuesta, como {code, msg}. */
export function extraerCodigos(xml: string, tag: "Err" | "Obs"): CodigoMsg[] {
  const bloques = xml.match(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g")) ?? [];
  return bloques.map((b) => ({
    code: textoTag(b, "Code") ?? "?",
    msg: textoTag(b, "Msg") ?? "",
  }));
}

function lanzarSiErrores(xml: string): void {
  const errores = extraerCodigos(xml, "Err");
  if (errores.length > 0) throw new WsfeError("ARCA devolvió errores:", errores);
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
    if (e instanceof Error && e.name === "TimeoutError") {
      throw new WsfeError(
        "WSFE no respondió en 60 segundos. OJO: si estabas emitiendo, verificá " +
          "en ARCA (Mis Comprobantes) si la factura salió ANTES de reintentar, " +
          "para no emitirla dos veces."
      );
    }
    throw e;
  }
  const texto = await res.text();
  // Los faults SOAP vienen con HTTP 500: el cuerpo igual trae el mensaje útil.
  if (!res.ok && !texto.includes("faultstring")) {
    throw new WsfeError(`WSFE devolvió HTTP ${res.status}:\n${texto.slice(0, 500)}`);
  }
  return texto;
}

async function llamar(
  metodo: string,
  contenido: string,
  produccion: boolean,
  _post?: PostFn
): Promise<string> {
  const url = produccion ? URL_WSFE.produccion : URL_WSFE.homologacion;
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${NS}">
  <soap:Body><ar:${metodo}>${contenido}</ar:${metodo}></soap:Body>
</soap:Envelope>`;

  const post = _post ?? postHttp;
  const texto = await post(
    url,
    {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: `"${NS}${metodo}"`,
    },
    envelope
  );
  const fault = textoTag(texto, "faultstring");
  if (fault !== null) throw new WsfeError(`WSFE rechazó la llamada: ${fault}`);
  return texto;
}

/** El bloque Auth que viaja en cada llamada (token y sign son base64: XML-safe). */
function xmlAuth(auth: AuthWsfe): string {
  return (
    `<ar:Auth><ar:Token>${auth.token}</ar:Token>` +
    `<ar:Sign>${auth.sign}</ar:Sign><ar:Cuit>${auth.cuit}</ar:Cuit></ar:Auth>`
  );
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------
/** Número del último comprobante autorizado en ese PV+tipo (0 si no hay). */
export async function ultimoAutorizado(
  auth: AuthWsfe,
  produccion: boolean,
  ptoVta: number,
  cbteTipo: number,
  _post?: PostFn
): Promise<number> {
  const xml = await llamar(
    "FECompUltimoAutorizado",
    `${xmlAuth(auth)}<ar:PtoVta>${ptoVta}</ar:PtoVta><ar:CbteTipo>${cbteTipo}</ar:CbteTipo>`,
    produccion,
    _post
  );
  lanzarSiErrores(xml);
  const nro = textoTag(xml, "CbteNro");
  if (nro === null) throw new WsfeError("Respuesta sin CbteNro:\n" + xml.slice(0, 300));
  return Number(nro);
}

/**
 * Cotización oficial que publica ARCA para la moneda (la que valida al
 * emitir en moneda extranjera). FchCotiz llega como aaaammdd.
 */
export async function cotizacionOficial(
  auth: AuthWsfe,
  produccion: boolean,
  moneda: Moneda,
  _post?: PostFn
): Promise<{ cotizacion: number; fechaCotiz: Fecha | null }> {
  const xml = await llamar(
    "FEParamGetCotizacion",
    `${xmlAuth(auth)}<ar:MonId>${moneda}</ar:MonId>`,
    produccion,
    _post
  );
  lanzarSiErrores(xml);
  const cot = textoTag(xml, "MonCotiz");
  if (cot === null) {
    throw new WsfeError("ARCA no devolvió cotización:\n" + xml.slice(0, 300));
  }
  const fch = textoTag(xml, "FchCotiz");
  return { cotizacion: Number(cot), fechaCotiz: fch ? fechaFromInt(fch) : null };
}

// ---------------------------------------------------------------------------
// Emisión
// ---------------------------------------------------------------------------
export interface EmisionParams {
  ptoVta: number;
  /** 11 = Factura C, 13 = Nota de Crédito C. */
  cbteTipo: number;
  concepto: Concepto;
  docTipo: number;
  docNro: number;
  condIvaReceptor: number;
  /** Expresado EN la moneda del comprobante (USD si moneda=DOL). */
  importeTotal: number;
  fecha: Fecha;
  moneda: Moneda;
  /** Cotización oficial (cotizacionOficial()). Ignorada para PES. */
  cotizacion?: number;
  /** true = el pago se cancela en la misma moneda extranjera (CanMisMonExt=S). */
  pagoMonedaExtranjera?: boolean;
  /** Solo servicios (concepto 2/3); para productos NO deben mandarse. */
  servDesde?: Fecha;
  servHasta?: Fecha;
  /** Fecha de vto. para el pago (default: la de emisión). Solo servicios. */
  vtoPago?: Fecha;
  /** Para NC: el comprobante original que anula/ajusta (RG 4540/2019). */
  asociado?: { tipo: number; ptoVta: number; nro: number; cuit: number };
}

/**
 * El detalle FECAEDetRequest como XML, respetando el orden del WSDL.
 * Separado de la llamada para poder testearlo sin red.
 */
export function armarFecaeDet(p: EmisionParams, numero: number): string {
  const esPes = p.moneda === "PES";
  if (!esPes && !p.cotizacion) {
    throw new WsfeError(
      `Falta la cotización para emitir en ${p.moneda} (consultala con cotizacionOficial()).`
    );
  }
  const imp = p.importeTotal.toFixed(2);
  const t = (tag: string, valor: string | number) => `<ar:${tag}>${valor}</ar:${tag}>`;

  const partes = [
    t("Concepto", p.concepto),
    t("DocTipo", p.docTipo),
    t("DocNro", p.docNro),
    t("CbteDesde", numero),
    t("CbteHasta", numero),
    t("CbteFch", fechaToInt(p.fecha)),
    t("ImpTotal", imp),
    t("ImpTotConc", "0"),
    t("ImpNeto", imp), // Factura C: neto = total, sin IVA
    t("ImpOpEx", "0"),
    t("ImpTrib", "0"),
    t("ImpIVA", "0"),
  ];
  if (usaPeriodo(p.concepto)) {
    // Período facturado: si no se indica, default = fecha de emisión.
    partes.push(t("FchServDesde", fechaToInt(p.servDesde ?? p.fecha)));
    partes.push(t("FchServHasta", fechaToInt(p.servHasta ?? p.fecha)));
    partes.push(t("FchVtoPago", fechaToInt(p.vtoPago ?? p.fecha)));
  }
  partes.push(t("MonId", p.moneda));
  partes.push(t("MonCotiz", esPes ? "1" : String(p.cotizacion)));
  if (!esPes) {
    partes.push(t("CanMisMonExt", p.pagoMonedaExtranjera ? "S" : "N"));
  }
  partes.push(t("CondicionIVAReceptorId", p.condIvaReceptor));
  if (p.asociado) {
    partes.push(
      "<ar:CbtesAsoc><ar:CbteAsoc>" +
        t("Tipo", p.asociado.tipo) +
        t("PtoVta", p.asociado.ptoVta) +
        t("Nro", p.asociado.nro) +
        t("Cuit", String(p.asociado.cuit)) +
        "</ar:CbteAsoc></ar:CbtesAsoc>"
    );
  }
  return partes.join("");
}

export interface ResultadoEmision {
  numero: number;
  cae: string;
  caeVto: Fecha;
  /** Observaciones no bloqueantes que ARCA adjuntó al aprobar. */
  observaciones: string[];
}

/** FECAESolicitar para un número ya elegido. Lanza WsfeError si no sale "A". */
export async function solicitarCae(
  auth: AuthWsfe,
  produccion: boolean,
  p: EmisionParams,
  numero: number,
  _post?: PostFn
): Promise<ResultadoEmision> {
  const contenido =
    `${xmlAuth(auth)}<ar:FeCAEReq>` +
    `<ar:FeCabReq><ar:CantReg>1</ar:CantReg><ar:PtoVta>${p.ptoVta}</ar:PtoVta>` +
    `<ar:CbteTipo>${p.cbteTipo}</ar:CbteTipo></ar:FeCabReq>` +
    `<ar:FeDetReq><ar:FECAEDetRequest>${armarFecaeDet(p, numero)}</ar:FECAEDetRequest></ar:FeDetReq>` +
    `</ar:FeCAEReq>`;

  const xml = await llamar("FECAESolicitar", contenido, produccion, _post);
  lanzarSiErrores(xml);

  const resultado = textoTag(xml, "Resultado"); // el de FeCabResp (viene primero)
  const obs = extraerCodigos(xml, "Obs");
  if (resultado !== "A") {
    throw new WsfeError("ARCA rechazó el comprobante:", obs);
  }

  const cae = textoTag(xml, "CAE");
  const caeVto = fechaFromInt(textoTag(xml, "CAEFchVto") ?? "");
  if (!cae || !caeVto) {
    throw new WsfeError("Aprobado pero sin CAE legible:\n" + xml.slice(0, 300));
  }
  return {
    numero,
    cae,
    caeVto,
    observaciones: obs.map((o) => `[${o.code}] ${o.msg}`),
  };
}

/**
 * Emisión completa: consulta el último autorizado y solicita el CAE para el
 * siguiente número. Es LA operación irreversible: si devuelve OK, el
 * comprobante existe en ARCA — todo lo que siga (log, PDF) debe avisar
 * explícito si falla, nunca esconder el error.
 */
export async function emitirComprobante(
  auth: AuthWsfe,
  produccion: boolean,
  p: EmisionParams,
  _post?: PostFn
): Promise<ResultadoEmision> {
  const ultimo = await ultimoAutorizado(auth, produccion, p.ptoVta, p.cbteTipo, _post);
  return solicitarCae(auth, produccion, p, ultimo + 1, _post);
}
