/**
 * WSAA — autenticación con los web services de ARCA, con FIRMA LOCAL.
 *
 * El protocolo: se arma un XML (TRA, "ticket request"), se firma CMS/PKCS#7
 * con el certificado + private key del usuario, y se manda al servicio SOAP
 * LoginCms. ARCA devuelve un ticket de acceso (token + sign) válido por 12 hs
 * que después viaja en cada llamada al WSFE.
 *
 * La decisión de diseño clave de este paquete: la firma pasa acá adentro, con
 * node-forge (JS puro) — la private key NUNCA sale de la máquina del usuario.
 * (La alternativa de mercado, Afip SDK, firma en sus servidores.)
 *
 * Trampa conocida: si pedís un ticket nuevo mientras el anterior sigue vivo,
 * WSAA rechaza con "El CEE ya posee un TA valido". Por eso el ticket se
 * cachea en disco y se reusa hasta ~5 minutos antes de vencer.
 */

import fs from "node:fs";
import path from "node:path";

import forge from "node-forge";

import { postXml } from "./http.js";

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------
const URL_WSAA = {
  homologacion: "https://wsaahomo.afip.gov.ar/ws/services/LoginCms",
  produccion: "https://wsaa.afip.gov.ar/ws/services/LoginCms",
};

export interface TicketAcceso {
  token: string;
  sign: string;
  /** ISO 8601, con zona horaria, tal como lo devuelve WSAA. */
  expiration: string;
}

// ---------------------------------------------------------------------------
// 1) TRA: el pedido de ticket
// ---------------------------------------------------------------------------
/**
 * XML del LoginTicketRequest. La ventana generation/expiration es corta a
 * propósito (±10 min): solo tiene que cubrir el viaje hasta WSAA — la validez
 * del ticket resultante (12 hs) la decide ARCA, no este XML.
 */
export function construirTra(service: string, ahora: Date = new Date()): string {
  const gen = new Date(ahora.getTime() - 10 * 60_000);
  const exp = new Date(ahora.getTime() + 10 * 60_000);
  const uniqueId = Math.floor(ahora.getTime() / 1000);
  return `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${uniqueId}</uniqueId>
    <generationTime>${gen.toISOString()}</generationTime>
    <expirationTime>${exp.toISOString()}</expirationTime>
  </header>
  <service>${service}</service>
</loginTicketRequest>`;
}

// ---------------------------------------------------------------------------
// 2) Firma CMS (PKCS#7) — LOCAL, con node-forge
// ---------------------------------------------------------------------------
/** Firma el TRA y devuelve el CMS en base64, listo para LoginCms. */
export function firmarCms(traXml: string, certPem: string, keyPem: string): string {
  const cert = forge.pki.certificateFromPem(certPem);
  const key = forge.pki.privateKeyFromPem(keyPem);

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(traXml, "utf8");
  p7.addCertificate(cert);
  p7.addSigner({
    key: key as forge.pki.rsa.PrivateKey,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
  });
  p7.sign();

  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return forge.util.encode64(der);
}

// ---------------------------------------------------------------------------
// 3) LoginCms: canjear el CMS por el ticket
// ---------------------------------------------------------------------------
/**
 * Escapa texto para meterlo en un XML. En WSFEv1 no hacía falta (todo lo que
 * viaja son números), pero WSFEX manda texto libre del usuario — nombre del
 * cliente, domicilio, forma de pago, descripción — y un `&` suelto rompe el
 * request.
 */
export function escaparXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function desescaparXml(s: string): string {
  return s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/** Contenido del primer <tag>...</tag> del XML, o null si no está. */
export function textoTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : null;
}

export class WsaaError extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "WsaaError";
  }
}

