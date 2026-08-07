import { describe, it, expect } from "vitest";
import {
  parsearMonto,
  MontoInvalidoError,
  fmtArs,
  parsearCuit,
  parsearDoc,
  fmtCuit,
  fmtDoc,
  descripcionReceptor,
  RECEPTOR_CF,
  DOC_TIPO_CUIT,
  DOC_TIPO_DNI,
  crearFecha,
  hoyAr,
  fechaToInt,
  fechaToIso,
  fmtFecha,
  addDias,
  cmpFecha,
  parsearFecha,
  validarFecha,
  parsearPeriodo,
  usaPeriodo,
  diasAtrasMax,
  urlQrArca,
  nombreComprobante,
  numeroCompleto,
  esExportacion,
  esCuitPais,
  parsearCuitPais,
  validarFechaExpo,
  FACTURA_E,
  NOTA_CREDITO_E,
} from "../src/core/domain.js";

describe("parsearMonto", () => {
  it("acepta enteros pelados", () => {
    expect(parsearMonto("15000")).toBe(15000);
  });
  it("acepta miles con punto (AR)", () => {
    expect(parsearMonto("15.000")).toBe(15000);
    expect(parsearMonto("450.000")).toBe(450000);
    expect(parsearMonto("1.234.567")).toBe(1234567);
  });
  it("acepta miles con coma (US)", () => {
    expect(parsearMonto("15,000")).toBe(15000);
  });
  it("acepta decimales AR (coma)", () => {
    expect(parsearMonto("15000,50")).toBe(15000.5);
    expect(parsearMonto("15.000,50")).toBe(15000.5);
    expect(parsearMonto("450.000,00")).toBe(450000);
  });
  it("acepta decimales US (punto)", () => {
    expect(parsearMonto("15000.5")).toBe(15000.5);
    expect(parsearMonto("15,000.50")).toBe(15000.5);
  });
  it("ignora $ y espacios", () => {
    expect(parsearMonto("$15000")).toBe(15000);
    expect(parsearMonto("  15 000  ")).toBe(15000);
  });
  it("redondea a 2 decimales", () => {
    expect(parsearMonto("100.999")).toBe(100999); // agrupación de miles, no decimal
    expect(parsearMonto("100.9999")).toBe(101); // decimal largo → redondea
  });
  it("rechaza basura, negativos y cero", () => {
    expect(() => parsearMonto("abc")).toThrow(MontoInvalidoError);
    expect(() => parsearMonto("-50")).toThrow(MontoInvalidoError);
    expect(() => parsearMonto("0")).toThrow(MontoInvalidoError);
    expect(() => parsearMonto("")).toThrow(MontoInvalidoError);
    expect(() => parsearMonto("1,2,3")).toThrow(MontoInvalidoError);
  });
});

describe("fmtArs", () => {
  it("formatea en estilo argentino", () => {
    expect(fmtArs(15000.5)).toBe("15.000,50");
    expect(fmtArs(1234567.89)).toBe("1.234.567,89");
    expect(fmtArs(1000)).toBe("1.000,00");
  });
});

describe("parsearCuit", () => {
  it("acepta un CUIT válido con y sin guiones", () => {
    expect(parsearCuit("20409378472")).toBe(20409378472);
    expect(parsearCuit("20-40937847-2")).toBe(20409378472);
    expect(parsearCuit("20-12345678-6")).toBe(20123456786);
  });
  it("rechaza dígito verificador incorrecto", () => {
    expect(parsearCuit("20409378471")).toBeNull();
    expect(parsearCuit("20123456780")).toBeNull();
  });
  it("rechaza largos incorrectos", () => {
    expect(parsearCuit("123")).toBeNull();
    expect(parsearCuit("201234567861")).toBeNull();
  });
});

