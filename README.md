# 🧾 facturador-arca

Emití **Factura C y Factura E en ARCA** (ex-AFIP) desde la terminal, en un
comando:

```bash
facturar 3000 acme --vto 10/07
# ✅ Emitida: 00003-00000411 — CAE 75123456789012
# 📄 PDF: ./Factura-C-00003-00000411.pdf
```

Para **monotributistas**. Multiplataforma (macOS / Windows / Linux).
**Sin intermediarios**: hablás directo con ARCA, con tu propio certificado.

## Por qué este y no otro

- 🔐 **Tus claves nunca salen de tu máquina.** La autenticación con ARCA
  (WSAA) se firma localmente. Sin servicios de terceros, sin cuentas extra,
  sin darle tu clave fiscal ni tu certificado a nadie.
- 💵 **Moneda extranjera de primera clase**: facturá en USD con la
  cotización oficial de ARCA consultada automáticamente al emitir, pago en
  la misma moneda, y el PDF con la leyenda legal del total en pesos.
- 🌎 **Factura E (exportación de servicios)**: si el cliente es del exterior,
  el mismo comando emite Factura E por WSFEX — con CUIT País, país destino y
  forma de pago. Sin flag nuevo: lo decide el template.
- 📄 **PDF idéntico al oficial**, generado en tu máquina, con el QR
  obligatorio (RG 4892/2020). Sin cuotas ni links que vencen.
- 🏷 **Templates**: guardá cada cliente una vez (`facturar template add acme`)
  y después es `facturar 1000 acme`.
- 🧪 **Modo práctica por default**: probás contra el entorno de homologación
  de ARCA (facturas que no valen) hasta que digas explícitamente lo contrario.
- 📁 **Tus datos son tuyos**: config y templates en JSON editables, log de
  comprobantes en un archivo de texto plano (JSONL). Sin base de datos, sin
  nube.

## Requisitos

