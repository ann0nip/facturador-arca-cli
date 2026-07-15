import { describe, it, expect } from "vitest";

import {
  armarFecaeDet,
  solicitarCae,
  emitirComprobante,
  ultimoAutorizado,
  cotizacionOficial,
  extraerCodigos,
  WsfeError,
  type EmisionParams,
  type AuthWsfe,
  type PostFn,
} from "../src/core/wsfe.js";

const auth: AuthWsfe = { token: "tok==", sign: "sig==", cuit: 20409378472 };

const base: EmisionParams = {
  ptoVta: 3,
  cbteTipo: 11,
  concepto: 2,
  docTipo: 99,
  docNro: 0,
  condIvaReceptor: 5,
  importeTotal: 15000.5,
  fecha: { y: 2026, m: 7, d: 14 },
  moneda: "PES",
};

/** Asserts de orden: cada tag tiene que aparecer después del anterior. */
function verificarOrden(xml: string, tags: string[]) {
  let pos = -1;
  for (const tag of tags) {
    const idx = xml.indexOf(`<ar:${tag}>`);
    expect(idx, `falta o está fuera de orden: ${tag}`).toBeGreaterThan(pos);
    pos = idx;
  }
}

describe("armarFecaeDet", () => {
  it("servicios en pesos: período + orden del WSDL", () => {
    const xml = armarFecaeDet(base, 411);
    verificarOrden(xml, [
      "Concepto", "DocTipo", "DocNro", "CbteDesde", "CbteHasta", "CbteFch",
      "ImpTotal", "ImpTotConc", "ImpNeto", "ImpOpEx", "ImpTrib", "ImpIVA",
      "FchServDesde", "FchServHasta", "FchVtoPago", "MonId", "MonCotiz",
      "CondicionIVAReceptorId",
    ]);
    expect(xml).toContain("<ar:CbteFch>20260714</ar:CbteFch>");
    expect(xml).toContain("<ar:ImpTotal>15000.50</ar:ImpTotal>");
    expect(xml).toContain("<ar:ImpNeto>15000.50</ar:ImpNeto>"); // C: neto = total
    expect(xml).toContain("<ar:ImpIVA>0</ar:ImpIVA>");
    expect(xml).toContain("<ar:MonId>PES</ar:MonId>");
    expect(xml).toContain("<ar:MonCotiz>1</ar:MonCotiz>");
    expect(xml).not.toContain("CanMisMonExt"); // solo moneda extranjera
    // Período sin indicar → default = fecha de emisión
    expect(xml).toContain("<ar:FchServDesde>20260714</ar:FchServDesde>");
    expect(xml).toContain("<ar:FchVtoPago>20260714</ar:FchVtoPago>");
  });

  it("productos (concepto 1): sin período ni vencimiento", () => {
    const xml = armarFecaeDet({ ...base, concepto: 1 }, 411);
    expect(xml).not.toContain("FchServDesde");
    expect(xml).not.toContain("FchServHasta");
    expect(xml).not.toContain("FchVtoPago");
  });

  it("el caso de referencia: USD, período, vto de pago, receptor RI", () => {
    const xml = armarFecaeDet(
      {
        ptoVta: 3,
        cbteTipo: 11,
        concepto: 2,
        docTipo: 80,
        docNro: 30111111118,
        condIvaReceptor: 1, // Responsable Inscripto
        importeTotal: 3000,
        fecha: { y: 2026, m: 6, d: 22 },
        moneda: "DOL",
        cotizacion: 1461,
        pagoMonedaExtranjera: true,
        servDesde: { y: 2026, m: 6, d: 1 },
        servHasta: { y: 2026, m: 6, d: 30 },
        vtoPago: { y: 2026, m: 7, d: 10 },
      },
      411
    );
    expect(xml).toContain("<ar:ImpTotal>3000.00</ar:ImpTotal>");
    expect(xml).toContain("<ar:FchServDesde>20260601</ar:FchServDesde>");
    expect(xml).toContain("<ar:FchServHasta>20260630</ar:FchServHasta>");
    expect(xml).toContain("<ar:FchVtoPago>20260710</ar:FchVtoPago>");
    expect(xml).toContain("<ar:MonId>DOL</ar:MonId>");
    expect(xml).toContain("<ar:MonCotiz>1461</ar:MonCotiz>");
    expect(xml).toContain("<ar:CanMisMonExt>S</ar:CanMisMonExt>");
    expect(xml).toContain("<ar:CondicionIVAReceptorId>1</ar:CondicionIVAReceptorId>");
    // CanMisMonExt va ENTRE MonCotiz y CondicionIVAReceptorId (orden WSDL)
    verificarOrden(xml, ["MonCotiz", "CanMisMonExt", "CondicionIVAReceptorId"]);
  });

  it("moneda extranjera sin cotización → error claro", () => {
    expect(() => armarFecaeDet({ ...base, moneda: "DOL" }, 411)).toThrow(/cotización/);
  });

  it("nota de crédito: bloque CbtesAsoc con el comprobante original", () => {
    const xml = armarFecaeDet(
      { ...base, cbteTipo: 13, asociado: { tipo: 11, ptoVta: 3, nro: 410, cuit: 20409378472 } },
      12
    );
    expect(xml).toContain(
      "<ar:CbtesAsoc><ar:CbteAsoc><ar:Tipo>11</ar:Tipo><ar:PtoVta>3</ar:PtoVta>" +
        "<ar:Nro>410</ar:Nro><ar:Cuit>20409378472</ar:Cuit></ar:CbteAsoc></ar:CbtesAsoc>"
    );
  });
});