describe("parsearDoc", () => {
  it("detecta CUIT", () => {
    expect(parsearDoc("20-12345678-6")).toEqual({ docTipo: DOC_TIPO_CUIT, docNro: 20123456786 });
  });
  it("detecta DNI de 7 y 8 dígitos", () => {
    expect(parsearDoc("12345678")).toEqual({ docTipo: DOC_TIPO_DNI, docNro: 12345678 });
    expect(parsearDoc("1234567")).toEqual({ docTipo: DOC_TIPO_DNI, docNro: 1234567 });
    expect(parsearDoc("12.345.678")).toEqual({ docTipo: DOC_TIPO_DNI, docNro: 12345678 });
  });
  it("rechaza lo que no es ni CUIT ni DNI", () => {
    expect(parsearDoc("123456")).toBeNull(); // 6 dígitos
    expect(parsearDoc("20409378471")).toBeNull(); // CUIT con verificador malo
    expect(parsearDoc("hola")).toBeNull();
  });
});

describe("formato de documentos", () => {
  it("fmtCuit", () => {
    expect(fmtCuit(20409378472)).toBe("20-40937847-2");
  });
  it("fmtDoc", () => {
    expect(fmtDoc(DOC_TIPO_CUIT, 20409378472)).toBe("CUIT 20-40937847-2");
    expect(fmtDoc(DOC_TIPO_DNI, 12345678)).toBe("DNI 12.345.678");
  });
  it("descripcionReceptor", () => {
    expect(descripcionReceptor(RECEPTOR_CF)).toBe("Consumidor Final");
    expect(
      descripcionReceptor({ docTipo: DOC_TIPO_CUIT, docNro: 20123456786, condIva: 6 })
    ).toBe("CUIT 20-12345678-6 — Monotributo");
  });
});

describe("fechas", () => {
  it("crearFecha valida el calendario", () => {
    expect(crearFecha(2026, 7, 5)).toEqual({ y: 2026, m: 7, d: 5 });
    expect(crearFecha(2026, 2, 31)).toBeNull();
    expect(crearFecha(2026, 13, 1)).toBeNull();
    expect(crearFecha(2024, 2, 29)).toEqual({ y: 2024, m: 2, d: 29 }); // bisiesto
    expect(crearFecha(2026, 2, 29)).toBeNull();
  });
  it("conversiones", () => {
    const f = { y: 2026, m: 7, d: 5 };
    expect(fechaToInt(f)).toBe(20260705);
    expect(fechaToIso(f)).toBe("2026-07-05");
    expect(fmtFecha(f)).toBe("05/07/2026");
  });
  it("addDias cruza meses y años", () => {
    expect(addDias({ y: 2026, m: 1, d: 1 }, -1)).toEqual({ y: 2025, m: 12, d: 31 });
    expect(addDias({ y: 2026, m: 6, d: 28 }, 5)).toEqual({ y: 2026, m: 7, d: 3 });
  });
  it("parsearFecha acepta los formatos del bot", () => {
    const anio = hoyAr().y;
    expect(parsearFecha("26/06")).toEqual({ y: anio, m: 6, d: 26 });
    expect(parsearFecha("26/06/2026")).toEqual({ y: 2026, m: 6, d: 26 });
    expect(parsearFecha("26-06-26")).toEqual({ y: 2026, m: 6, d: 26 });
    expect(parsearFecha("hoy")).toEqual(hoyAr());
  });
  it("parsearFecha rechaza fechas inválidas", () => {
    expect(parsearFecha("31/02")).toBeNull();
    expect(parsearFecha("99/99")).toBeNull();
    expect(parsearFecha("26")).toBeNull();
    expect(parsearFecha("mañana")).toBeNull();
  });
  it("validarFecha: ventana de 10 días para servicios", () => {
    const hoy = hoyAr();
    expect(validarFecha(hoy, 2)).toBeNull();
    expect(validarFecha(addDias(hoy, -10), 2)).toBeNull();
    expect(validarFecha(addDias(hoy, -11), 2)).toMatch(/10 días/);
    expect(validarFecha(addDias(hoy, 1), 2)).toMatch(/futura/);
  });
  it("validarFecha: ventana de 5 días para productos", () => {
    const hoy = hoyAr();
    expect(validarFecha(addDias(hoy, -5), 1)).toBeNull();
    expect(validarFecha(addDias(hoy, -6), 1)).toMatch(/5 días/);
  });
  it("reglas por concepto", () => {
    expect(usaPeriodo(1)).toBe(false);
    expect(usaPeriodo(2)).toBe(true);
    expect(diasAtrasMax(1)).toBe(5);
    expect(diasAtrasMax(2)).toBe(10);
  });
});

