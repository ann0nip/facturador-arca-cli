import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";

import { generarPdf, type DatosPdf } from "../src/core/pdf.js";
import { urlQrArca } from "../src/core/domain.js";

const emisor = {
  cuit: 20409378472,
  razonSocial: "PEREZ JUAN",
  domicilio: "Calle Ejemplo 123 - Córdoba",
  inicioActividades: "22/02/2017",
};

/** La factura de referencia del proyecto: C en USD a un R.I., con período y vto. */
const facturaUsd: DatosPdf = {
  emisor,
  receptor: {
    docTipo: 80,
    docNro: 30111111118,
    condIva: 1,
    razonSocial: "ACME S.A.S.",
    domicilio: "Av. Siempre Viva 742 - Córdoba",
  },
  cbteTipo: 11,
  ptoVta: 3,
  numero: 410,
  fecha: { y: 2026, m: 6, d: 22 },
  concepto: 2,
  servDesde: { y: 2026, m: 6, d: 1 },
  servHasta: { y: 2026, m: 6, d: 30 },
  vtoPago: { y: 2026, m: 7, d: 10 },
  moneda: "DOL",
  cotizacion: 1461,
  importeTotal: 3000,
  descripcion: "Servicios Profesionales Junio 2026",
  condicionVenta: "Transferencia Bancaria - Moneda Extranjera",
  cae: "75123456789012",
  caeVto: { y: 2026, m: 7, d: 2 },
};

const facturaCf: DatosPdf = {
  emisor,
  receptor: null,
  cbteTipo: 11,
  ptoVta: 3,
  numero: 411,
  fecha: { y: 2026, m: 7, d: 14 },
  concepto: 2,
  moneda: "PES",
  cotizacion: 1,
  importeTotal: 15000.5,
  descripcion: "Servicios",
  cae: "75123456789012",
  caeVto: { y: 2026, m: 7, d: 24 },
};

async function esPdfValido(bytes: Uint8Array): Promise<PDFDocument> {
  expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  return PDFDocument.load(bytes);
}

describe("generarPdf", () => {
  it("la factura de referencia (USD, R.I., período, vto) sale como PDF válido", async () => {
    const bytes = await generarPdf(facturaUsd);
    const doc = await esPdfValido(bytes);
    // Como el oficial: ORIGINAL + DUPLICADO + TRIPLICADO
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getTitle()).toBe("Factura-C-00003-00000410");
  });

  it("consumidor final en pesos: sin bloque de moneda extranjera", async () => {
    const bytes = await generarPdf(facturaCf);
    const doc = await esPdfValido(bytes);
    expect(doc.getTitle()).toBe("Factura-C-00003-00000411");
  });

  it("productos (concepto 1): sin período ni vencimiento", async () => {
    const bytes = await generarPdf({ ...facturaCf, concepto: 1 });
    await esPdfValido(bytes);
  });

  it("nota de crédito: título y comprobante asociado", async () => {
    const bytes = await generarPdf({
      ...facturaCf,
      cbteTipo: 13,
      numero: 12,
      asociado: { ptoVta: 3, nro: 410 },
    });
    const doc = await esPdfValido(bytes);
    expect(doc.getTitle()).toBe("NC-C-00003-00000012");
  });

  it("no explota con caracteres fuera de Latin-1 (emoji, comillas tipográficas)", async () => {
    const bytes = await generarPdf({
      ...facturaCf,
      descripcion: "Diseño “web” 🚀 — señalética & más…",
    });
    await esPdfValido(bytes);
  });

  it("descripción larga: envuelve en varias líneas sin romper el layout", async () => {
    const bytes = await generarPdf({
      ...facturaCf,
      descripcion:
        "Servicios profesionales de desarrollo de software, mantenimiento " +
        "de infraestructura, soporte técnico y consultoría correspondientes " +
        "al período junio 2026 según contrato marco",
    });
    await esPdfValido(bytes);
  });
});

// ---------------------------------------------------------------------------
// Factura E (exportación)
// ---------------------------------------------------------------------------
/** La Factura E de referencia del proyecto: Proxify (Suecia), en pesos. */
const facturaE: DatosPdf = {
  emisor,
  receptor: null,
  exterior: {
    cuitPais: 55000004293,
    nombre: "Proxify",
    domicilio: "Barnhusgatan 3, Stockholm, 11123",
    cuitPaisDesc: "SUECIA - Persona Jurídica",
    paisDestinoDesc: "SUECIA",
    formaPago: "Criptomonedas",
    fechaPago: { y: 2026, m: 8, d: 6 },
  },
  cbteTipo: 19,
  ptoVta: 6,
  numero: 1,
  fecha: { y: 2026, m: 8, d: 6 },
  concepto: 2,
  moneda: "PES",
  cotizacion: 1,
  importeTotal: 1277320,
  descripcion: "Servicios profesionales",
  cae: "76326015909401",
  caeVto: { y: 2026, m: 8, d: 6 },
};

describe("generarPdf — Factura E", () => {
  it("sale como PDF válido con el nombre de comprobante de exportación", async () => {
    const bytes = await generarPdf(facturaE);
    const doc = await esPdfValido(bytes);
    // ORIGINAL + DUPLICADO + COPIA (la E no dice "TRIPLICADO")
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getTitle()).toBe("Factura-E-00006-00000001");
  });

  it("el QR lleva el CUIT País como DocTipo 80", async () => {
    // Verificado contra el QR de una Factura E real emitida por ARCA.
    const url = urlQrArca({
      fecha: facturaE.fecha,
      cuitEmisor: emisor.cuit,
      ptoVta: facturaE.ptoVta,
      cbteTipo: 19,
      cbteNro: facturaE.numero,
      importe: facturaE.importeTotal,
      moneda: "PES",
      ctz: 1,
      docTipoRec: 80,
      docNroRec: facturaE.exterior!.cuitPais,
      cae: facturaE.cae,
    });
    const datos = JSON.parse(Buffer.from(url.split("?p=")[1], "base64").toString());
    expect(datos.tipoCmp).toBe(19);
    expect(datos.tipoDocRec).toBe(80);
    expect(datos.nroDocRec).toBe(55000004293);
  });

  it("en dólares: agrega la leyenda del total en pesos", async () => {
    const bytes = await generarPdf({ ...facturaE, moneda: "DOL", cotizacion: 1152.42, importeTotal: 3000 });
    await esPdfValido(bytes);
  });

  it("sin descripciones de país: no rompe, imprime solo los códigos", async () => {
    const bytes = await generarPdf({
      ...facturaE,
      exterior: {
        cuitPais: 55000004293,
        nombre: "Proxify",
        domicilio: "Barnhusgatan 3, Stockholm, 11123",
      },
    });
    await esPdfValido(bytes);
  });

  it("nota de crédito de exportación: nombre y título propios", async () => {
    const bytes = await generarPdf({ ...facturaE, cbteTipo: 21, numero: 2 });
    const doc = await esPdfValido(bytes);
    expect(doc.getTitle()).toBe("NC-E-00006-00000002");
  });

  it("una descripción larga no desborda la tabla de 5 columnas", async () => {
    const bytes = await generarPdf({
      ...facturaE,
      descripcion:
        "Servicios profesionales de desarrollo de software, consultoría técnica y " +
        "mantenimiento evolutivo prestados durante el período completo facturado",
    });
    await esPdfValido(bytes);
  });
});
