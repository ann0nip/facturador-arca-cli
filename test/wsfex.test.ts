import { describe, it, expect } from "vitest";

import {
  armarCmpExpo,
  autorizarExportacion,
  emitirExportacion,
  extraerError,
  extraerEventos,
  ultimoAutorizado,
  ultimoIdRequest,
  cotizacionOficial,
  WsfexError,
  type AuthWsfex,
  type ExportacionParams,
  type PostFn,
} from "../src/core/wsfex.js";
import type { ReceptorExterior } from "../src/core/domain.js";

const auth: AuthWsfex = { token: "tok==", sign: "sig==", cuit: 20372114356 };

/** El receptor de la factura de referencia del proyecto (Proxify, Suecia). */
const proxify: ReceptorExterior = {
  cuitPais: 55000004293,
  nombre: "Proxify",
  domicilio: "Barnhusgatan 3, Stockholm, 11123",
  paisDestino: 429, // SUECIA, según FEXGetPARAM_DST_pais
};

const base: ExportacionParams = {
  ptoVta: 6,
  cbteTipo: 19,
  tipoExpo: 2, // Servicios
  fecha: { y: 2026, m: 8, d: 6 },
  receptor: proxify,
  importeTotal: 1277320,
  moneda: "PES",
  descripcion: "Servicios profesionales",
  formaPago: "Criptomonedas",
  actividad: 620100,
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

describe("armarCmpExpo", () => {
  it("el caso de referencia (Proxify, servicios, en pesos): orden del WSDL", () => {
    const xml = armarCmpExpo(base, 1, 1);
    verificarOrden(xml, [
      "Id", "Fecha_cbte", "Cbte_Tipo", "Punto_vta", "Cbte_nro", "Tipo_expo",
      "Permiso_existente", "Dst_cmp", "Cliente", "Cuit_pais_cliente", "Domicilio_cliente",
      "Moneda_Id", "Moneda_ctz", "Imp_total", "Forma_pago", "Idioma_cbte",
      "Items", "Fecha_pago", "Actividades",
    ]);
    expect(xml).toContain("<ar:Fecha_cbte>20260806</ar:Fecha_cbte>");
    expect(xml).toContain("<ar:Cbte_Tipo>19</ar:Cbte_Tipo>");
    expect(xml).toContain("<ar:Tipo_expo>2</ar:Tipo_expo>");
    expect(xml).toContain("<ar:Dst_cmp>429</ar:Dst_cmp>");
    expect(xml).toContain("<ar:Cuit_pais_cliente>55000004293</ar:Cuit_pais_cliente>");
    expect(xml).toContain("<ar:Imp_total>1277320.00</ar:Imp_total>");
    expect(xml).toContain("<ar:Forma_pago>Criptomonedas</ar:Forma_pago>");
    expect(xml).toContain("<ar:Idioma_cbte>1</ar:Idioma_cbte>"); // default español
  });

  it("en pesos: cotización 1 fija, sin CanMisMonExt", () => {
    const xml = armarCmpExpo(base, 1, 1);
    expect(xml).toContain("<ar:Moneda_Id>PES</ar:Moneda_Id>");
    expect(xml).toContain("<ar:Moneda_ctz>1</ar:Moneda_ctz>");
    expect(xml).not.toContain("CanMisMonExt");
  });

  it("en dólares: exige cotización y agrega CanMisMonExt", () => {
    expect(() => armarCmpExpo({ ...base, moneda: "DOL" }, 1, 1)).toThrow(/cotización/);
    const xml = armarCmpExpo(
      { ...base, moneda: "DOL", cotizacion: 1152.42, pagoMonedaExtranjera: true },
      1,
      1
    );
    expect(xml).toContain("<ar:Moneda_ctz>1152.42</ar:Moneda_ctz>");
    expect(xml).toContain("<ar:CanMisMonExt>S</ar:CanMisMonExt>");
    verificarOrden(xml, ["Moneda_ctz", "CanMisMonExt", "Imp_total"]);
  });

  // Verificado contra homologación: omitir el tag da [1550] "debe enviarse
  // tag" y mandar "N" en una exportación de servicios da [1550] "debe ser
  // 'vacio' para ... Tipo_expo=2 o 4".
  it("servicios: el permiso de embarque va SIEMPRE, y vacío", () => {
    const xml = armarCmpExpo(base, 1, 1);
    expect(xml).toContain("<ar:Permiso_existente></ar:Permiso_existente>");
    verificarOrden(xml, ["Tipo_expo", "Permiso_existente", "Dst_cmp"]);
  });

  it("servicios: aunque le pasen un permiso, lo ignora (ARCA lo rechazaría)", () => {
    expect(armarCmpExpo({ ...base, permisoExistente: "N" }, 1, 1)).toContain(
      "<ar:Permiso_existente></ar:Permiso_existente>"
    );
  });

  it("bienes: el permiso de embarque sí lleva valor", () => {
    expect(armarCmpExpo({ ...base, tipoExpo: 1, permisoExistente: "S" }, 1, 1)).toContain(
      "<ar:Permiso_existente>S</ar:Permiso_existente>"
    );
    // sin indicarlo, default "N" (no hay permiso de embarque asociado)
    expect(armarCmpExpo({ ...base, tipoExpo: 1 }, 1, 1)).toContain(
      "<ar:Permiso_existente>N</ar:Permiso_existente>"
    );
  });

  // [1672]: es obligatoria para Tipo_expo 2 y 4, pese a que el WSDL la marca
  // minOccurs=0. [1674]: no puede ser anterior a la fecha de emisión.
  it("servicios: Fecha_pago se completa sola con la fecha de emisión", () => {
    expect(armarCmpExpo(base, 1, 1)).toContain("<ar:Fecha_pago>20260806</ar:Fecha_pago>");
  });

  it("servicios: una Fecha_pago explícita se respeta", () => {
    const xml = armarCmpExpo({ ...base, fechaPago: { y: 2026, m: 9, d: 15 } }, 1, 1);
    expect(xml).toContain("<ar:Fecha_pago>20260915</ar:Fecha_pago>");
  });

  it("Fecha_pago anterior a la emisión: error nuestro, sin molestar a ARCA", () => {
    expect(() =>
      armarCmpExpo({ ...base, fechaPago: { y: 2026, m: 8, d: 5 } }, 1, 1)
    ).toThrow(/fecha de pago no puede ser anterior/i);
  });

  it("bienes: sin Fecha_pago, no se inventa una", () => {
    expect(armarCmpExpo({ ...base, tipoExpo: 1 }, 1, 1)).not.toContain("Fecha_pago");
  });

  it("el ítem viaja a ARCA con el total como precio unitario", () => {
    const xml = armarCmpExpo(base, 1, 1);
    expect(xml).toContain(
      "<ar:Items><ar:Item><ar:Pro_codigo>0001</ar:Pro_codigo>" +
        "<ar:Pro_ds>Servicios profesionales</ar:Pro_ds>" +
        "<ar:Pro_qty>1</ar:Pro_qty><ar:Pro_umed>7</ar:Pro_umed>" +
        "<ar:Pro_precio_uni>1277320.00</ar:Pro_precio_uni>" +
        "<ar:Pro_bonificacion>0</ar:Pro_bonificacion>" +
        "<ar:Pro_total_item>1277320.00</ar:Pro_total_item></ar:Item></ar:Items>"
    );
  });

  it("el texto libre se escapa: un & suelto rompería el XML", () => {
    const xml = armarCmpExpo(
      {
        ...base,
        receptor: { ...proxify, nombre: "Smith & Sons <AB>" },
        descripcion: 'Consultoría "senior" & soporte',
        formaPago: "Cripto & transferencia",
      },
      1,
      1
    );
    expect(xml).toContain("<ar:Cliente>Smith &amp; Sons &lt;AB&gt;</ar:Cliente>");
    expect(xml).toContain("Consultor&iacute;a".replace("&iacute;", "í")); // acentos intactos
    expect(xml).toContain("&quot;senior&quot; &amp; soporte");
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/); // ningún & sin escapar
  });

  it("campos opcionales: solo aparecen si se los pasa", () => {
    const minimo = armarCmpExpo(
      { ptoVta: 6, cbteTipo: 19, tipoExpo: 2, fecha: { y: 2026, m: 8, d: 6 },
        receptor: proxify, importeTotal: 100, moneda: "PES", descripcion: "x" },
      1, 1
    );
    for (const tag of [
      "Id_impositivo", "Obs_comerciales", "Obs", "Cmps_asoc",
      "Forma_pago", "Incoterms", "Actividades",
    ]) {
      expect(minimo, `no debería aparecer ${tag}`).not.toContain(`<ar:${tag}>`);
    }
    // Actividades es opcional: verificado emitiendo sin el bloque en homologación
    expect(minimo).not.toContain("Actividades");
  });

  it("nota de crédito E: bloque Cmps_asoc con el comprobante original", () => {
    const xml = armarCmpExpo(
      { ...base, cbteTipo: 21, asociado: { tipo: 19, ptoVta: 6, nro: 1, cuit: 20372114356 } },
      2, 2
    );
    expect(xml).toContain(
      "<ar:Cmps_asoc><ar:Cmp_asoc><ar:Cbte_tipo>19</ar:Cbte_tipo>" +
        "<ar:Cbte_punto_vta>6</ar:Cbte_punto_vta><ar:Cbte_nro>1</ar:Cbte_nro>" +
        "<ar:Cbte_cuit>20372114356</ar:Cbte_cuit></ar:Cmp_asoc></ar:Cmps_asoc>"
    );
    verificarOrden(xml, ["Imp_total", "Cmps_asoc", "Forma_pago"]);
  });

  it("sin nombre de cliente: error claro antes de molestar a ARCA", () => {
    expect(() =>
      armarCmpExpo({ ...base, receptor: { ...proxify, nombre: "  " } }, 1, 1)
    ).toThrow(/nombre del cliente/i);
  });
});