describe("parsearPeriodo", () => {
  const anio = hoyAr().y;
  it("acepta rango con guión y con 'al'", () => {
    expect(parsearPeriodo("01/06-30/06")).toEqual([
      { y: anio, m: 6, d: 1 },
      { y: anio, m: 6, d: 30 },
    ]);
    expect(parsearPeriodo("01/06 al 30/06")).toEqual([
      { y: anio, m: 6, d: 1 },
      { y: anio, m: 6, d: 30 },
    ]);
  });
  it("rechaza rango invertido o incompleto", () => {
    expect(parsearPeriodo("30/06-01/06")).toBeNull();
    expect(parsearPeriodo("01/06")).toBeNull();
  });
});

describe("QR de ARCA (RG 4892)", () => {
  it("arma la URL oficial con el JSON correcto", () => {
    const url = urlQrArca({
      fecha: { y: 2026, m: 7, d: 5 },
      cuitEmisor: 20409378472,
      ptoVta: 3,
      cbteTipo: 11,
      cbteNro: 42,
      importe: 15000.5,
      moneda: "PES",
      ctz: 1,
      docTipoRec: 99,
      docNroRec: 0,
      cae: "75123456789012",
    });
    expect(url.startsWith("https://www.afip.gob.ar/fe/qr/?p=")).toBe(true);
    const payload = url.split("?p=")[1];
    const datos = JSON.parse(Buffer.from(payload, "base64").toString());
    expect(datos).toEqual({
      ver: 1,
      fecha: "2026-07-05",
      cuit: 20409378472,
      ptoVta: 3,
      tipoCmp: 11,
      nroCmp: 42,
      importe: 15000.5,
      moneda: "PES",
      ctz: 1,
      tipoDocRec: 99,
      nroDocRec: 0,
      tipoCodAut: "E",
      codAut: 75123456789012,
    });
  });

  it("moneda extranjera: lleva DOL y la cotización", () => {
    const url = urlQrArca({
      fecha: { y: 2026, m: 6, d: 22 },
      cuitEmisor: 20409378472,
      ptoVta: 3,
      cbteTipo: 11,
      cbteNro: 410,
      importe: 3000,
      moneda: "DOL",
      ctz: 1461,
      docTipoRec: 80,
      docNroRec: 30111111118,
      cae: "75123456789012",
    });
    const datos = JSON.parse(Buffer.from(url.split("?p=")[1], "base64").toString());
    expect(datos.moneda).toBe("DOL");
    expect(datos.ctz).toBe(1461);
    expect(datos.importe).toBe(3000);
  });
});

describe("nombres de comprobante", () => {
  it("nombreComprobante", () => {
    expect(nombreComprobante(11, 3, 42)).toBe("Factura-C-00003-00000042");
    expect(nombreComprobante(13, 3, 7)).toBe("NC-C-00003-00000007");
  });
  it("nombreComprobante para exportación", () => {
    expect(nombreComprobante(FACTURA_E, 6, 1)).toBe("Factura-E-00006-00000001");
    expect(nombreComprobante(NOTA_CREDITO_E, 6, 2)).toBe("NC-E-00006-00000002");
  });
  it("numeroCompleto", () => {
    expect(numeroCompleto(3, 42)).toBe("00003-00000042");
  });
});

