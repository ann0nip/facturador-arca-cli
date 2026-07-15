/**
 * PDF del comprobante — generado LOCALMENTE con pdf-lib + qrcode.
 *
 * Replica el PDF que emite el facturador web de ARCA, cotejado renglón por
 * renglón contra un comprobante real (la factura de referencia del
 * proyecto): tres copias (ORIGINAL/DUPLICADO/TRIPLICADO), importes sin
 * separador de miles (así los imprime ARCA), condiciones de IVA con el
 * nombre largo oficial, QR obligatorio (RG 4892/2020) y la leyenda legal
 * del total en pesos para moneda extranjera.
 *
 * Nada sale de la máquina: ni cuota de PDFs ni links que vencen (los dos
 * problemas del servicio hosted que usaba el bot que inspiró este paquete).
 */

import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb } from "pdf-lib";
import QRCode from "qrcode";

import {
  type Concepto,
  type Fecha,
  type Moneda,
  DOC_TIPO_CF,
  DOC_TIPO_CUIT,
  FACTURA_C,
  NOTA_CREDITO_C,
  SIMBOLO_MONEDA,
  fmtFecha,
  nombreComprobante,
  numeroCompleto,
  urlQrArca,
  usaPeriodo,
} from "./domain.js";

// ---------------------------------------------------------------------------
// Datos que necesita el PDF (los junta la capa de comandos)
// ---------------------------------------------------------------------------
export interface DatosPdf {
  emisor: {
    cuit: number;
    razonSocial: string;
    domicilio?: string;
    inicioActividades?: string;
  };
  /** null = consumidor final anónimo. */
  receptor: {
    docTipo: number;
    docNro: number;
    condIva: number;
    razonSocial?: string;
    domicilio?: string;
  } | null;
  cbteTipo: number;
  ptoVta: number;
  numero: number;
  fecha: Fecha;
  concepto: Concepto;
  servDesde?: Fecha;
  servHasta?: Fecha;
  vtoPago?: Fecha;
  moneda: Moneda;
  /** 1 para PES; la cotización usada al emitir para moneda extranjera. */
  cotizacion: number;
  /** Expresado EN la moneda del comprobante. */
  importeTotal: number;
  descripcion: string;
  condicionVenta?: string;
  cae: string;
  caeVto: Fecha;
  /** Para NC: la factura que anula/ajusta. */
  asociado?: { ptoVta: number; nro: number };
}

// ---------------------------------------------------------------------------
// Constantes de dibujo y formato
// ---------------------------------------------------------------------------
const A4: [number, number] = [595.28, 841.89];
const X0 = 30; // margen izquierdo
const X1 = A4[0] - 30; // borde derecho
const NEGRO = rgb(0.07, 0.07, 0.07);
const GRIS = rgb(0.92, 0.92, 0.92);
const GRIS_TEXTO = rgb(0.35, 0.35, 0.35);

/** Segunda columna de los bloques de dos columnas (receptor). */
const X_COL2 = X0 + 220;

const COPIAS = ["ORIGINAL", "DUPLICADO", "TRIPLICADO"] as const;

const TIPOS_CBTE: Record<number, [string, string]> = {
  [FACTURA_C]: ["FACTURA", "CÓD. 011"],
  [NOTA_CREDITO_C]: ["NOTA DE CRÉDITO", "CÓD. 013"],
};

const MONEDA_PDF: Record<Moneda, string> = {
  PES: "PES - Pesos Argentinos",
  DOL: "USD - Dólar Estadounidense",
};

/** Nombres LARGOS oficiales, como los imprime ARCA en el PDF. */
const COND_IVA_PDF: Record<number, string> = {
  1: "IVA Responsable Inscripto",
  4: "IVA Sujeto Exento",
  5: "Consumidor Final",
  6: "Responsable Monotributo",
  13: "Monotributista Social",
  15: "IVA No Alcanzado",
};

/** 3000.5 → "3000,50" — ARCA imprime los importes SIN separador de miles. */
function fmtImporte(n: number): string {
  return n.toFixed(2).replace(".", ",");
}