// ---------------------------------------------------------------------------
// Respuestas del servicio (fixtures con la forma real del asmx)
// ---------------------------------------------------------------------------
const envuelto = (cuerpo: string) => `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>${cuerpo}</soap:Body></soap:Envelope>`;

const respUltimo = envuelto(
  `<FECompUltimoAutorizadoResponse xmlns="http://ar.gov.afip.dif.FEV1">
    <FECompUltimoAutorizadoResult><PtoVta>3</PtoVta><CbteTipo>11</CbteTipo>
    <CbteNro>410</CbteNro></FECompUltimoAutorizadoResult>
  </FECompUltimoAutorizadoResponse>`
);

const respAprobado = envuelto(
  `<FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1"><FECAESolicitarResult>
    <FeCabResp><Cuit>20409378472</Cuit><PtoVta>3</PtoVta><CbteTipo>11</CbteTipo>
    <FchProceso>20260622213245</FchProceso><CantReg>1</CantReg><Resultado>A</Resultado>
    <Reproceso>N</Reproceso></FeCabResp>
    <FeDetResp><FECAEDetResponse><Concepto>2</Concepto><DocTipo>80</DocTipo>
    <DocNro>30111111118</DocNro><CbteDesde>411</CbteDesde><CbteHasta>411</CbteHasta>
    <CbteFch>20260622</CbteFch><Resultado>A</Resultado>
    <CAE>75123456789012</CAE><CAEFchVto>20260702</CAEFchVto></FECAEDetResponse></FeDetResp>
  </FECAESolicitarResult></FECAESolicitarResponse>`
);

const respRechazado = envuelto(
  `<FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1"><FECAESolicitarResult>
    <FeCabResp><Resultado>R</Resultado></FeCabResp>
    <FeDetResp><FECAEDetResponse><Resultado>R</Resultado>
    <Observaciones><Obs><Code>10016</Code>
    <Msg>Campo CbteFch debe ser mayor o igual a la fecha del ultimo comprobante</Msg>
    </Obs></Observaciones></FECAEDetResponse></FeDetResp>
  </FECAESolicitarResult></FECAESolicitarResponse>`
);

