import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  configDir,
  cargarConfig,
  guardarConfig,
  validarEmisor,
  cargarTemplate,
  guardarTemplate,
  borrarTemplate,
  listarTemplates,
  nombreTemplateValido,
  type Emisor,
} from "../src/config.js";
import { DOC_TIPO_CUIT } from "../src/core/domain.js";

let tmpDir: string;

beforeEach(() => {
  // Cada test corre contra un config dir descartable (el override existe
  // exactamente para esto — y para power users).
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "facturador-test-"));
  process.env.FACTURADOR_CONFIG_DIR = tmpDir;
});

afterEach(() => {
  delete process.env.FACTURADOR_CONFIG_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("configDir", () => {
  it("respeta el override por variable de entorno", () => {
    expect(configDir()).toBe(tmpDir);
  });
});

describe("config del emisor", () => {
  it("devuelve null si no hay config todavía", () => {
    expect(cargarConfig()).toBeNull();
  });

  it("guarda y recarga el emisor", () => {
    const emisor: Emisor = {
      cuit: 20123456786,
      puntoVenta: 3,
      razonSocial: "PEREZ JUAN",
      concepto: 2,
      produccion: false,
      certPath: "/tmp/cert.crt",
      keyPath: "/tmp/privada.key",
    };
    guardarConfig(emisor);
    expect(cargarConfig()).toEqual(emisor);
  });

  it("validarEmisor lista lo que falta con mensajes claros", () => {
    const errores = validarEmisor({});
    expect(errores.length).toBeGreaterThanOrEqual(4);
    expect(errores.join("\n")).toMatch(/cuit/);
    expect(errores.join("\n")).toMatch(/puntoVenta/);
    expect(errores.join("\n")).toMatch(/certPath/);
  });

  it("validarEmisor detecta archivos de cert/key inexistentes", () => {
    const errores = validarEmisor({
      cuit: 20123456786,
      puntoVenta: 1,
      razonSocial: "X",
      concepto: 2,
      certPath: path.join(tmpDir, "no-existe.crt"),
      keyPath: path.join(tmpDir, "no-existe.key"),
    });
    expect(errores).toHaveLength(2);
    expect(errores[0]).toMatch(/no existe/);
  });

  it("validarEmisor acepta una config completa", () => {
    const cert = path.join(tmpDir, "cert.crt");
    const key = path.join(tmpDir, "privada.key");
    fs.writeFileSync(cert, "-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----\n");
    fs.writeFileSync(key, "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n");
    const errores = validarEmisor({
      cuit: 20123456786,
      puntoVenta: 3,
      razonSocial: "PEREZ JUAN",
      concepto: 2,
      produccion: false,
      certPath: cert,
      keyPath: key,
    });
    expect(errores).toEqual([]);
  });

  it("validarEmisor detecta el .csr puesto como certificado (error clásico)", () => {
    const csr = path.join(tmpDir, "pedido.csr");
    const key = path.join(tmpDir, "privada.key");
    fs.writeFileSync(csr, "-----BEGIN CERTIFICATE REQUEST-----\nMIIC...\n-----END CERTIFICATE REQUEST-----\n");
    fs.writeFileSync(key, "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n");
    const errores = validarEmisor({
      cuit: 20123456786,
      puntoVenta: 3,
      razonSocial: "X",
      concepto: 2,
      certPath: csr,
      keyPath: key,
    });
    expect(errores).toHaveLength(1);
    expect(errores[0]).toMatch(/PEDIDO de certificado/);
  });

  it("validarEmisor detecta archivos que no son PEM", () => {
    const cert = path.join(tmpDir, "cert.crt");
    const key = path.join(tmpDir, "privada.key");
    fs.writeFileSync(cert, "esto no es un certificado");
    fs.writeFileSync(key, "esto no es una key");
    const errores = validarEmisor({
      cuit: 20123456786,
      puntoVenta: 3,
      razonSocial: "X",
      concepto: 2,
      certPath: cert,
      keyPath: key,
    });
    expect(errores.join("\n")).toMatch(/no parece un certificado/);
    expect(errores.join("\n")).toMatch(/no parece una clave privada/);
  });
});

describe("templates", () => {
  it("CRUD completo", () => {
    expect(listarTemplates()).toEqual([]);
    expect(cargarTemplate("acme")).toBeNull();

    guardarTemplate({
      nombre: "acme",
      receptor: { docTipo: DOC_TIPO_CUIT, docNro: 20123456786, condIva: 6 },
      descripcion: "Servicios de diseño",
    });
    guardarTemplate({ nombre: "kiosco", receptor: null });

    expect(cargarTemplate("acme")?.descripcion).toBe("Servicios de diseño");
    expect(cargarTemplate("ACME")?.nombre).toBe("acme"); // case-insensitive
    expect(listarTemplates().map((t) => t.nombre)).toEqual(["acme", "kiosco"]);

    expect(borrarTemplate("acme")).toBe(true);
    expect(borrarTemplate("acme")).toBe(false); // ya no existe
    expect(cargarTemplate("acme")).toBeNull();
  });

  it("rechaza nombres no tipeables", () => {
    expect(nombreTemplateValido("acme")).toBe(true);
    expect(nombreTemplateValido("cliente-2")).toBe(true);
    expect(nombreTemplateValido("../etc/passwd")).toBe(false);
    expect(nombreTemplateValido("con espacios")).toBe(false);
    expect(nombreTemplateValido("")).toBe(false);
    expect(() => guardarTemplate({ nombre: "../x", receptor: null })).toThrow(/inválido/);
  });

  it("borrarTemplate NO permite path traversal (borraría el config)", () => {
    guardarConfig({
      cuit: 20123456786, puntoVenta: 1, razonSocial: "X",
      concepto: 2, produccion: false, certPath: "/x", keyPath: "/x",
    });
    expect(borrarTemplate("../config")).toBe(false);
    expect(cargarConfig()).not.toBeNull(); // el config sigue vivo
  });

  it("cargarTemplate valida un template editado a mano", () => {
    const dir = path.join(tmpDir, "templates");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "roto.json"),
      JSON.stringify({ nombre: "roto", receptor: null, moneda: "EUR" })
    );
    expect(() => cargarTemplate("roto")).toThrow(/moneda inválida/);

    fs.writeFileSync(
      path.join(dir, "roto2.json"),
      JSON.stringify({ nombre: "roto2", receptor: { docTipo: "80", docNro: 1, condIva: 1 } })
    );
    expect(() => cargarTemplate("roto2")).toThrow(/mal formado/);
  });
});