/**
 * Las fuentes estándar de PDF solo soportan WinAnsi (Latin-1): las tildes y
 * la ñ entran bien, pero un emoji en la descripción rompería el drawText.
 * Se normaliza tipografía común y lo demás fuera de rango sale como "?".
 */
function winAnsi(s: string): string {
  const normalizado = s
    .replaceAll("“", '"')
    .replaceAll("”", '"')
    .replaceAll("‘", "'")
    .replaceAll("’", "'")
    .replaceAll("–", "-")
    .replaceAll("—", "-")
    .replaceAll("…", "...");
  return [...normalizado].map((c) => (c.codePointAt(0)! <= 0xff ? c : "?")).join("");
}

interface Fuentes {
  fuente: PDFFont;
  negrita: PDFFont;
  cursiva: PDFFont;
  negritaCursiva: PDFFont;
}

// ---------------------------------------------------------------------------
// Generación
// ---------------------------------------------------------------------------
export async function generarPdf(d: DatosPdf): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(nombreComprobante(d.cbteTipo, d.ptoVta, d.numero));
  const fuentes: Fuentes = {
    fuente: await doc.embedFont(StandardFonts.Helvetica),
    negrita: await doc.embedFont(StandardFonts.HelveticaBold),
    cursiva: await doc.embedFont(StandardFonts.HelveticaOblique),
    negritaCursiva: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
  };

  const receptorQr = d.receptor ?? { docTipo: DOC_TIPO_CF, docNro: 0, condIva: 0 };
  const urlQr = urlQrArca({
    fecha: d.fecha,
    cuitEmisor: d.emisor.cuit,
    ptoVta: d.ptoVta,
    cbteTipo: d.cbteTipo,
    cbteNro: d.numero,
    importe: d.importeTotal,
    moneda: d.moneda,
    ctz: d.cotizacion,
    docTipoRec: receptorQr.docTipo,
    docNroRec: receptorQr.docNro,
    cae: d.cae,
  });
  const qrPng = await QRCode.toBuffer(urlQr, { margin: 0, width: 256, errorCorrectionLevel: "M" });
  const qrImg = await doc.embedPng(qrPng);

  // Como el PDF oficial de ARCA: una página por copia, idénticas salvo el título.
  for (const copia of COPIAS) {
    agregarPagina(doc, fuentes, qrImg, d, copia);
  }
  return doc.save();
}

