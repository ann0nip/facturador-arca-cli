/**
 * `facturar template <add|list|show|remove>` — gestión de templates.
 *
 * Un template es un receptor con nombre: `facturar 1000 acme`. Se guarda
 * como JSON editable en templates/ dentro del config dir.
 */

import fs from "node:fs";

import * as p from "@clack/prompts";
import pc from "picocolors";

import { valor } from "./comun.js";
import {
  type Idioma,
  type Moneda,
  type Receptor,
  type TipoExpo,
  CONDICIONES_IVA,
  IDIOMA_DESC,
  TIPO_EXPO_DESC,
  fmtDoc,
  parsearDoc,
} from "../core/domain.js";
import { obtenerTicket } from "../core/wsaa.js";
import {
  type CuitPais,
  type PaisDestino,
  SERVICIO_WSAA as SERVICIO_WSFEX,
  cuitsPais,
  paisesDestino,
} from "../core/wsfex.js";
import {
  type DatosExportacion,
  type Template,
  borrarTemplate,
  cargarConfig,
  cargarTemplate,
  descripcionTemplate,
  guardarTemplate,
  listarTemplates,
  nombreTemplateValido,
  templatesDir,
  wsaaCacheDir,
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
        {
          value: "exterior",
          label: "Un cliente del exterior",
          hint: "Factura E — exportación",
        },
      ],
    })
  );

  if (tipo === "exterior") return agregarExterior(nombre);

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

// ---------------------------------------------------------------------------
// Template de cliente del exterior (Factura E)
// ---------------------------------------------------------------------------
/**
 * El CUIT País y el código de país destino NO se tipean a mano: los define
 * ARCA en dos tablas (FEXGetPARAM_DST_CUIT y FEXGetPARAM_DST_pais) y no hay
 * forma de deducirlos ni de validarlos localmente — el dígito verificador del
 * CUIT no sirve para distinguir un CUIT País. Por eso el wizard las trae del
 * web service y hace elegir de la lista.
 */