// ---------------------------------------------------------------------------
// Respuestas del servicio (fixtures con la forma real del asmx)
// ---------------------------------------------------------------------------
const envuelto = (cuerpo: string) => `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>${cuerpo}</soap:Body></soap:Envelope>`;

const sinError = "<FEXErr><ErrCode>0</ErrCode><ErrMsg>OK</ErrMsg></FEXErr>";

const respUltimo = envuelto(
  `<FEXGetLast_CMPResponse xmlns="http://ar.gov.afip.dif.fexv1">
    <FEXResultGet><Cbte_nro>7</Cbte_nro><Cbte_fecha>20260805</Cbte_fecha></FEXResultGet>
    ${sinError}</FEXGetLast_CMPResponse>`
);

const respUltimoId = envuelto(
  `<FEXGetLast_IDResponse xmlns="http://ar.gov.afip.dif.fexv1">
    <FEXResultGet><Id>41</Id></FEXResultGet>${sinError}</FEXGetLast_IDResponse>`
);

const respAprobado = envuelto(
  `<FEXAuthorizeResponse xmlns="http://ar.gov.afip.dif.fexv1"><FEXResultAuth>
    <Id>42</Id><Cuit>20372114356</Cuit><Cbte_tipo>19</Cbte_tipo><Punto_vta>6</Punto_vta>
    <Cbte_nro>8</Cbte_nro><Cae>75316312117383</Cae><Fch_venc_Cae>20260806</Fch_venc_Cae>
    <Fch_cbte>20260806</Fch_cbte><Resultado>A</Resultado><Reproceso>N</Reproceso>
    <Motivos_Obs></Motivos_Obs></FEXResultAuth>${sinError}</FEXAuthorizeResponse>`
);

