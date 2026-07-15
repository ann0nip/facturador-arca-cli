import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  registrarComprobante,
  leerComprobantes,
  totalFacturado12m,
  type Comprobante,
} from "../src/core/store.js";
import { logPath } from "../src/config.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "store-test-"));
  process.env.FACTURADOR_CONFIG_DIR = tmpDir;
});

afterEach(() => {
  delete process.env.FACTURADOR_CONFIG_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const base: Comprobante = {
  cbteTipo: 11,
  ptoVta: 3,
  numero: 1,
  fecha: "2026-07-01",
  concepto: 2,
  docTipo: 99,
  docNro: 0,
  condIva: 5,
  importeTotal: 100000,
  moneda: "PES",
  cotizacion: 1,
  cae: "75123456789012",
  caeVto: "2026-07-11",
  produccion: true,
  emitidoEn: "2026-07-01T10:00:00-03:00",
};

describe("registro y lectura", () => {
  it("append + lectura en orden", () => {
    registrarComprobante(base);
    registrarComprobante({ ...base, numero: 2, importeTotal: 50000 });
    const todos = leerComprobantes();
    expect(todos).toHaveLength(2);
    expect(todos[0].numero).toBe(1);
    expect(todos[1].importeTotal).toBe(50000);
  });

  it("log vacío o inexistente → lista vacía", () => {
    expect(leerComprobantes()).toEqual([]);
  });

  it("una línea corrupta no rompe el resto del log", () => {
    registrarComprobante(base);
    fs.appendFileSync(logPath(), "esto no es json\n");
    registrarComprobante({ ...base, numero: 2 });
    expect(leerComprobantes()).toHaveLength(2);
  });
});

describe("totalFacturado12m", () => {
  it("suma facturas, resta NC y convierte moneda extranjera a pesos", () => {
    registrarComprobante(base); // +100.000
    registrarComprobante({
      ...base, numero: 2, cbteTipo: 13, importeTotal: 20000, // NC: -20.000
    });
    registrarComprobante({
      ...base, numero: 410, moneda: "DOL", cotizacion: 1461, importeTotal: 3000, // +4.383.000
    });
    expect(totalFacturado12m(true, "2026-07-14")).toBe(100000 - 20000 + 4383000);
  });

  it("no mezcla homologación con producción ni cuenta fuera de ventana", () => {
    registrarComprobante({ ...base, produccion: false }); // test: no cuenta
    registrarComprobante({ ...base, numero: 2, fecha: "2024-01-01" }); // vieja
    expect(totalFacturado12m(true, "2026-07-14")).toBe(0);
  });
});
