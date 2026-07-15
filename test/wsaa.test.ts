import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import forge from "node-forge";

import {
  construirTra,
  firmarCms,
  parsearLoginResponse,
  ticketVigente,
  obtenerTicket,
  textoTag,
  WsaaError,
  type TicketAcceso,
} from "../src/core/wsaa.js";

// Certificado autofirmado de prueba, generado en memoria: mismo formato PEM
// que el que emite ARCA, sin necesitar credenciales reales para testear.
function certDePrueba(): { certPem: string; keyPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const attrs = [
    { name: "commonName", value: "test-facturador" },
    { name: "countryName", value: "AR" },
    { name: "organizationName", value: "Test" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

describe("construirTra", () => {
  it("arma el XML con servicio y ventana de tiempo válida", () => {
    const ahora = new Date("2026-07-14T12:00:00Z");
    const tra = construirTra("wsfe", ahora);
    expect(tra).toContain("<service>wsfe</service>");
    expect(tra).toContain("<generationTime>2026-07-14T11:50:00.000Z</generationTime>");
    expect(tra).toContain("<expirationTime>2026-07-14T12:10:00.000Z</expirationTime>");
    expect(textoTag(tra, "uniqueId")).toBe(String(Math.floor(ahora.getTime() / 1000)));
  });
});

describe("firmarCms", () => {
  it("produce un PKCS#7 válido que contiene el TRA", () => {
    const { certPem, keyPem } = certDePrueba();
    const tra = construirTra("wsfe");
    const cms = firmarCms(tra, certPem, keyPem);

    // Tiene que ser base64 decodificable a un ASN.1 PKCS#7 parseable...
    const der = forge.util.decode64(cms);
    const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(der));
    expect(p7).toBeDefined();
    // ...y el contenido firmado tiene que ser el TRA, embebido tal cual.
    expect(der).toContain("<loginTicketRequest");
    expect(der).toContain("<service>wsfe</service>");
  });

  it("rechaza PEMs inválidos", () => {
    expect(() => firmarCms("<x/>", "no soy un cert", "no soy una key")).toThrow();
  });
});

describe("parsearLoginResponse", () => {
  const respuestaOk = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <loginCmsResponse xmlns="https://wsaahomo.afip.gov.ar/ws/services/LoginCms">
      <loginCmsReturn>&lt;?xml version=&quot;1.0&quot; encoding=&quot;UTF-8&quot; standalone=&quot;yes&quot;?&gt;
&lt;loginTicketResponse version=&quot;1.0&quot;&gt;
  &lt;header&gt;&lt;source&gt;CN=wsaahomo&lt;/source&gt;&lt;destination&gt;SERIALNUMBER=CUIT 20409378472&lt;/destination&gt;
  &lt;expirationTime&gt;2026-07-15T00:00:00.000-03:00&lt;/expirationTime&gt;&lt;/header&gt;
  &lt;credentials&gt;&lt;token&gt;PD94bWwgdG9rZW4=&lt;/token&gt;&lt;sign&gt;q6sFirmaBase64==&lt;/sign&gt;&lt;/credentials&gt;
&lt;/loginTicketResponse&gt;</loginCmsReturn>
    </loginCmsResponse>
  </soapenv:Body>
</soapenv:Envelope>`;

  it("extrae token, sign y expiration del XML escapado", () => {
    const ticket = parsearLoginResponse(respuestaOk);
    expect(ticket.token).toBe("PD94bWwgdG9rZW4=");
    expect(ticket.sign).toBe("q6sFirmaBase64==");
    expect(ticket.expiration).toBe("2026-07-15T00:00:00.000-03:00");
  });

  it("convierte un SOAP fault en un error legible", () => {
    const fault = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body><soapenv:Fault><faultcode>ns1:cms.cert.expired</faultcode>
  <faultstring>Certificado expirado</faultstring></soapenv:Fault></soapenv:Body>
</soapenv:Envelope>`;
    expect(() => parsearLoginResponse(fault)).toThrow(WsaaError);
    expect(() => parsearLoginResponse(fault)).toThrow(/Certificado expirado/);
  });

  it("explica el fault de TA todavía vigente", () => {
    const fault = `<x><faultstring>El CEE ya posee un TA valido para el acceso al WSN solicitado</faultstring></x>`;
    expect(() => parsearLoginResponse(fault)).toThrow(/ticket vigente/);
  });
});

describe("ticketVigente", () => {
  const ticket = (expiration: string): TicketAcceso => ({ token: "t", sign: "s", expiration });

  it("vivo si le queda más de 5 minutos", () => {
    const ahora = new Date("2026-07-14T12:00:00Z");
    expect(ticketVigente(ticket("2026-07-14T18:00:00Z"), ahora)).toBe(true);
    expect(ticketVigente(ticket("2026-07-14T12:04:00Z"), ahora)).toBe(false); // por vencer
    expect(ticketVigente(ticket("2026-07-14T11:00:00Z"), ahora)).toBe(false); // vencido
    expect(ticketVigente(ticket("no es una fecha"), ahora)).toBe(false);
  });
});

describe("obtenerTicket (cache)", () => {
  let tmpDir: string;
  const { certPem, keyPem } = certDePrueba();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wsaa-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("pide un ticket nuevo, lo cachea y lo reusa sin volver a la red", async () => {
    const enUnaHora = new Date(Date.now() + 3_600_000).toISOString();
    let llamadas = 0;

    const primero = await obtenerTicket({
      certPem,
      keyPem,
      produccion: false,
      cacheDir: tmpDir,
      _login: async () => {
        llamadas++;
        return { token: "tok", sign: "sig", expiration: enUnaHora };
      },
    });
    expect(primero.token).toBe("tok");
    expect(llamadas).toBe(1);

    // Segunda llamada: si toca la red, el hook explota → probaría que el
    // cache no funcionó.
    const segundo = await obtenerTicket({
      certPem,
      keyPem,
      produccion: false,
      cacheDir: tmpDir,
      _login: async () => {
        throw new Error("NO tendría que haber ido a la red");
      },
    });
    expect(segundo).toEqual(primero);
  });

  it("renueva si el ticket cacheado ya venció", async () => {
    const vencido = new Date(Date.now() - 3_600_000).toISOString();
    fs.writeFileSync(
      path.join(tmpDir, "ta-wsfe-homo.json"),
      JSON.stringify({ token: "viejo", sign: "s", expiration: vencido })
    );

    const ticket = await obtenerTicket({
      certPem,
      keyPem,
      produccion: false,
      cacheDir: tmpDir,
      _login: async () => ({
        token: "nuevo",
        sign: "s",
        expiration: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    });
    expect(ticket.token).toBe("nuevo");
  });

  it("separa el cache de homologación y producción", async () => {
    const exp = new Date(Date.now() + 3_600_000).toISOString();
    await obtenerTicket({
      certPem, keyPem, produccion: false, cacheDir: tmpDir,
      _login: async () => ({ token: "homo", sign: "s", expiration: exp }),
    });
    const prod = await obtenerTicket({
      certPem, keyPem, produccion: true, cacheDir: tmpDir,
      _login: async () => ({ token: "prod", sign: "s", expiration: exp }),
    });
    expect(prod.token).toBe("prod");
    expect(fs.existsSync(path.join(tmpDir, "ta-wsfe-homo.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "ta-wsfe-prod.json"))).toBe(true);
  });
});