const respReproceso = respAprobado.replace(
  "<Reproceso>N</Reproceso>",
  "<Reproceso>S</Reproceso>"
);

const respRechazado = envuelto(
  `<FEXAuthorizeResponse xmlns="http://ar.gov.afip.dif.fexv1"><FEXResultAuth>
    <Resultado>R</Resultado><Motivos_Obs>1042: El campo Dst_cmp es invalido</Motivos_Obs>
    </FEXResultAuth>${sinError}</FEXAuthorizeResponse>`
);

const respErrorCtzPes = envuelto(
  `<FEXGetPARAM_CtzResponse xmlns="http://ar.gov.afip.dif.fexv1">
    <FEXErr><ErrCode>1800</ErrCode>
    <ErrMsg>Codigo de moneda (PES) inexistente o SIN cotizacion</ErrMsg></FEXErr>
  </FEXGetPARAM_CtzResponse>`
);

const respCtzDol = envuelto(
  `<FEXGetPARAM_CtzResponse xmlns="http://ar.gov.afip.dif.fexv1">
    <FEXResultGet><Mon_ctz>1152.42</Mon_ctz></FEXResultGet>${sinError}
  </FEXGetPARAM_CtzResponse>`
);

const postFijo =
  (respuesta: string): PostFn =>
  async () =>
    respuesta;

describe("extraerError", () => {
  it("ErrCode 0 no es un error", () => {
    expect(extraerError(respAprobado)).toBeNull();
  });

  it("devuelve código y mensaje cuando ErrCode != 0", () => {
    expect(extraerError(respErrorCtzPes)).toEqual({
      codigo: 1800,
      mensaje: "Codigo de moneda (PES) inexistente o SIN cotizacion",
    });
  });
});

