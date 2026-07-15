/**
 * Genera PDFs de muestra para revisar el layout a ojo (no toca la red).
 *
 *   npx tsx scripts/muestra-pdf.ts [directorio-salida]
 */
import fs from "node:fs";
import path from "node:path";

import { generarPdf, type DatosPdf } from "../src/core/pdf.js";

const salida = process.argv[2] ?? "muestras";
fs.mkdirSync(salida, { recursive: true });

const emisor = {
  cuit: 20409378472,
  razonSocial: "PEREZ JUAN",
  domicilio: "Calle Ejemplo 123 - Córdoba",
  inicioActividades: "22/02/2017",
};

const casos: Record<string, DatosPdf> = {
  "usd-responsable-inscripto": {
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
  },
  "pesos-consumidor-final": {
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
  },
  "nota-de-credito": {
    emisor,
    receptor: null,
    cbteTipo: 13,
    ptoVta: 3,
    numero: 12,
    fecha: { y: 2026, m: 7, d: 14 },
    concepto: 2,
    moneda: "PES",
    cotizacion: 1,
    importeTotal: 15000.5,
    descripcion: "Servicios",
    cae: "75123456789013",
    caeVto: { y: 2026, m: 7, d: 24 },
    asociado: { ptoVta: 3, nro: 411 },
  },
};

for (const [nombre, datos] of Object.entries(casos)) {
  const bytes = await generarPdf(datos);
  const destino = path.join(salida, `${nombre}.pdf`);
  fs.writeFileSync(destino, bytes);
  console.log(`✅ ${destino}`);
}
