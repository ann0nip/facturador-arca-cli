/**
 * `facturar init` — el wizard de configuración inicial.
 *
 * Configura el emisor y, si hace falta, genera la private key y el CSR
 * localmente (sin OpenSSL) guiando el trámite en el portal de ARCA.
 * El detalle completo del trámite está en docs/setup-arca.md.
 */

import fs from "node:fs";
import path from "node:path";

import * as p from "@clack/prompts";

import { valor } from "./comun.js";
import { generarKeyCsr } from "../core/certificados.js";
import { type Concepto, parsearCuit } from "../core/domain.js";
import {
  type Emisor,
  cargarConfig,
  configPath,
  guardarConfig,
  keysDir,
} from "../config.js";

export async function cmdInit(): Promise<void> {
  p.intro("🧾 facturador-arca — configuración inicial");

  const existente = cargarConfig();
  if (existente) {
    const rehacer = valor(
      await p.confirm({
        message: `Ya hay una configuración en ${configPath()}. ¿Rehacerla?`,
        initialValue: false,
      })
    );
    if (!rehacer) {
      p.outro("Se mantiene la configuración actual.");
      return;
    }
  }

  // --- emisor ----------------------------------------------------------------
  const cuitTexto = valor(
    await p.text({
      message: "Tu CUIT (el que factura, con o sin guiones)",
      placeholder: "20-12345678-6",
      validate: (v) =>
        parsearCuit(v ?? "") === null
          ? "No es un CUIT válido (verifico el dígito final)"
          : undefined,
    })
  );
  const cuit = parsearCuit(cuitTexto)!;

  const razonSocial = valor(
    await p.text({
      message: "Tu nombre / razón social TAL COMO figura en ARCA",
      placeholder: "PEREZ JUAN",
      validate: (v) => (!v?.trim() ? "No puede quedar vacío" : undefined),
    })
  ).trim();

  const domicilio = valor(
    await p.text({
      message: "Domicilio comercial (sale impreso en el PDF)",
      defaultValue: "",
      placeholder: "Calle 123, Ciudad — enter para dejarlo vacío",
    })
  ).trim();

  const inicioActividades = valor(
    await p.text({
      message: "Fecha de inicio de actividades (dd/mm/aaaa, para el PDF)",
      defaultValue: "",
      placeholder: "22/02/2017 — enter para dejarlo vacío",
      validate: (v) =>
        v && !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(v.trim())
          ? "Formato: dd/mm/aaaa (o vacío)"
          : undefined,
    })
  ).trim();

  const concepto = valor(
    await p.select<Concepto>({
      message: "¿Qué vendés?",
      options: [
        { value: 2, label: "Servicios", hint: "con período facturado; 10 días retroactivos" },
        { value: 1, label: "Productos", hint: "sin período; 5 días retroactivos" },
        { value: 3, label: "Productos y servicios" },
      ],
      initialValue: 2,
    })
  );

  const puntoVenta = Number(
    valor(
      await p.text({
        message: "Punto de venta tipo Web Service (número)",
        placeholder: "OJO: NO es el de Comprobantes en Línea — ver docs/setup-arca.md",
        validate: (v) =>
          !/^\d+$/.test(v?.trim() ?? "") || Number(v) < 1
            ? "Tiene que ser un número (ej: 3)"
            : undefined,
      })
    )
  );

  // --- modo (antes del certificado: las instrucciones dependen de esto) --------
  const produccion = valor(
    await p.confirm({
      message:
        "¿Emitir facturas REALES? (No = modo práctica/homologación, lo recomendado para empezar)",
      initialValue: false,
    })
  );

  // --- certificado -------------------------------------------------------------
  const modoCert = valor(
    await p.select({
      message: `Certificado digital de ARCA (${produccion ? "de producción" : "de PRÁCTICA: se saca en la app WSASS"})`,
      options: [
        {
          value: "generar",
          label: "Generar ahora la clave privada y el pedido (CSR)",
          hint: "si todavía no tenés certificado — sin OpenSSL",
        },
        { value: "tengo", label: "Ya tengo el certificado (.crt) y la clave (.key)" },
        { value: "despues", label: "Lo resuelvo después", hint: "sin cert no se puede emitir" },
      ],
    })
  );

  let certPath = "";
  let keyPath = "";

  if (modoCert === "generar") {
    const alias = valor(
      await p.text({
        message: "Alias para reconocer el certificado en ARCA",
        initialValue: "facturador",
        validate: (v) =>
          !/^[a-z0-9-]+$/i.test(v ?? "") ? "Solo letras, números y guiones" : undefined,
      })
    );
    const sp = p.spinner();
    sp.start("Generando clave privada de 2048 bits (queda SOLO en tu máquina)");
    const { keyPem, csrPem } = generarKeyCsr(cuit, razonSocial, alias);
    fs.mkdirSync(keysDir(), { recursive: true, mode: 0o700 });
    keyPath = path.join(keysDir(), "privada.key");
    certPath = path.join(keysDir(), "certificado.crt");
    const csrPath = path.join(keysDir(), "pedido.csr");
    fs.writeFileSync(keyPath, keyPem, { mode: 0o600 });
    fs.writeFileSync(csrPath, csrPem);
    sp.stop("Clave privada y CSR generados ✓");

    const pasosHomologacion =
      `1. Entrá a WSASS (homologación) con tu clave fiscal:\n` +
      `   https://wsass-homo.afip.gob.ar/wsass/portal/main.aspx\n` +
      `   (si no te deja entrar, adherí antes el servicio WSASS en el portal)\n` +
      `2. "Nuevo Certificado" → Nombre simbólico del DN: «${alias}»\n` +
      `   → pegá TODO el contenido de:\n   ${csrPath}\n` +
      `3. Guardá el certificado que te da (aunque el archivo se llame\n` +
      `   distinto) EXACTAMENTE acá — el archivo lo creás vos:\n   ${certPath}\n` +
      `4. En WSASS → "Crear autorización a servicio" → autorizá «wsfe»\n` +
      `   para el DN «${alias}».`;
    const pasosProduccion =
      `1. Portal de ARCA (clave fiscal nivel 3) → "Administrador de\n` +
      `   Certificados Digitales" → Agregar alias «${alias}» y subí:\n   ${csrPath}\n` +
      `2. Descargá el certificado y guardalo (el archivo lo creás vos,\n` +
      `   aunque el que bajes se llame distinto) EXACTAMENTE acá:\n   ${certPath}\n` +
      `3. En "Administrador de Relaciones con Clave Fiscal" → "Nueva\n` +
      `   Relación" → WebServices → Facturación Electrónica → y como\n` +
      `   representante elegí tu certificado «${alias}».\n` +
      `   (OJO: "Adherir Servicio" NO sirve para esto — es el otro botón.)\n` +
      `4. Creá un punto de venta tipo Web Service (si no lo hiciste).`;

    p.note(
      (produccion ? pasosProduccion : pasosHomologacion) +
        `\n\nGuía completa: docs/setup-arca.md del repo.`,
      produccion
        ? "Próximos pasos en el portal de ARCA (producción)"
        : "Próximos pasos en el portal de ARCA (modo práctica: WSASS)"
    );
  } else if (modoCert === "tengo") {
    certPath = valor(
      await p.text({
        message: "Ruta al certificado (.crt)",
        validate: (v) => (!v || !fs.existsSync(v.trim()) ? "No encuentro ese archivo" : undefined),
      })
    ).trim();
    keyPath = valor(
      await p.text({
        message: "Ruta a la clave privada (.key)",
        validate: (v) => (!v || !fs.existsSync(v.trim()) ? "No encuentro ese archivo" : undefined),
      })
    ).trim();
  }

  // --- extras -----------------------------------------------------------------
  const descripcionDefault = valor(
    await p.text({
      message: "Descripción default del renglón del PDF",
      initialValue: "Servicios",
    })
  ).trim();

  const topeTexto = valor(
    await p.text({
      message: "Tope anual de tu categoría de monotributo, en pesos (para la alerta; vacío = sin alerta)",
      defaultValue: "",
      placeholder: "94805682 — enter para saltear",
      validate: (v) => (v && !/^\d+$/.test(v.trim()) ? "Solo números, sin puntos" : undefined),
    })
  ).trim();

  const emisor: Emisor = {
    cuit,
    puntoVenta,
    razonSocial,
    ...(domicilio && { domicilio }),
    ...(inicioActividades && { inicioActividades }),
    concepto,
    produccion,
    certPath,
    keyPath,
    descripcionDefault,
    umbralCf: 10_000_000, // RG 5700/2025 — editable en config.json si cambia
    ...(topeTexto && { monotributoTope: Number(topeTexto) }),
  };
  guardarConfig(emisor);

  p.note(
    `Config: ${configPath()}\n` +
      `Modo: ${produccion ? "🔴 PRODUCCIÓN (facturas reales)" : "⚠️ práctica (homologación)"}\n` +
      `Podés editar ese JSON a mano cuando quieras.`,
    "Configuración guardada ✓"
  );
  p.outro(
    modoCert === "generar"
      ? "Cuando tengas el .crt en su lugar: facturar 1000 — o creá un template: facturar template add"
      : "Siguiente paso: facturar template add — o directo: facturar 1000"
  );
}
