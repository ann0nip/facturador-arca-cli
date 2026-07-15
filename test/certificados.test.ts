import { describe, it, expect } from "vitest";
import forge from "node-forge";

import { generarKeyCsr } from "../src/core/certificados.js";

describe("generarKeyCsr", () => {
  // La generación de la clave tarda ~1s: un solo par para todos los asserts.
  const { keyPem, csrPem } = generarKeyCsr(20409378472, "PEREZ JUAN", "facturador");

  it("la private key es un PEM RSA válido", () => {
    expect(keyPem).toContain("-----BEGIN RSA PRIVATE KEY-----");
    expect(() => forge.pki.privateKeyFromPem(keyPem)).not.toThrow();
  });

  it("el CSR tiene el subject en el formato de ARCA y firma válida", () => {
    const csr = forge.pki.certificationRequestFromPem(csrPem);
    expect(csr.verify()).toBe(true);
    const campo = (nombre: string) => csr.subject.getField(nombre)?.value;
    expect(campo("CN")).toBe("facturador");
    expect(campo("O")).toBe("PEREZ JUAN");
    expect(campo("C")).toBe("AR");
    const serial = csr.subject.attributes.find((a) => a.type === "2.5.4.5");
    expect(serial?.value).toBe("CUIT 20409378472");
  });
});