1. **Node.js ≥ 20** ([nodejs.org](https://nodejs.org))
2. **Ser monotributista** con clave fiscal nivel 3
3. **Certificado digital de ARCA** — es un trámite de una sola vez y el
   propio programa te lo hace fácil: `facturar init` genera la clave y el
   pedido sin que tengas que instalar nada más. Guía completa:
   [docs/setup-arca.md](docs/setup-arca.md)

## Instalación y arranque

```bash
npm install -g facturador-arca

facturar init            # wizard: emisor + certificado (guiado, una vez)
facturar template add    # opcional: guardá un cliente frecuente
facturar 1000            # ¡a facturar! (consumidor final)
```

El wizard arranca en **modo práctica**: emitís facturas de mentira contra el
entorno de homologación de ARCA hasta validar que todo funciona. Recién ahí
pasás a producción (ver la guía).

## Uso

```bash
facturar 15000                            # consumidor final, hoy
facturar 3000 acme                        # al template «acme»
facturar 15000 20-12345678-6              # a un CUIT puntual (pregunta cond. IVA)
facturar 15000 --fecha 26/06              # fecha retroactiva
facturar 15000 --periodo 01/06-30/06      # período facturado (servicios)
facturar 3000 acme --vto 10/07 -d "Diseño web, junio"
```

| Opción | Qué hace |
|---|---|
| `--fecha dd/mm` | Fecha del comprobante (hasta 10 días atrás servicios / 5 productos) |
| `--periodo d1-d2` | Período facturado (solo servicios) |
| `--vto dd/mm` | Fecha de vto. para el pago (default: la de emisión) |
| `--detalle "…"` / `-d` | Texto del renglón del PDF |
| `--moneda PES\|DOL` | Pisa la moneda del template |
| `--cotizacion N` | Fuerza el tipo de cambio (default: el oficial de ARCA) |
| `--si` / `-y` | Emitir sin confirmación (scripts) |

Antes de emitir siempre ves un **preview** con todo (y en producción, un
cartel rojo). La emisión es irreversible: un error se corrige con nota de
crédito, no borrando.

### Templates

Un template es un cliente con nombre:

```bash
facturar template add acme   # wizard: CUIT, cond. IVA, moneda, etc.
facturar template list
facturar 3000 acme --periodo 01/06-30/06 --vto 10/07
```

Se guardan como JSON editable (ej. `~/.config/facturador/templates/`):

```json
{
  "nombre": "acme",
  "receptor": { "docTipo": 80, "docNro": 30111111118, "condIva": 1 },
  "razonSocial": "ACME S.A.S.",
  "moneda": "DOL",
  "pagoEnMonedaExtranjera": true,
  "condicionVenta": "Transferencia Bancaria - Moneda Extranjera",
  "descripcion": "Servicios Profesionales"
}
```

## Factura E — exportación de servicios

Si le facturás a un cliente del exterior, elegí **«Un cliente del exterior»**
en `facturar template add`. El wizard trae de ARCA las tablas de países y de
CUIT País y te las hace elegir de una lista: son códigos que asigna ARCA y no
hay forma de deducirlos.

```bash
facturar template add proxify     # → "Un cliente del exterior"
facturar 3000 proxify             # emite Factura E, no C
```

Es el **mismo comando**: el template decide. Pero por dentro va a otro web
service (WSFEX) y cambian varias reglas:

| | Factura C | Factura E |
|---|---|---|
| Receptor | CUIT/DNI + condición IVA | CUIT País + país destino |
| Fechas | hasta 10 días atrás, futuro prohibido | **±5 días**, futuro permitido |
| Período facturado | `--periodo` | no existe |
| `--vto` | vencimiento de pago | **fecha de pago** (dato del WS) |
| Forma de pago | solo texto del PDF | **viaja a ARCA** |
| Descripción | solo texto del PDF | **viaja a ARCA** |

Hace falta un poco de trámite en ARCA, una sola vez:

1. Habilitar el servicio **`wsfex`** para tu certificado (aparte de `wsfe`),
   en «Administrador de Relaciones de Clave Fiscal».
2. Dar de alta un punto de venta **aparte**, de tipo «Comprobantes de
   Exportación - Webservices» — ARCA no deja reusar el de la Factura C. Se
   configura con `"puntoVentaExportacion"` en el `config.json`.

Si falta alguna de las dos, el comando te lo dice con las instrucciones
exactas en vez de fallar contra ARCA.

### Dónde vive todo

| Qué | Dónde (macOS/Linux) |
|---|---|
| Config del emisor | `~/.config/facturador/config.json` |
| Templates | `~/.config/facturador/templates/*.json` |
| Log de comprobantes | `~/.config/facturador/comprobantes.jsonl` |
| Claves y certificados | `~/.config/facturador/keys/` |
| PDFs emitidos | el directorio actual (o `pdfDir` del config) |

En Windows: `%APPDATA%\facturador\`. Todo editable a mano; el log es
append-only, una línea JSON por comprobante — hacele backup como a cualquier
archivo.

## Seguridad, en serio

- La **private key se genera en tu máquina** (permisos 600) y jamás viaja a
  ningún lado: la firma criptográfica de la autenticación pasa localmente.
- **Cero telemetría, cero servicios propios**: las únicas conexiones son a
  `*.afip.gob.ar`.
- Allowlist natural: el que puede facturar es el que tiene acceso a tu
  usuario de tu máquina.
- Nunca uses herramientas que pidan tu **clave fiscal**: este proyecto
  existe, en parte, para no tener que hacerlo.

## Alcance (honesto)

Hoy emite **Factura C** (monotributo) a consumidor final o receptor
identificado, y **Factura E** (exportación de servicios) a clientes del
exterior — en pesos o dólares las dos. No hace (todavía): notas de crédito
por comando, resúmenes/CSV, Factura A/B, email al cliente. El core ya
soporta varias de esas cosas — ver ideas de v2 en el repo. PRs bienvenidos.

Inspirado en [facturador-arca (bot de Telegram)](https://github.com/Lanuti-Franco/facturador-arca),
del que hereda el conocimiento de dominio validado contra el WSFE real.

## Disclaimer

Esto no es asesoramiento fiscal. Verificá los comprobantes emitidos y los
umbrales vigentes con tu contador. Usalo bajo tu propia responsabilidad.

## Licencia

MIT — usalo, modificalo, regalalo.
