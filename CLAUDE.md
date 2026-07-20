# CLAUDE.md

CLI npm para que un monotributista emita **Factura C en ARCA** desde la
terminal: `facturar 1000 acme` → CAE + PDF con QR. Multiplataforma
(Mac/Windows/Linux), **sin intermediarios**: la autenticación WSAA se firma
localmente (node-forge) y las claves nunca salen de la máquina.

Inspirado en el repo hermano `../facturador-ARCA` (bot de Telegram en Python):
el conocimiento de dominio validado contra el WSFE real vive en su
`NOTAS-ARCA.md` — consultarlo ante cualquier duda de reglas de ARCA.

## Decisiones cerradas (no re-litigar)

- Paquete npm: **`facturador-arca`**; binario: **`facturar`**. La carpeta se
  llama `facturador-arca-cli` porque el filesystem de macOS es
  case-insensitive y `facturador-arca` chocaría con `facturador-ARCA`.
- **Template = receptor** (cliente) + config de la factura. Un solo emisor
  global, configurado por `facturar init`.
- **Firma local** (WSAA + WSFE directo), nada de Afip SDK hosted.
- MVP: init (wizard key+CSR), template add/list, facturar con PDF+QR, log
  local JSONL. NC / resumen / CSV / email = v2.
- Dependencias **JS puro únicamente** (sin módulos nativos): node-forge,
  pdf-lib, qrcode, @clack/prompts, picocolors.
- Español rioplatense en todo lo de cara al usuario.

## Comandos

```bash
npm run dev       # correr la CLI sin build (tsx)
npm test          # vitest
npm run build     # tsc → dist/
```

## Arquitectura

```
src/cli.ts            ← dispatcher: 1er arg monto → emitir; si no, subcomando
src/commands/         ← capa de conversación (prompts, preview, confirmación)
src/core/             ← lógica sin UI:
  domain.ts           ←   parseo/validación/formato puro (sin red ni disco)
  wsaa.ts             ←   autenticación: TRA + firma CMS + cache ticket 12 h
  wsfe.ts             ←   emisión SOAP: FECAESolicitar / último autorizado
  pdf.ts              ←   PDF local con pdf-lib + qrcode (RG 4892)
  store.ts            ←   log local de comprobantes (JSONL)
src/config.ts         ← config.json (emisor) + templates/*.json (receptores)
```

Regla de oro (heredada del bot): la lógica va en `core/`, que no sabe nada de
argv ni prompts. `commands/` solo conversa.

- Config del usuario: `~/.config/facturador` (Mac/Linux) o `%APPDATA%\facturador`
  (Windows). Override para tests y power users: `FACTURADOR_CONFIG_DIR`.
- Los tests de config usan un dir temporal vía ese override — nunca tocar la
  config real del usuario desde un test.

## Reglas de dominio que rompen si no se respetan

- Fechas WSFE como entero `aaaammdd`, siempre en hora argentina — en `domain.ts`
  las fechas son `{y, m, d}` planos, jamás `Date` con timezone del host.
- Numeración cronológica por PV+tipo (error 10016). Retroactivo: 10 días
  servicios / 5 productos (`diasAtrasMax`).
- Concepto 1 (productos): NO mandar `FchServDesde/Hasta/VtoPago`.
- Factura C: `ImpNeto == ImpTotal`, `ImpIVA = 0`.
- **Moneda extranjera** (caso de uso real del usuario, ver factura de referencia
  en la memoria del proyecto): `MonId="DOL"` + `MonCotiz` = cotización oficial
  (FEParamGetCotizacion); importes expresados EN la moneda; el PDF imprime
  además el total en pesos al tipo de cambio. `CanMisMonExt` ("S"/"N") indica
  pago en la misma moneda — verificar comportamiento en homologación.
- `FchVtoPago` es configurable (--vto), no siempre = fecha de emisión.
- "Condición de venta" (ej: "Transferencia Bancaria - Moneda Extranjera") es
  dato SOLO del PDF: el WSFE no lo recibe.
- Homologación por default; producción solo explícita. La emisión es
  irreversible: nunca dejar un error en silencio después de obtener el CAE
  (patrón: emitir → loguear → PDF, avisando qué paso falló).

## Estado / pendientes

Ver la task list de la sesión. Para el smoke test contra homologación hace
falta un certificado de homologación del usuario (app WSASS del portal ARCA);
el CUIT de testing compartido del Afip SDK NO sirve fuera de su proxy.

## Ideas v2 (pedidas o anotadas, no prometidas)

- `facturar padron`: autocompletar/verificar los datos del emisor (domicilio,
  inicio de actividades, razón social) desde el padrón de ARCA
  (ws_sr_constancia_inscripcion). Requiere autorizar ese servicio al cert
  además de wsfe, y solo funciona DESPUÉS de tener el certificado — por eso
  el init los pide a mano (lo preguntó el usuario en jul-2026).
- Nota de crédito (`facturar nc <nro>`), resumen y export CSV (el core ya
  soporta NC en wsfe/pdf/store; falta solo el comando).
- Copias ORIGINAL/DUPLICADO/TRIPLICADO en el PDF (hoy solo ORIGINAL).
- Envío del PDF por email al receptor (el template ya tiene el campo email).
- ~~Mostrar el acumulado real / alerta de categoría de monotributo vía WSFE~~
  **INVESTIGADO Y DESCARTADO (jul-2026).** La idea era mostrar cuánto lleva
  facturado el usuario en 12 meses contra el tope de su categoría, tomando el
  acumulado de ARCA (no del log local) para que incluya lo facturado por el
  portal web. No hay fuente confiable:
  - Comprobantes en Línea (el portal web) usa **otro punto de venta** con su
    propia secuencia (NOTAS-ARCA §2), y `FEParamGetPtosVenta`/`FECompConsultar`
    del WSFEv1 solo ven los comprobantes autorizados por web service — el PV de
    la web ni aparece. O sea: la reconstrucción WSFE tendría el mismo punto
    ciego que el log local (no vería lo emitido por la web).
  - No hay WS oficial de "todo lo que emití" (Mis Comprobantes / Libro IVA
    Digital son solo portal web, sin API pública limpia).
  - No hay API, ni oficial ni de terceros confiable, para la **tabla de topes**
    por categoría (solo la página HTML afip.gob.ar/monotributo/categorias.asp,
    que se reajusta por movilidad feb/ago).

  La alerta actual (`facturar.ts`, basada en el log local + `monotributoTope`
  de la config) queda como está, con su limitación conocida: solo cuenta lo
  emitido con este CLI. No re-proponer el enfoque WSFE sin antes verificar
  contra la cuenta real que el WS efectivamente devuelve los comprobantes de
  Comprobantes en Línea (casi seguro que no).