function agregarPagina(
  doc: PDFDocument,
  { fuente, negrita, cursiva, negritaCursiva }: Fuentes,
  qrImg: PDFImage,
  d: DatosPdf,
  etiquetaCopia: (typeof COPIAS)[number]
): void {
  const page: PDFPage = doc.addPage(A4);

  // --- helpers de dibujo ---------------------------------------------------
  const tx = (s: string, x: number, y: number, f: PDFFont = fuente, size = 8, color = NEGRO) =>
    page.drawText(winAnsi(s), { x, y, size, font: f, color });
  const ancho = (s: string, f: PDFFont, size: number) =>
    f.widthOfTextAtSize(winAnsi(s), size);
  const centrado = (s: string, cx: number, y: number, f: PDFFont, size: number, color = NEGRO) =>
    tx(s, cx - ancho(s, f, size) / 2, y, f, size, color);
  const derecha = (s: string, xDer: number, y: number, f: PDFFont, size: number) =>
    tx(s, xDer - ancho(s, f, size), y, f, size);
  /** Etiqueta en negrita + valor normal. Devuelve la x donde terminó. */
  const labelValor = (label: string, valor: string, x: number, y: number, size = 8) => {
    tx(label, x, y, negrita, size);
    const xValor = x + ancho(label, negrita, size) + 3;
    tx(valor, xValor, y, fuente, size);
    return xValor + ancho(valor, fuente, size);
  };
  const labelValorDerecha = (label: string, valor: string, xDer: number, y: number, size = 8) => {
    const total = ancho(label, negrita, size) + 3 + ancho(valor, fuente, size);
    labelValor(label, valor, xDer - total, y, size);
  };
  const hline = (yy: number) =>
    page.drawLine({ start: { x: X0, y: yy }, end: { x: X1, y: yy }, thickness: 0.8, color: NEGRO });
  const envolver = (s: string, f: PDFFont, size: number, maxW: number): string[] => {
    const lineas: string[] = [];
    let actual = "";
    for (const palabra of s.split(/\s+/)) {
      const prueba = actual ? `${actual} ${palabra}` : palabra;
      if (ancho(prueba, f, size) <= maxW) actual = prueba;
      else {
        if (actual) lineas.push(actual);
        actual = palabra;
      }
    }
    if (actual) lineas.push(actual);
    return lineas.length > 0 ? lineas : [""];
  };
  /** Etiqueta + valor envuelto hasta maxDerecha. Devuelve cuántas líneas usó. */
  const labelValorEnvuelto = (
    label: string,
    valor: string,
    x: number,
    y: number,
    maxDerecha: number
  ): number => {
    tx(label, x, y, negrita, 8);
    const xValor = x + ancho(label, negrita, 8) + 3;
    const lineas = envolver(valor, fuente, 8, maxDerecha - xValor);
    lineas.forEach((linea, i) => tx(linea, xValor, y - i * 10, fuente, 8));
    return lineas.length;
  };

  const [titulo, codigo] = TIPOS_CBTE[d.cbteTipo] ?? TIPOS_CBTE[FACTURA_C];
  const sim = SIMBOLO_MONEDA[d.moneda];
  const centro = (X0 + X1) / 2;
  const importe = fmtImporte(d.importeTotal);

  const yTop = A4[1] - 30;
  let y = yTop;

  // --- banda de copia (ORIGINAL / DUPLICADO / TRIPLICADO) --------------------
  y -= 15;
  centrado(etiquetaCopia, centro, y, negrita, 11);
  y -= 7;
  hline(y);

  // --- cabecera: emisor | letra C | datos del comprobante --------------------
  const yCab = y;
  const anchoCol = centro - 24 - (X0 + 10); // columnas hasta el recuadro de la letra
  const cxIzq = X0 + 10 + anchoCol / 2; // centro de la columna izquierda

  // recuadro de la letra
  page.drawRectangle({
    x: centro - 24, y: y - 40, width: 48, height: 40,
    borderColor: NEGRO, borderWidth: 0.8,
  });
  centrado("C", centro, y - 24, negrita, 22);
  centrado(codigo, centro, y - 36, fuente, 6);

  // columna izquierda: emisor (nombre centrado, como el oficial)
  let yIzq = y - 24;
  for (const linea of envolver(d.emisor.razonSocial, negrita, 11, anchoCol)) {
    centrado(linea, cxIzq, yIzq, negrita, 11);
    yIzq -= 14;
  }
  yIzq -= 4;
  labelValor("Razón Social:", d.emisor.razonSocial, X0 + 10, yIzq);
  yIzq -= 12;
  yIzq -= (labelValorEnvuelto("Domicilio Comercial:", d.emisor.domicilio ?? "-", X0 + 10, yIzq, centro - 28) - 1) * 10 + 11;
  labelValor("Condición frente al IVA:", "Responsable Monotributo", X0 + 10, yIzq);

  // columna derecha: comprobante
  const xDer = centro + 34;
  let yDer = y - 22;
  tx(titulo, xDer, yDer, negrita, 15);
  yDer -= 18;
  const finPv = labelValor("Punto de Venta:", String(d.ptoVta).padStart(5, "0"), xDer, yDer);
  labelValor("Comp. Nro:", String(d.numero).padStart(8, "0"), finPv + 12, yDer);
  yDer -= 12;
  labelValor("Fecha de Emisión:", fmtFecha(d.fecha), xDer, yDer);
  yDer -= 12;
  labelValor("CUIT:", String(d.emisor.cuit), xDer, yDer);
  yDer -= 12;
  labelValor("Ingresos Brutos:", String(d.emisor.cuit), xDer, yDer);
  yDer -= 12;
  labelValor("Fecha de Inicio de Actividades:", d.emisor.inicioActividades ?? "-", xDer, yDer);

  y = Math.min(yIzq, yDer) - 12;
  // divisor vertical entre columnas, del recuadro de la letra para abajo
  page.drawLine({ start: { x: centro, y: yCab - 40 }, end: { x: centro, y }, thickness: 0.8, color: NEGRO });
  hline(y);

  // --- período facturado y vencimiento (solo servicios) ----------------------
  if (usaPeriodo(d.concepto)) {
    y -= 15;
    // posiciones fijas, como el oficial
    labelValor("Período Facturado Desde:", fmtFecha(d.servDesde ?? d.fecha), X0 + 10, y);
    labelValor("Hasta:", fmtFecha(d.servHasta ?? d.fecha), X0 + 225, y);
    labelValor("Fecha de Vto. para el pago:", fmtFecha(d.vtoPago ?? d.fecha), X0 + 335, y);
    y -= 8;
    hline(y);
  }

  // --- receptor ---------------------------------------------------------------
  y -= 15;
  if (d.receptor !== null && d.receptor.docTipo !== DOC_TIPO_CF) {
    const r = d.receptor;
    // ARCA imprime el documento sin guiones ni puntos
    const etiqueta = r.docTipo === DOC_TIPO_CUIT ? "CUIT:" : "DNI:";
    labelValor(etiqueta, String(r.docNro), X0 + 10, y);
    if (r.razonSocial) {
      labelValor("Apellido y Nombre / Razón Social:", r.razonSocial, X_COL2, y);
    }
    y -= 12;
    labelValor(
      "Condición frente al IVA:",
      COND_IVA_PDF[r.condIva] ?? `Condición ${r.condIva}`,
      X0 + 10, y
    );
    if (r.domicilio) {
      const lineasDom = labelValorEnvuelto("Domicilio:", r.domicilio, X_COL2, y, X1 - 10);
      y -= (lineasDom - 1) * 10;
    }
    if (d.condicionVenta) {
      y -= 12;
      labelValor("Condición de venta:", d.condicionVenta, X0 + 10, y);
    }
  } else {
    labelValor("Condición frente al IVA:", "Consumidor Final", X0 + 10, y);
    if (d.condicionVenta) {
      y -= 12;
      labelValor("Condición de venta:", d.condicionVenta, X0 + 10, y);
    }
  }
  y -= 8;
  hline(y);

  // --- comprobante asociado (solo NC) ----------------------------------------
  if (d.asociado) {
    y -= 15;
    labelValor(
      "Comprobante Asociado:",
      `Factura C ${numeroCompleto(d.asociado.ptoVta, d.asociado.nro)}`,
      X0 + 10, y
    );
    y -= 8;
    hline(y);
  }

  // --- tabla de detalle --------------------------------------------------------
  // Mismas columnas que el facturador de ARCA. La cantidad es siempre 1: el
  // monto que se factura ES el total (modelo de este CLI).
  const columnas: { titulo: string; w: number; alinDer?: boolean }[] = [
    { titulo: "Código", w: 40 },
    { titulo: "Producto / Servicio", w: 0 }, // flexible
    { titulo: "Cantidad", w: 46, alinDer: true },
    { titulo: "U. Medida", w: 50 },
    { titulo: `Precio Unit. (${sim})`, w: 74, alinDer: true },
    { titulo: "% Bonif", w: 40, alinDer: true },
    { titulo: `Imp. Bonif. (${sim})`, w: 68, alinDer: true },
    { titulo: `Subtotal (${sim})`, w: 74, alinDer: true },
  ];
  const fijo = columnas.reduce((acc, c) => acc + c.w, 0);
  columnas[1].w = X1 - X0 - fijo;

  page.drawRectangle({ x: X0, y: y - 16, width: X1 - X0, height: 16, color: GRIS });
  let xCol = X0;
  for (const c of columnas) {
    if (c.alinDer) derecha(c.titulo, xCol + c.w - 3, y - 12, negrita, 7);
    else tx(c.titulo, xCol + 3, y - 12, negrita, 7);
    xCol += c.w;
  }
  y -= 16;

  const lineasDesc = envolver(d.descripcion, fuente, 8, columnas[1].w - 6);
  const valores = ["", "", "1,00", "unidades", importe, "0,00", "0,00", importe];
  const yFila = y - 12;
  xCol = X0;
  columnas.forEach((c, i) => {
    if (i === 1) {
      let yDesc = yFila;
      for (const linea of lineasDesc) {
        tx(linea, xCol + 3, yDesc, fuente, 8);
        yDesc -= 11;
      }
    } else if (valores[i]) {
      if (c.alinDer) derecha(valores[i], xCol + c.w - 3, yFila, fuente, 8);
      else tx(valores[i], xCol + 3, yFila, fuente, 8);
    }
    xCol += c.w;
  });
  y -= Math.max(20, lineasDesc.length * 11 + 9);
  hline(y);

  // --- totales -----------------------------------------------------------------
  y -= 14;
  derecha(`Moneda: ${MONEDA_PDF[d.moneda]}`, X1 - 10, y, negrita, 8);
  y -= 14;
  labelValorDerecha("Subtotal:", `${sim} ${importe}`, X1 - 10, y);
  y -= 13;
  labelValorDerecha("Importe Otros Tributos:", `${sim} 0,00`, X1 - 10, y);
  y -= 16;
  const totalTxt = `${sim} ${importe}`;
  const wTotal = ancho("Importe Total:", negrita, 11) + 4 + ancho(totalTxt, negrita, 11);
  tx("Importe Total:", X1 - 10 - wTotal, y, negrita, 11);
  derecha(totalTxt, X1 - 10, y, negrita, 11);
  y -= 8;

  // --- leyenda legal en pesos (solo moneda extranjera) ---------------------------
  if (d.moneda !== "PES") {
    hline(y);
    const totalPesos = Math.round(d.importeTotal * d.cotizacion * 100) / 100;
    const leyenda =
      `El total de este comprobante expresado en moneda de curso legal - Pesos ` +
      `Argentinos - considerándose un tipo de cambio consignado de ` +
      `${d.cotizacion.toFixed(6)} asciende a: $ ${fmtImporte(totalPesos)}`;
    y -= 13;
    for (const linea of envolver(leyenda, fuente, 8, X1 - X0 - 20)) {
      tx(linea, X0 + 10, y, fuente, 8);
      y -= 11;
    }
    y -= 2;
  }

  // marco exterior del comprobante
  page.drawRectangle({
    x: X0, y, width: X1 - X0, height: yTop - y,
    borderColor: NEGRO, borderWidth: 1,
  });

  // --- pie: QR + logo + autorización + CAE (fuera del marco, como el oficial) ----
  const yPie = y - 14;
  page.drawImage(qrImg, { x: X0, y: yPie - 85, width: 85, height: 85 });

  // logo ARCA (tipográfico, aproximación del oficial)
  tx("ARCA", X0 + 100, yPie - 22, negrita, 16);
  tx("AGENCIA DE RECAUDACIÓN", X0 + 100, yPie - 29, fuente, 4.5, GRIS_TEXTO);
  tx("Y CONTROL ADUANERO", X0 + 100, yPie - 35, fuente, 4.5, GRIS_TEXTO);

  tx("Comprobante Autorizado", X0 + 100, yPie - 52, negritaCursiva, 9);
  const disclaimer =
    "Esta Agencia no se responsabiliza por los datos ingresados en el detalle de la operación";
  for (const [i, linea] of envolver(disclaimer, cursiva, 6, 230).entries()) {
    tx(linea, X0 + 100, yPie - 63 - i * 8, cursiva, 6);
  }

  centrado("Pág. 1/1", centro + 60, yPie - 22, fuente, 8);
  labelValorDerecha("CAE N°:", d.cae, X1, yPie - 22, 9);
  labelValorDerecha("Fecha de Vto. de CAE:", fmtFecha(d.caeVto), X1, yPie - 36, 9);
}