describe("extraerEventos", () => {
  it("ignora los eventos vacíos y los de código 0", () => {
    const conEvento = envuelto(
      `<r><ClsFEXEvents><EventCode>0</EventCode><EventMsg></EventMsg></ClsFEXEvents>
       <ClsFEXEvents><EventCode>9000</EventCode><EventMsg>Aviso</EventMsg></ClsFEXEvents></r>`
    );
    expect(extraerEventos(conEvento)).toEqual(["[9000] Aviso"]);
  });
});

describe("ultimoAutorizado", () => {
  it("devuelve el número del último comprobante de exportación", async () => {
    expect(await ultimoAutorizado(auth, false, 6, 19, postFijo(respUltimo))).toBe(7);
  });

  it("manda Pto_venta y Cbte_Tipo DENTRO del bloque Auth", async () => {
    let enviado = "";
    const post: PostFn = async (_u, _h, body) => {
      enviado = body;
      return respUltimo;
    };
    await ultimoAutorizado(auth, false, 6, 19, post);
    expect(enviado).toContain(
      "<ar:Cuit>20372114356</ar:Cuit><ar:Pto_venta>6</ar:Pto_venta>" +
        "<ar:Cbte_Tipo>19</ar:Cbte_Tipo></ar:Auth>"
    );
  });
});

describe("ultimoIdRequest", () => {
  it("devuelve el último Id de request usado", async () => {
    expect(await ultimoIdRequest(auth, false, postFijo(respUltimoId))).toBe(41);
  });
});

describe("cotizacionOficial", () => {
  it("DOL: devuelve la cotización publicada", async () => {
    expect(await cotizacionOficial(auth, false, "DOL", postFijo(respCtzDol))).toBe(1152.42);
  });

  it("PES: el 1800 de ARCA llega con el hint de usar cotización 1", async () => {
    await expect(
      cotizacionOficial(auth, false, "PES", postFijo(respErrorCtzPes))
    ).rejects.toThrow(/\[1800\][\s\S]*Moneda_ctz = 1/);
  });
});

describe("autorizarExportacion", () => {
  it("aprobado: devuelve CAE, vencimiento, número e Id", async () => {
    const r = await autorizarExportacion(auth, false, base, 8, 42, postFijo(respAprobado));
    expect(r).toEqual({
      numero: 8,
      cae: "75316312117383",
      caeVto: { y: 2026, m: 8, d: 6 },
      id: 42,
      reproceso: false,
      observaciones: [],
    });
  });

  it("reproceso: marca que ARCA devolvió un comprobante ya emitido", async () => {
    const r = await autorizarExportacion(auth, false, base, 8, 42, postFijo(respReproceso));
    expect(r.reproceso).toBe(true);
    expect(r.cae).toBe("75316312117383");
  });

  it("rechazado: lanza con los motivos de ARCA", async () => {
    await expect(
      autorizarExportacion(auth, false, base, 8, 42, postFijo(respRechazado))
    ).rejects.toThrow(/Dst_cmp es invalido/);
  });

  it("SOAP fault: lanza con el faultstring", async () => {
    const fault = envuelto(
      `<soap:Fault><faultstring>No se pudo deserializar</faultstring></soap:Fault>`
    );
    await expect(
      autorizarExportacion(auth, false, base, 8, 42, postFijo(fault))
    ).rejects.toThrow(/No se pudo deserializar/);
  });
});

describe("emitirExportacion", () => {
  it("encadena último comprobante (7→8) y último Id (41→42)", async () => {
    const llamadas: string[] = [];
    const post: PostFn = async (_url, headers, body) => {
      const metodo = headers.SOAPAction;
      llamadas.push(metodo);
      if (metodo.includes("FEXGetLast_CMP")) return respUltimo;
      if (metodo.includes("FEXGetLast_ID")) return respUltimoId;
      expect(body).toContain("<ar:Cbte_nro>8</ar:Cbte_nro>");
      expect(body).toContain("<ar:Id>42</ar:Id>");
      return respAprobado;
    };
    const r = await emitirExportacion(auth, false, base, post);
    expect(r.numero).toBe(8);
    expect(r.id).toBe(42);
    expect(llamadas).toHaveLength(3);
  });

  it("si el rechazo llega antes del CAE, el error se propaga (nada se emitió)", async () => {
    const post: PostFn = async (_url, headers) => {
      if (headers.SOAPAction.includes("FEXGetLast_CMP")) return respUltimo;
      if (headers.SOAPAction.includes("FEXGetLast_ID")) return respUltimoId;
      return respRechazado;
    };
    await expect(emitirExportacion(auth, false, base, post)).rejects.toThrow(WsfexError);
  });
});
