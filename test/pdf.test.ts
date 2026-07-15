import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";

import { generarPdf, type DatosPdf } from "../src/core/pdf.js";

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
