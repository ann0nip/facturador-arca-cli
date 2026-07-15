#!/usr/bin/env node
/**
 * facturador-arca — emití Factura C en ARCA desde la terminal.
 *
 * Gramática: si el primer argumento parsea como monto, es una emisión;
 * si no, es un subcomando (init, template).
 *
 * Esta es solo la capa de entrada: la lógica vive en core/ y no sabe nada
 * de argv ni de prompts.
 */

import { createRequire } from "node:module";

import pc from "picocolors";

import { parsearMonto } from "./core/domain.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

const AYUDA = `🧾 facturador-arca ${pkg.version} — Factura C en ARCA desde la terminal

Uso:
  facturar <monto> [template] [opciones]    Emitir una Factura C
  facturar init                             Configuración inicial (emisor + certificado)
  facturar template add [nombre]            Crear un template (receptor con nombre)
  facturar template list | show | remove    Gestionar templates

Ejemplos:
  facturar 15000                            A consumidor final, hoy
  facturar 3000 acme --vto 10/07      Con template; el pago vence el 10/07
  facturar 15000 20-12345678-6              A un CUIT puntual (pregunta cond. IVA)
  facturar 15000 --fecha 26/06 --periodo 01/06-30/06

Opciones de emisión:
  --fecha dd/mm        Fecha del comprobante (retroactiva: 10 días servicios / 5 productos)
  --periodo d1-d2      Período facturado (ej: 01/06-30/06)
  --vto dd/mm          Fecha de vto. para el pago (default: la de emisión)
  --detalle "texto"    Descripción del renglón del PDF (alias: -d)
  --moneda PES|DOL     Pisa la moneda del template
  --cotizacion N       Fuerza el tipo de cambio (default: cotización oficial de ARCA)
  --si                 Emitir sin pedir confirmación (para scripts)

Más info: https://github.com/ann0nip/facturador-arca-cli`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const primero = args[0];

  if (!primero || ["--help", "-h", "help", "ayuda"].includes(primero)) {
    console.log(AYUDA);
    return;
  }
  if (["--version", "-v"].includes(primero)) {
    console.log(pkg.version);
    return;
  }
  if (primero === "init") {
    const { cmdInit } = await import("./commands/init.js");
    return cmdInit();
  }
  if (primero === "template") {
    const { cmdTemplate } = await import("./commands/template.js");
    return cmdTemplate(args.slice(1));
  }

  // ¿el primer argumento es un monto? → emisión
  try {
    parsearMonto(primero);
  } catch {
    console.error(
      pc.red(`No entendí «${primero}»: no es un monto ni un comando conocido.\n`)
    );
    console.log(AYUDA);
    process.exitCode = 1;
    return;
  }
  const { cmdFacturar } = await import("./commands/facturar.js");
  return cmdFacturar(primero, args.slice(1));
}

main().catch((e: unknown) => {
  console.error(pc.red(`\n${e instanceof Error ? e.message : String(e)}`));
  process.exitCode = 1;
});
