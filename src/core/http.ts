/**
 * POST HTTPS compartido por wsaa.ts y wsfe.ts.
 *
 * ARCA (wsaa.afip.gov.ar, servicios1.afip.gov.ar) todavía negocia DH de
 * 1024 bits. El OpenSSL que trae Node moderno lo rechaza por default
 * (ERR_SSL_DH_KEY_TOO_SMALL) y `fetch()` nativo lo reporta como un
 * "fetch failed" genérico que no dice nada de la causa real — costó un
 * buen rato de debugging. `curl` no lo sufre porque en macOS usa LibreSSL,
 * no OpenSSL. SECLEVEL=1 no afloja la validación del certificado del
 * servidor, solo permite ese tamaño de clave DH puntual.
 */
import https from "node:https";

const agenteArca = new https.Agent({ ciphers: "DEFAULT:@SECLEVEL=1" });

export interface RespuestaHttp {
  status: number;
  ok: boolean;
  text(): Promise<string>;
}

/** Lanza un Error con name="TimeoutError", igual que AbortSignal.timeout(). */
export function postXml(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs = 60_000
): Promise<RespuestaHttp> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "POST", headers, agent: agenteArca }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        resolve({
          status,
          ok: status >= 200 && status < 300,
          text: async () => Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