/** Parsea la respuesta SOAP de LoginCms. Lanza WsaaError si vino un fault. */
export function parsearLoginResponse(xmlSoap: string): TicketAcceso {
  const fault = textoTag(xmlSoap, "faultstring");
  if (fault !== null) {
    let mensaje = `WSAA rechazó la autenticación: ${fault}`;
    if (/ya posee un TA valido/i.test(fault)) {
      mensaje +=
        "\n(Ya hay un ticket vigente para este certificado. Suele pasar si se " +
        "borró el cache: hay que esperar a que venza — dura 12 hs — o reusar el ticket.)";
    }
    throw new WsaaError(mensaje);
  }

  const retorno = textoTag(xmlSoap, "loginCmsReturn");
  if (retorno === null) {
    throw new WsaaError(`Respuesta de WSAA sin loginCmsReturn:\n${xmlSoap.slice(0, 500)}`);
  }

  const xmlTicket = desescaparXml(retorno);
  const token = textoTag(xmlTicket, "token");
  const sign = textoTag(xmlTicket, "sign");
  const expiration = textoTag(xmlTicket, "expirationTime");
  if (!token || !sign || !expiration) {
    throw new WsaaError("Ticket de WSAA incompleto (falta token, sign o expirationTime).");
  }
  return { token, sign, expiration };
}

async function loginCms(cms: string, produccion: boolean): Promise<TicketAcceso> {
  const url = produccion ? URL_WSAA.produccion : URL_WSAA.homologacion;
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soapenv:Body>
    <wsaa:loginCms>
      <wsaa:in0>${escaparXml(cms)}</wsaa:in0>
    </wsaa:loginCms>
  </soapenv:Body>
</soapenv:Envelope>`;

  let res: Awaited<ReturnType<typeof postXml>>;
  try {
    res = await postXml(
      url,
      {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: '""',
      },
      envelope
    );
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") {
      throw new WsaaError("WSAA no respondió en 60 segundos. Probá de nuevo en un rato.");
    }
    throw e;
  }
  const texto = await res.text();
  // WSAA responde los faults con HTTP 500: el cuerpo se parsea SIEMPRE,
  // porque el faultstring es el mensaje útil para el usuario.
  if (!res.ok && !texto.includes("faultstring")) {
    throw new WsaaError(`WSAA devolvió HTTP ${res.status}:\n${texto.slice(0, 500)}`);
  }
  return parsearLoginResponse(texto);
}

// ---------------------------------------------------------------------------
// 4) Cache del ticket (12 hs) — en disco, por servicio y entorno
// ---------------------------------------------------------------------------
/** true si al ticket le quedan más de 5 minutos de vida. */
export function ticketVigente(t: TicketAcceso, ahora: Date = new Date()): boolean {
  const vence = new Date(t.expiration).getTime();
  if (Number.isNaN(vence)) return false;
  return vence - ahora.getTime() > 5 * 60_000;
}

export interface OpcionesTicket {
  certPem: string;
  keyPem: string;
  produccion: boolean;
  /** Directorio donde cachear los tickets (wsaaCacheDir() de config). */
  cacheDir: string;
  service?: string;
  /** Hook de test: reemplaza la llamada de red a LoginCms. */
  _login?: (cms: string, produccion: boolean) => Promise<TicketAcceso>;
}

/**
 * Devuelve un ticket de acceso válido: el cacheado si sigue vivo, o uno
 * nuevo (TRA → firma local → LoginCms) que queda cacheado para las próximas.
 */
export async function obtenerTicket(opts: OpcionesTicket): Promise<TicketAcceso> {
  const service = opts.service ?? "wsfe";
  const entorno = opts.produccion ? "prod" : "homo";
  const cachePath = path.join(opts.cacheDir, `ta-${service}-${entorno}.json`);

  try {
    const cacheado = JSON.parse(fs.readFileSync(cachePath, "utf8")) as TicketAcceso;
    if (ticketVigente(cacheado)) return cacheado;
  } catch {
    // sin cache o ilegible: se pide uno nuevo
  }

  const tra = construirTra(service);
  const cms = firmarCms(tra, opts.certPem, opts.keyPem);
  const login = opts._login ?? loginCms;
  const ticket = await login(cms, opts.produccion);

  // El ticket ES una credencial (12 hs de validez): solo lo lee este usuario.
  fs.mkdirSync(opts.cacheDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(cachePath, JSON.stringify(ticket, null, 2) + "\n", { mode: 0o600 });
  return ticket;
}
