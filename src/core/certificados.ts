/**
 * Generación de la private key y el CSR (pedido de certificado) — con
 * node-forge, sin depender de OpenSSL instalado (clave en Windows).
 *
 * Es el reemplazo del paso manual `openssl genrsa + openssl req` del trámite
 * de ARCA: el wizard de `facturar init` llama esto y el usuario solo tiene
 * que subir el CSR al portal. La private key se escribe con permisos 600 y
 * NUNCA sale de la máquina.
 */

import forge from "node-forge";

export interface KeyCsr {
  keyPem: string;
  csrPem: string;
}

/**
 * Subject en el formato que pide ARCA:
 *   C=AR, O=<nombre como figura en ARCA>, CN=<alias>, serialNumber=CUIT <cuit>
 */
export function generarKeyCsr(cuit: number, nombre: string, alias: string): KeyCsr {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([
    { name: "countryName", value: "AR" },
    { name: "organizationName", value: nombre },
    { name: "commonName", value: alias },
    // serialNumber (OID 2.5.4.5): forge no lo tiene por nombre corto
    { type: "2.5.4.5", value: `CUIT ${cuit}` },
  ] as forge.pki.CertificateField[]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  return {
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    csrPem: forge.pki.certificationRequestToPem(csr),
  };
}
