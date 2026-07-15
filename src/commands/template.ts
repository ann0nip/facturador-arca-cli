/**
 * `facturar template <add|list|show|remove>` — gestión de templates.
 *
 * Un template es un receptor con nombre: `facturar 1000 acme`. Se guarda
 * como JSON editable en templates/ dentro del config dir.
 */

import * as p from "@clack/prompts";

import { valor } from "./comun.js";
import {
  type Moneda,
  type Receptor,
  CONDICIONES_IVA,
  fmtDoc,
  parsearDoc,
} from "../core/domain.js";
import {
  type Template,
  borrarTemplate,
  cargarTemplate,
  descripcionTemplate,
  guardarTemplate,
  listarTemplates,
  nombreTemplateValido,
  templatesDir,
} from "../config.js";

export async function cmdTemplate(args: string[]): Promise<void> {
  const sub = args[0] ?? "list";
  switch (sub) {
    case "list":
    case "ls":
      return listar();
    case "add":
      return agregar(args[1]);
    case "show":
      return mostrar(args[1]);
    case "remove":
    case "rm":
      return borrar(args[1]);
    default:
      console.error(
        "Uso: facturar template add [nombre] | list | show <nombre> | remove <nombre>"
      );
      process.exitCode = 1;
  }
}

function listar(): void {
  const templates = listarTemplates();
  if (templates.length === 0) {
    console.log("No hay templates todavía. Creá uno con: facturar template add");
    return;
  }
  console.log(`Templates (${templatesDir()}):\n`);
  for (const t of templates) {
    const moneda = t.moneda && t.moneda !== "PES" ? ` · ${t.moneda}` : "";
    const quien = t.razonSocial ? `${t.razonSocial} — ` : "";
    console.log(`  ${t.nombre.padEnd(16)} ${quien}${descripcionTemplate(t)}${moneda}`);
  }
  console.log(`\nUso: facturar 1000 ${templates[0].nombre}`);
}

function mostrar(nombre?: string): void {
  if (!nombre) {
    console.error("Uso: facturar template show <nombre>");
    process.exitCode = 1;
    return;
  }
  const t = cargarTemplate(nombre);
  if (!t) {
    console.error(`No existe el template «${nombre}».`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(t, null, 2));
}

async function borrar(nombre?: string): Promise<void> {
  if (!nombre) {
    console.error("Uso: facturar template remove <nombre>");
    process.exitCode = 1;
    return;
  }
  if (!borrarTemplate(nombre)) {
    console.error(`No existe el template «${nombre}».`);
    process.exitCode = 1;
    return;
  }
  console.log(`Template «${nombre}» borrado. (Los comprobantes ya emitidos no se tocan.)`);
}

async function agregar(nombreArg?: string): Promise<void> {
  p.intro("🧾 Nuevo template");

  const nombre = (
    nombreArg ??
    valor(
      await p.text({
        message: "Nombre corto del template (lo que vas a tipear: facturar 1000 <nombre>)",
        placeholder: "acme",
        validate: (v) =>
          !nombreTemplateValido(v ?? "") ? "Solo letras, números y guiones" : undefined,
      })
    )
  ).toLowerCase();

  if (!nombreTemplateValido(nombre)) {
    p.cancel(`Nombre inválido: «${nombre}» (solo letras, números y guiones).`);
    process.exitCode = 1;
    return;
  }
  if (cargarTemplate(nombre)) {
    const pisar = valor(
      await p.confirm({ message: `Ya existe «${nombre}». ¿Pisarlo?`, initialValue: false })
    );
    if (!pisar) {
      p.outro("Sin cambios.");
      return;
    }
  }

  // --- receptor -----------------------------------------------------------------
  const tipo = valor(
    await p.select({
      message: "¿A quién le facturás con este template?",
      options: [
        { value: "doc", label: "Un cliente con CUIT o DNI" },
        { value: "cf", label: "Consumidor final anónimo", hint: "sin identificar" },
      ],
    })
  );

  let receptor: Receptor | null = null;
  let razonSocial = "";
  let domicilio = "";

  if (tipo === "doc") {
    const docTexto = valor(
      await p.text({
        message: "CUIT (11 dígitos) o DNI (7-8) del receptor",
        placeholder: "30-11111111-8",
        validate: (v) =>
          parsearDoc(v ?? "") === null
            ? "No es un CUIT válido (verifico el dígito) ni un DNI"
            : undefined,
      })
    );
    const doc = parsearDoc(docTexto)!;

    const condIva = valor(
      await p.select({
        message: `${fmtDoc(doc.docTipo, doc.docNro)} — ¿condición frente al IVA?`,
        options: [1, 6, 4, 15, 5].map((codigo) => ({
          value: codigo,
          label: CONDICIONES_IVA[codigo],
        })),
      })
    );
    receptor = { docTipo: doc.docTipo, docNro: doc.docNro, condIva };

    razonSocial = valor(
      await p.text({
        message: "Nombre / razón social del receptor (para el PDF)",
        defaultValue: "",
        placeholder: "ACME S.A.S. — enter para saltear",
      })
    ).trim();
    domicilio = valor(
      await p.text({
        message: "Domicilio del receptor (para el PDF)",
        defaultValue: "",
        placeholder: "enter para saltear",
      })
    ).trim();
  }

  // --- moneda y condiciones -------------------------------------------------------
  const moneda = valor(
    await p.select<Moneda>({
      message: "¿En qué moneda facturás con este template?",
      options: [
        { value: "PES", label: "Pesos argentinos" },
        { value: "DOL", label: "Dólares (USD)", hint: "cotización oficial automática al emitir" },
      ],
      initialValue: "PES",
    })
  );

  let pagoEnMonedaExtranjera = false;
  if (moneda !== "PES") {
    pagoEnMonedaExtranjera = valor(
      await p.confirm({
        message: "¿El pago se cobra en la misma moneda (transferencia/billete en USD)?",
        initialValue: true,
      })
    );
  }

  const condicionVenta = valor(
    await p.text({
      message: "Texto de «Condición de venta» del PDF",
      defaultValue: moneda !== "PES" ? "Transferencia Bancaria - Moneda Extranjera" : "",
      placeholder:
        moneda !== "PES"
          ? "Transferencia Bancaria - Moneda Extranjera"
          : "Contado / Transferencia — enter para saltear",
    })
  ).trim();

  const descripcion = valor(
    await p.text({
      message: "Descripción del renglón del PDF (vacío = la default del emisor)",
      defaultValue: "",
      placeholder: "Servicios Profesionales — enter para saltear",
    })
  ).trim();

  const template: Template = {
    nombre,
    receptor,
    ...(razonSocial && { razonSocial }),
    ...(domicilio && { domicilio }),
    ...(moneda !== "PES" && { moneda, pagoEnMonedaExtranjera }),
    ...(condicionVenta && { condicionVenta }),
    ...(descripcion && { descripcion }),
  };
  guardarTemplate(template);

  p.note(JSON.stringify(template, null, 2), `Guardado en ${templatesDir()}`);
  p.outro(`Listo. Probalo: facturar 1000 ${nombre}`);
}