async function agregarExterior(nombre: string): Promise<void> {
  const config = cargarConfig();
  if (config === null) {
    p.cancel("Todavía no hay configuración. Empezá por: facturar init");
    process.exitCode = 1;
    return;
  }

  const sp = p.spinner();
  sp.start(`Trayendo las tablas de países de ARCA${config.produccion ? "" : " (homologación)"}`);
  let paises: PaisDestino[];
  let cuits: CuitPais[];
  try {
    const ticket = await obtenerTicket({
      certPem: fs.readFileSync(config.certPath, "utf8"),
      keyPem: fs.readFileSync(config.keyPath, "utf8"),
      produccion: config.produccion,
      cacheDir: wsaaCacheDir(),
      service: SERVICIO_WSFEX,
    });
    const auth = { token: ticket.token, sign: ticket.sign, cuit: config.cuit };
    [paises, cuits] = await Promise.all([
      paisesDestino(auth, config.produccion),
      cuitsPais(auth, config.produccion),
    ]);
    sp.stop(`Tablas de ARCA: ${paises.length} países, ${cuits.length} CUIT País ✓`);
  } catch (e) {
    sp.stop(pc.red("No pude traer las tablas de ARCA"));
    const detalle = e instanceof Error ? e.message : String(e);
    if (/no autorizado a acceder al servicio/i.test(detalle)) {
      p.cancel(
        `${detalle}\n\n💡 El certificado no tiene habilitado «wsfex», el servicio de los ` +
          `comprobantes de exportación (distinto del «wsfe» de la Factura C).\n` +
          (config.produccion
            ? `Habilitalo en «Administrador de Relaciones de Clave Fiscal» → Nueva Relación → ` +
              `Facturación Electrónica de Exportación.`
            : `Habilitalo en «WSASS - Autogestión Certificados Homologación» → ` +
              `Crear autorización a servicio → servicio wsfex.`)
      );
    } else {
      p.cancel(detalle);
    }
    process.exitCode = 1;
    return;
  }

  const nombreCliente = valor(
    await p.text({
      message: "Nombre / razón social del cliente del exterior",
      placeholder: "Proxify",
      validate: (v) => (!v?.trim() ? "ARCA lo exige (es el campo Cliente)" : undefined),
    })
  ).trim();

  const domicilioCliente = valor(
    await p.text({
      message: "Domicilio del cliente en el exterior",
      placeholder: "Barnhusgatan 3, Stockholm, 11123",
      validate: (v) => (!v?.trim() ? "ARCA lo exige" : undefined),
    })
  ).trim();

  // País destino: la lista tiene 300+ entradas, así que se filtra tipeando.
  const paisDestino = await elegirDeLista(
    "País destino del comprobante",
    paises.map((p_) => ({ value: p_.codigo, label: `${p_.nombre} (${p_.codigo})`, buscar: p_.nombre }))
  );
  if (paisDestino === null) return;
  const paisElegido = paises.find((p_) => p_.codigo === paisDestino)!;

  // CUIT País: depende del país Y del tipo de persona (física/jurídica). Se
  // filtra por el nombre del país elegido para no mostrar las 777.
  const candidatos = cuits.filter((c) =>
    c.descripcion.toUpperCase().startsWith(paisElegido.nombre.toUpperCase())
  );
  const lista = candidatos.length > 0 ? candidatos : cuits;
  if (candidatos.length === 0) {
    p.log.warn(
      `No encontré CUIT País que empiecen con «${paisElegido.nombre}»: te muestro la lista completa.`
    );
  }
  const cuitPais = await elegirDeLista(
    "CUIT País del cliente (lo asigna ARCA por país y tipo de persona)",
    lista.map((c) => ({ value: c.cuitPais, label: `${c.descripcion} — ${c.cuitPais}`, buscar: c.descripcion }))
  );
  if (cuitPais === null) return;
  const cuitElegido = cuits.find((c) => c.cuitPais === cuitPais)!;

  const tipoExpo = valor(
    await p.select<TipoExpo>({
      message: "¿Qué exportás con este template?",
      options: ([2, 1, 4] as TipoExpo[]).map((v) => ({ value: v, label: TIPO_EXPO_DESC[v] })),
      initialValue: 2,
    })
  );

  const idImpositivo = valor(
    await p.text({
      message: "Identificación tributaria del cliente en su país (VAT, EIN…)",
      defaultValue: "",
      placeholder: "enter para saltear",
    })
  ).trim();

  // OJO: esto NO es la "condición de venta" del PDF de la Factura C. Acá el
  // dato viaja a ARCA en el campo Forma_pago del WSFEX.
  const formaPago = valor(
    await p.text({
      message: "Forma de pago (va impresa Y viaja a ARCA)",
      defaultValue: "",
      placeholder: "Criptomonedas / Transferencia bancaria — enter para saltear",
    })
  ).trim();

  const idioma = valor(
    await p.select<Idioma>({
      message: "Idioma del comprobante",
      options: ([1, 2, 3] as Idioma[]).map((v) => ({ value: v, label: IDIOMA_DESC[v] })),
      initialValue: 1,
    })
  );

  const moneda = valor(
    await p.select<Moneda>({
      message: "¿En qué moneda facturás con este template?",
      options: [
        {
          value: "PES",
          label: "Pesos argentinos",
          hint: "aunque el cliente sea del exterior, la factura puede ir en pesos",
        },
        { value: "DOL", label: "Dólares (USD)", hint: "cotización oficial automática al emitir" },
      ],
      initialValue: "PES",
    })
  );

  const descripcion = valor(
    await p.text({
      message: "Descripción del renglón (vacío = la default del emisor)",
      defaultValue: "",
      placeholder: "Servicios profesionales — enter para saltear",
    })
  ).trim();

  const exterior: DatosExportacion = {
    cuitPais,
    nombre: nombreCliente,
    domicilio: domicilioCliente,
    paisDestino,
    cuitPaisDesc: cuitElegido.descripcion,
    paisDestinoDesc: paisElegido.nombre,
    tipoExpo,
    idioma,
    ...(idImpositivo && { idImpositivo }),
    ...(formaPago && { formaPago }),
  };

  const template: Template = {
    nombre,
    receptor: null,
    exterior,
    razonSocial: nombreCliente,
    domicilio: domicilioCliente,
    ...(moneda !== "PES" && { moneda }),
    ...(descripcion && { descripcion }),
  };
  guardarTemplate(template);

  p.note(JSON.stringify(template, null, 2), `Guardado en ${templatesDir()}`);
  if (!config.puntoVentaExportacion) {
    p.log.warn(
      "Todavía no hay punto de venta de exportación en el config.\n" +
        "ARCA exige uno APARTE del de la Factura C: dalo de alta en «Administración de\n" +
        "Puntos de Venta y Domicilios» con el sistema «Comprobantes de Exportación -\n" +
        'Webservices», y agregá "puntoVentaExportacion": <número> al config.json.'
    );
  }
  p.outro(`Listo. Probalo: facturar 3000 ${nombre}`);
}

/**
 * Un select sobre una lista larga: primero pide un texto para filtrar, porque
 * las tablas de ARCA tienen cientos de entradas y un menú de 777 opciones es
 * inusable en una terminal.
 */
async function elegirDeLista(
  mensaje: string,
  opciones: { value: number; label: string; buscar: string }[]
): Promise<number | null> {
  let candidatas = opciones;
  if (candidatas.length > 12) {
    const filtro = valor(
      await p.text({
        message: `${mensaje} — escribí parte del nombre para buscar`,
        placeholder: "suecia",
      })
    )
      .trim()
      .toUpperCase();
    const filtradas = opciones.filter((o) => o.buscar.toUpperCase().includes(filtro));
    if (filtradas.length === 0) {
      p.cancel(`No hay ninguna opción que contenga «${filtro}».`);
      process.exitCode = 1;
      return null;
    }
    candidatas = filtradas.slice(0, 30);
    if (filtradas.length > 30) {
      p.log.warn(`Hay ${filtradas.length} coincidencias: te muestro las primeras 30.`);
    }
  }
  return valor(
    await p.select<number>({
      message: mensaje,
      options: candidatas.map((o) => ({ value: o.value, label: o.label })),
    })
  );
}