describe("exportación", () => {
  it("esExportacion distingue los comprobantes que van por WSFEX", () => {
    expect([19, 20, 21].map(esExportacion)).toEqual([true, true, true]);
    expect([11, 13, 1, 6].map(esExportacion)).toEqual([false, false, false, false]);
  });

  describe("validarFechaExpo", () => {
    // ARCA (homologación, 06/08/2026) devuelve para una fecha fuera de rango:
    // «[1500] La fecha debe estar incluida en el periodo 20260801 - 20260811»
    const hoy = { y: 2026, m: 8, d: 6 };

    it("acepta la ventana completa ±5 días", () => {
      for (const d of [1, 3, 6, 9, 11]) {
        expect(validarFechaExpo({ y: 2026, m: 8, d }, hoy), `día ${d}`).toBeNull();
      }
    });

    it("acepta fechas FUTURAS, al revés que la Factura C", () => {
      expect(validarFechaExpo({ y: 2026, m: 8, d: 11 }, hoy)).toBeNull();
      // la misma fecha, por WSFEv1, sería rechazada por futura
      expect(validarFecha({ y: 2026, m: 8, d: 11 }, 2)).not.toBeNull();
    });

    it("rechaza fuera de la ventana, con las dos puntas en el mensaje", () => {
      expect(validarFechaExpo({ y: 2026, m: 7, d: 31 }, hoy)).toMatch(/01\/08\/2026.*11\/08\/2026/);
      expect(validarFechaExpo({ y: 2026, m: 8, d: 12 }, hoy)).not.toBeNull();
    });

    it("la retroactividad es de 5 días aunque sean servicios (WSFEv1 da 10)", () => {
      expect(diasAtrasMax(2)).toBe(10); // Factura C servicios
      expect(validarFechaExpo({ y: 2026, m: 7, d: 30 }, hoy)).not.toBeNull(); // 7 días atrás
    });
  });

  describe("CUIT País", () => {
    // Los prefijos salen de la tabla completa de FEXGetPARAM_DST_CUIT
    // (777 entradas: 50 = persona física, 51 = otro, 55 = persona jurídica).
    it("acepta los tres prefijos reales", () => {
      expect(parsearCuitPais("55000004293")).toBe(55000004293); // Suecia PJ (Proxify)
      expect(parsearCuitPais("50000000016")).toBe(50000000016); // Uruguay PF
      expect(esCuitPais(51000000014)).toBe(true);
    });

    it("acepta separadores, como parsearCuit", () => {
      expect(parsearCuitPais(" 55-00000429-3 ")).toBe(55000004293);
    });

    it("rechaza CUIT argentinos y basura", () => {
      expect(parsearCuitPais("20372114356")).toBeNull(); // CUIT AR válido
      expect(parsearCuitPais("30111111118")).toBeNull();
      expect(parsearCuitPais("5500000429")).toBeNull(); // 10 dígitos
      expect(parsearCuitPais("52000000000")).toBeNull(); // prefijo 52 no existe
      expect(parsearCuitPais("abc")).toBeNull();
    });

    it("NO se lo puede distinguir por el dígito verificador", () => {
      // Verificado contra las 777 entradas de la tabla real: 774 pasan el
      // algoritmo del CUIT argentino. Si se validara así, un CUIT País se
      // colaría como CUIT nacional — por eso parsearCuitPais mira el prefijo.
      expect(parsearCuit("55000004293")).toBe(55000004293);
      expect(parsearCuit("50000000016")).toBe(50000000016);
      // Y hay excepciones que tampoco lo pasan (Granada, Samoa Occidental):
      // ni siquiera sirve como heurística inversa.
      expect(parsearCuit("55000005069")).toBeNull();
      expect(esCuitPais("55000005069")).toBe(true);
    });
  });
});
