/**
 * Helpers compartidos por los comandos interactivos (@clack/prompts).
 */

import * as p from "@clack/prompts";

/** Desenvuelve una respuesta de prompt; si el usuario canceló (Ctrl+C), sale. */
export function valor<T>(respuesta: T | symbol): T {
  if (p.isCancel(respuesta)) {
    p.cancel("Cancelado. No se emitió nada.");
    process.exit(0);
  }
  return respuesta as T;
}