const respErrores = envuelto(
  `<FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1"><FECAESolicitarResult>
    <Errors><Err><Code>602</Code><Msg>Sin resultados para la consulta</Msg></Err></Errors>
  </FECAESolicitarResult></FECAESolicitarResponse>`
);

const respCotizacion = envuelto(
  `<FEParamGetCotizacionResponse xmlns="http://ar.gov.afip.dif.FEV1">
    <FEParamGetCotizacionResult><ResultGet><MonId>DOL</MonId>
    <MonCotiz>1461</MonCotiz><FchCotiz>20260713</FchCotiz></ResultGet>
  </FEParamGetCotizacionResult></FEParamGetCotizacionResponse>`
);

const postFijo =
  (respuesta: string): PostFn =>
  async () =>
    respuesta;

describe("extraerCodigos", () => {
  it("junta todos los Err de un bloque Errors", () => {
    expect(extraerCodigos(respErrores, "Err")).toEqual([
      { code: "602", msg: "Sin resultados para la consulta" },
    ]);
  });
});

describe("ultimoAutorizado", () => {
  it("devuelve el número del último comprobante", async () => {
    expect(await ultimoAutorizado(auth, false, 3, 11, postFijo(respUltimo))).toBe(410);
  });
});

describe("cotizacionOficial", () => {
  it("devuelve la cotización publicada por ARCA", async () => {
    const r = await cotizacionOficial(auth, false, "DOL", postFijo(respCotizacion));
    expect(r.cotizacion).toBe(1461);
    expect(r.fechaCotiz).toEqual({ y: 2026, m: 7, d: 13 });
  });
});

describe("solicitarCae", () => {
  it("aprobado: devuelve CAE, vencimiento y número", async () => {
    const r = await solicitarCae(auth, false, base, 411, postFijo(respAprobado));
    expect(r).toEqual({
      numero: 411,
      cae: "75123456789012",
      caeVto: { y: 2026, m: 7, d: 2 },
      observaciones: [],
    });
  });

  it("rechazado: lanza con las observaciones y el hint del 10016", async () => {
    await expect(
      solicitarCae(auth, false, base, 411, postFijo(respRechazado))
    ).rejects.toThrow(/10016[\s\S]*numeración cronológica/);
  });

  it("errores generales: lanza con código y mensaje", async () => {
    await expect(
      solicitarCae(auth, false, base, 411, postFijo(respErrores))
    ).rejects.toThrow(/\[602\] Sin resultados/);
  });

  it("SOAP fault: lanza con el faultstring", async () => {
    const fault = envuelto(
      `<soap:Fault><faultcode>soap:Client</faultcode><faultstring>No se pudo deserializar</faultstring></soap:Fault>`
    );
    await expect(solicitarCae(auth, false, base, 411, postFijo(fault))).rejects.toThrow(
      /No se pudo deserializar/
    );
  });
});

describe("emitirComprobante", () => {
  it("consulta el último y emite el siguiente (410 → 411)", async () => {
    const llamadas: string[] = [];
    const post: PostFn = async (_url, headers, body) => {
      const metodo = headers.SOAPAction;
      llamadas.push(metodo);
      if (metodo.includes("FECompUltimoAutorizado")) return respUltimo;
      expect(body).toContain("<ar:CbteDesde>411</ar:CbteDesde>");
      return respAprobado;
    };
    const r = await emitirComprobante(auth, false, base, post);
    expect(r.numero).toBe(411);
    expect(r.cae).toBe("75123456789012");
    expect(llamadas).toHaveLength(2);
  });

  it("si el rechazo llega antes del CAE, el error se propaga (nada se emitió)", async () => {
    const post: PostFn = async (_url, headers) =>
      headers.SOAPAction.includes("FECompUltimoAutorizado") ? respUltimo : respRechazado;
    await expect(emitirComprobante(auth, false, base, post)).rejects.toThrow(WsfeError);
  });
});
