# Factura E (exportación) — verificación y plan

Respuesta al encargo de `docs/factura-e-plan-prompt.md`.
Verificado contra homologación el **06-ago-2026**. Todavía sin código.

---

## 1. La pregunta: WSFEv1 o WSFEX → **es WSFEX**

Tres evidencias independientes, todas contra el web service real.

### Evidencia A — el código 19 no existe en WSFEv1

`FEParamGetTiposCbte` en homologación, autenticado con el ticket WSAA de
`wsfe` del certificado del usuario (CUIT 20372114356, `certificado.crt`):

```
FEDummy → AppServer=OK DbServer=OK AuthServer=OK
FEParamGetTiposCbte → 36 tipos
  1 2 3 4 5 6 7 8 9 10 11 12 13 15 34 35 39 40 49 51 52 53 54
  60 61 63 64 201 202 203 206 207 208 211 212 213
```

Ningún comprobante de exportación: no está el **19** (Factura E), ni el 20
(ND E) ni el 21 (NC E). Y no es una restricción de este CUIT —
`FEParamGetTiposCbte` es la tabla de parámetros del propio servicio: WSFEv1
directamente **no modela exportación**.

Salida completa: `resultado-homo.md` (scratchpad de la sesión).

### Evidencia B — el PDF de referencia es, campo por campo, el modelo de WSFEX

Bajé el WSDL de `https://wswhomo.afip.gov.ar/wsfexv1/service.asmx?WSDL`
(`targetNamespace="http://ar.gov.afip.dif.fexv1/"`). El tipo `ClsFEXRequest`
tiene exactamente los datos que imprime tu Factura E de Proxify y que **no
existen en WSFEv1**:

| Dato del PDF | Campo WSFEX |
|---|---|
| `CUIT País: 55000004293 (SUECIA - Persona Jurídica)` | `Cuit_pais_cliente` |
| `Señor(es): Proxify` | `Cliente` |
| `Domicilio: Barnhusgatan 3, Stockholm, 11123` | `Domicilio_cliente` |
| `Destino del Comprobante: SUECIA` | `Dst_cmp` |
| `Forma de Pago: Criptomonedas` | **`Forma_pago`** |
| `Fecha de Pago: 30/07/2025` | `Fecha_pago` |
| `Incoterms:` (vacío) | `Incoterms` / `Incoterms_Ds` |
| (idioma del comprobante) | `Idioma_cbte` |
| `Ítem 0001 · Servicios profesionales · 1,000000 · 1277320,000000` | `Items[]` |

Secuencia completa de `ClsFEXRequest` (orden del schema, que importa igual
que en WSFEv1):

```
Id, Fecha_cbte, Cbte_Tipo, Punto_vta, Cbte_nro, Tipo_expo,
Permiso_existente, Permisos[], Dst_cmp, Cliente, Cuit_pais_cliente,
Domicilio_cliente, Id_impositivo, Moneda_Id, Moneda_ctz, CanMisMonExt,
Obs_comerciales, Imp_total, Obs, Cmps_asoc[], Forma_pago, Incoterms,
Incoterms_Ds, Idioma_cbte, Items[], Opcionales[], Fecha_pago, Actividades[]
```

### Evidencia C — el certificado NO está autorizado para `wsfex`

```
FEXDummy → AppServer=OK DbServer=OK AuthServer=OK      (endpoint vivo)
WSAA service="wsfex" → "Computador no autorizado a acceder al servicio"
```

O sea: el endpoint responde, pero el ticket no se emite. **Hace falta un
trámite manual tuyo** (sección 3). Todo lo que sigue de verificación empírica
está bloqueado hasta entonces.

---

## 2. Lo que esto cambia respecto de lo que asumía el prompt

- **La duda de `ImpOpEx` desaparece.** WSFEX no tiene `ImpNeto`, `ImpOpEx`,
  `ImpIVA` ni `ImpTrib`. Tiene un solo `Imp_total` más el detalle de `Items`.
  No hay nada que decidir ahí.
- **"Forma de Pago" SÍ viaja al web service.** Confirmado por el WSDL:
  `Forma_pago` es un campo del request, no adorno del PDF. Tu intuición era
  correcta y hay que modelarlo como dato del comprobante. **No** reusar
  `condicionVenta` (que sigue siendo solo-PDF para la Factura C).
- **El detalle también viaja.** En Factura C el renglón del PDF es local; en
  WSFEX los `Items` (descripción, cantidad, precio unitario, total) van a
  ARCA. Deja de ser cosmético.
- **No se puede reusar `wsfe.ts` cambiando `CbteTipo`.** Es otro servicio,
  otro namespace, otro modelo de datos. Va un `core/wsfex.ts` nuevo.
- **No hay `Concepto` ni `FchServDesde/Hasta/VtoPago`.** En su lugar:
  `Tipo_expo` (1 bienes / 2 servicios / 4 otros) y `Fecha_pago`. Toda la
  maquinaria de período de servicio del CLI no aplica acá.
- **`Idioma_cbte` es obligatorio** (`minOccurs=1`), igual que `Tipo_expo`,
  `Dst_cmp` y `Cuit_pais_cliente`.
- **Idempotencia mejor que en WSFEv1.** El request lleva un `Id` que asigna el
  cliente (`FEXGetLast_ID` + 1) y la respuesta trae `Reproceso`: si reenviás
  el mismo `Id`, ARCA devuelve el CAE original en vez de duplicar. Eso resuelve
  de raíz el problema que hoy `wsfe.ts` solo puede advertir con un mensaje
  ("verificá en Mis Comprobantes antes de reintentar"). Vale la pena usarlo.
- **La moneda:** tu caso base en PES queda igual de válido, pero WSFEX tiene
  su propia tabla (`FEXGetPARAM_MON`) y su propia cotización
  (`FEXGetPARAM_Ctz`) — no la de `FEParamGetCotizacion` de WSFEv1. Ver riesgo
  R1.

---

## 3. Trámites tuyos en ARCA (bloqueantes, no los resuelve el código)

> Los deep links del portal de ARCA rebotan al home: hay que buscar el
> **servicio** por nombre en "Mis Servicios" / el buscador de servicios.

### 3.0 — Identificadores a usar (verificados contra los certificados en disco)

|  | Homologación | Producción |
|---|---|---|
| Certificado | `keys/certificado.crt` | `keys/certificado-produccion.crt` |
| **DN / alias (el nombre que aparece en el portal)** | **`facturador2`** | **`facturador-arca-cli`** |
| Emisor del cert | `CN=Computadores Test, O=AFIP, C=AR` | `CN=Computadores, O=AFIP, C=AR` |
| CUIT representado | `20372114356` | `20372114356` |
| Servicio a autorizar | `wsfex` | *Facturación Electrónica de Exportación* |
| Vigencia | 14-jul-2026 → 13-jul-2028 | 14-jul-2026 → 13-jul-2028 |

**No hay que crear ningún certificado nuevo ni ningún DN nuevo.** Se le agrega
una autorización más a cada DN existente, igual que se hizo con `wsfe`.

Tres cosas verificadas al respecto:

1. Los dos certificados y `keys/privada.key` **comparten el mismo par de
   claves** (huella del pubkey `721e438a…` en los tres). Un solo CSR, dos
   certificados.
2. El CSR original (`keys/pedido.csr`) pide `CN=facturador`, pero los
   certificados emitidos quedaron con `CN=facturador2` y
   `CN=facturador-arca-cli`. Es decir: **el CN lo define el alias que se tipea
   en el portal, no el CSR** — por eso el nombre a buscar en la lista de WSASS
   es el del certificado, no el del pedido.
3. `certificado.crt` + `privada.key` obtuvieron ticket WSAA de `wsfe` en
   homologación el 06-ago-2026 (ver §1, evidencia A). O sea: ese DN es el que
   ya está autorizado y funcionando, y es exactamente el que hay que autorizar
   para `wsfex`.

**3.1 — Autorizar `wsfex` en homologación.**
Servicio: **`WSASS - Autogestión Certificados Homologación`** (el mismo donde
se generó el certificado de testing) → *Crear autorización a servicio* →
DN `facturador2` + CUIT representado `20372114356` + servicio `wsfex`.

**3.2 — Autorizar `wsfex` en producción.**
Servicio: **`Administrador de Relaciones de Clave Fiscal`** → Nueva Relación →
ARCA → WebServices → *Facturación Electrónica de Exportación* → representante
= el mismo computador/alias del `certificado-produccion.crt` que ya tiene
`wsfe`. No hace falta un certificado nuevo.

**3.3 — Dar de alta un punto de venta nuevo.** Confirmado contra la tabla
oficial de tipos de PV de ARCA
([puntos-de-venta.pdf](https://www.afip.gob.ar/facturacion/documentos/puntos-de-venta.pdf)):
son tres tipos **distintos y no intercambiables**.

| PV | Tipo | Sirve para |
|---|---|---|
| **4** (el de tu Factura E de Proxify) | `Comprobantes de Exportación - Comprobante en Línea` (RG 2758 y 4401) | solo el portal web |
| **5** (el que usa este CLI hoy) | `Factura Electrónica - Monotributo - Webservices` (RG 4291) | solo Factura C por WS |
| **nuevo** | **`Comprobantes de Exportación - Webservices`** (RG 2758 y 4401) | ← **el que hace falta** |

La propia ARCA lo dice: *"Los puntos de venta generados mediante los servicios
Comprobantes en línea, Facturador Plus o Web Services deberán ser distintos
entre sí"*. O sea: ni el 4 ni el 5 sirven, hay que crear uno.

Servicio: **`Administración de Puntos de Venta y Domicilios`** → (nombre) →
*A/B/M de Puntos de Venta* → *Agregar* → sistema
**`Comprobantes de Exportación - Webservices`**.
⚠️ Las guías de internet dicen que un monotributista elige *"Factura
Electrónica – Monotributo – Web Services"*: eso es para la **Factura C**, y es
justamente el PV 5 que ya tenés. Para la E hay que elegir el de exportación.

Valores sugeridos para el alta:

| Campo | Valor |
|---|---|
| Número de punto de venta | **6** (o el primero libre; nunca el 4 ni el 5) |
| Nombre de fantasía | `EXPORTACION WS` |
| Sistema | `Comprobantes de Exportación - Webservices` |
| Domicilio | el mismo que el PV 5 (Ibarbalz 1272, Córdoba) |

Y del lado del CLI, los nombres que quedan fijados:

| Cosa | Nombre |
|---|---|
| Clave nueva en `config.json` | `puntoVentaExportacion` |
| Template del cliente | `proxify` (`templates/proxify.json`) |
| Cache del ticket WSAA | `wsaa/ta-wsfex-homo.json` / `ta-wsfex-prod.json` (sale solo) |
| Módulo nuevo | `src/core/wsfex.ts` |
| PDF generado | `Factura-E-00006-00000001.pdf` |

Consecuencia de diseño: **el `puntoVenta` del `config.json` deja de ser único**
— hace falta un PV por régimen (C y E). Ver 4.3.

> Los nombres de los menús del portal los pongo con reserva (ARCA los renombra
> seguido); los nombres de los **tipos de PV** sí son textuales de la tabla
> oficial. Y lo verificable de punta a punta: apenas tengas 3.1 hecho,
> `FEXGetPARAM_PtoVenta` te confirma el número del PV nuevo — el script ya lo
> consulta.

---

## 4. Plan de implementación

Nada de esto reemplaza el flujo de Factura C: se agrega en paralelo.

### 4.1 `src/core/domain.ts`

- `FACTURA_E = 19`, `NOTA_CREDITO_E = 21`, `NOTA_DEBITO_E = 20`.
- `TIPO_EXPO`: `1 = Bienes`, `2 = Servicios`, `4 = Otros` (+ descripciones).
- `IDIOMA_CBTE`: `1 = Español`, `2 = Inglés`, `3 = Portugués` — **a confirmar
  contra `FEXGetPARAM_Idiomas`**, no darlo por bueno.
- `COND_IVA_EXTERIOR = 9` ("Cliente del Exterior"). Ojo: esto es de WSFEv1,
  **no** de WSFEX — sirve para el rótulo del PDF y para una Factura C a un
  cliente del exterior, no viaja en el request de exportación. (Verificado:
  `FEParamGetCondicionIvaReceptor` lista el 9 como válido para clase C.)
- `parsearCuitPais(texto)`: un CUIT País (ej. `55000004293`) tiene 11 dígitos
  pero **no** cumple el dígito verificador. Hoy `parsearDoc()` lo rechazaría.
  Función aparte + validación contra la tabla `FEXGetPARAM_DST_CUIT`, nunca
  con el algoritmo del CUIT local.
- `nombreComprobante()`: prefijo `Factura-E` / `NC-E` para 19/21.

### 4.2 `src/core/wsfex.ts` (nuevo)

Espejo estructural de `wsfe.ts`, misma disciplina:

```ts
const URL_WSFEX = {
  homologacion: "https://wswhomo.afip.gov.ar/wsfexv1/service.asmx",
  produccion:   "https://servicios1.afip.gov.ar/wsfexv1/service.asmx",
};
const NS = "http://ar.gov.afip.dif.fexv1/";
```

- `armarCmpExpo(p, numero, id): string` — el XML de `ClsFEXRequest` en el
  orden del schema. **Función pura, testeable sin red**, igual que
  `armarFecaeDet`. Es donde va la mayor parte de los tests.
- `ultimoAutorizadoExpo()` → `FEXGetLast_CMP` (ojo: el request mete
  `Pto_venta` y `Cbte_Tipo` **dentro** del bloque `Auth`, tipo
  `ClsFEX_LastCMP` — distinto de WSFEv1).
- `ultimoIdRequest()` → `FEXGetLast_ID`.
- `autorizarExportacion()` → `FEXAuthorize`; leer `Resultado`, `Cae`,
  `Fch_venc_Cae`, `Reproceso`, `Motivos_Obs`.
- Errores: `<FEXErr><ErrCode><ErrMsg>` (uno solo, no una lista de `<Err>`
  como WSFEv1) + `FEXEvents`. `WsfexError` propio.
- Consultas de parámetros para validar antes de emitir: `FEXGetPARAM_MON`,
  `_Ctz`, `_DST_pais`, `_DST_CUIT`, `_Idiomas`, `_Incoterms`, `_Tipo_Expo`,
  `_UMed`, `_PtoVenta`.

`wsaa.ts` **no se toca**: ya recibe `service` y ya cachea por servicio y
entorno (`ta-wsfex-homo.json` sale solo).

### 4.3 `src/config.ts`

Extensión aditiva, sin romper los templates ni el `config.json` que ya están
en disco.

En `Emisor`, un PV aparte para exportación (ver 3.3 — son PV distintos por
obligación de ARCA, no por gusto):

```ts
export interface Emisor {
  // ...lo de hoy...
  puntoVenta: number;                 // sigue siendo el de Factura C (WSFEv1)
  puntoVentaExportacion?: number;     // el de "Comprobantes de Exportación - Webservices"
}
```

Si falta y el template pide Factura E, el error tiene que decir exactamente
qué tipo de PV dar de alta, no un genérico.

En `Template`, el receptor del exterior:

```ts
export interface ReceptorExterior {
  cuitPais: number;        // 55000004293
  nombre: string;          // "Proxify"
  domicilio: string;       // "Barnhusgatan 3, Stockholm, 11123"
  paisDestino: number;     // código de Dst_cmp
  idImpositivo?: string;   // VAT number del cliente
  tipoExpo?: 1 | 2 | 4;    // default 2 (servicios)
  idioma?: 1 | 2 | 3;      // default 1 (español)
  formaPago?: string;      // "Criptomonedas" — ESTE viaja a ARCA
  incoterms?: string;
}

export interface Template {
  // ...lo de hoy...
  exterior?: ReceptorExterior;   // presente ⇒ Factura E
}
```

La presencia de `exterior` es el discriminante. Un template viejo sigue
cargando igual. `cargarTemplate()` valida el bloque nuevo con los mismos
mensajes legibles que ya usa (los templates se editan a mano).

### 4.4 `src/core/store.ts`

`Comprobante` gana campos opcionales: `cuitPais`, `paisDestino`, `tipoExpo`,
`formaPago`, `idRequest`. Como son opcionales, el log viejo sigue leyéndose.

`totalFacturado12m()` ya funciona sin cambios (suma por
`importeTotal × cotizacion`), así que la Factura E entra sola en la alerta de
tope de monotributo — que es una de las razones por las que la emitís.

### 4.5 `src/core/pdf.ts`

El layout de exportación es **distinto**, no una variante menor del actual:

- `TIPOS_CBTE[19] = ["FACTURA DE EXPORTACIÓN", "CÓD. 19"]`, letra **E**.
- Copias `ORIGINAL / DUPLICADO / COPIA` (RCEL usa "COPIA", no "TRIPLICADO").
  Como el CLI ya emite ORIGINAL/DUPLICADO/TRIPLICADO para la C, dejarlo
  parametrizable por tipo.
- Cabecera derecha: la línea de condición IVA del emisor se reemplaza por
  **"IVA EXENTO OPERACIÓN DE EXPORTACIÓN"**.
- Bloque receptor: `Señor(es)`, `Domicilio`, `CUIT País: … (PAÍS - Persona
  Jurídica)`. **No** lleva "Condición frente al IVA" del receptor.
- Bloque nuevo: `Divisa` + `Destino del Comprobante`.
- Banda nueva: `Forma de Pago` · `Fecha de Pago` · `Incoterms`.
- Tabla con 5 columnas (`Ítem`, `Descripción`, `Cantidad`, `Precio Unit.`,
  `Total por ítem`), no las 8 de la Factura C. Cantidad y precio con **6
  decimales** (`1,000000`), como imprime ARCA.
- Sin período facturado ni vto. de pago.

### 4.6 `src/commands/facturar.ts` y `template.ts`

- `facturar 3000 proxify` → si el template trae `exterior`, se va por la rama
  WSFEX. Sin flag nuevo: el template ya dice qué es.
- Preview propio: `Factura E — Exportación de servicios`, destino, CUIT País,
  forma de pago. Y el aviso de producción, igual que hoy.
- `facturar template add` con una pregunta "¿el cliente es del exterior?" que
  abre el wizard de `ReceptorExterior` (con las listas traídas de
  `FEXGetPARAM_DST_pais` / `_DST_CUIT`, no tipeadas a mano).
- Se mantiene el patrón: emitir → loguear → PDF, avisando fuerte qué paso
  falló después del CAE.

### 4.7 Orden de trabajo

1. **Ahora, sin bloqueo:** `domain.ts` + `wsfex.ts` con `armarCmpExpo()` y
   tests unitarios del XML (sin red). Ahí se juega la mayor parte de la
   corrección.
2. **Vos:** trámite 3.1 (autorizar `wsfex` en homologación).
3. **Smoke test de solo lectura:** correr el script contra homologación ya
   autenticado → resuelve de una todos los riesgos R1–R6 de abajo, incluido el
   punto de venta.
4. **Recién ahí:** ajustar el request con lo que devolvió el WS y emitir una E
   de prueba en homologación.
5. Con el request ya validado: `config.ts`, `store.ts`, PDF, comando.
6. Producción: trámite 3.2 + 3.3, y una primera E real chica.

Los pasos 1 y 5 son casi todo el código; el 3 es lo que evita construir sobre
supuestos.

---

## 5. Riesgos y supuestos sin verificar

**Todos cerrados** con emisiones reales en homologación el 06-ago-2026 (ver
5.3). Ninguno se resolvió con documentación: los tres hallazgos más caros
salieron del `ErrMsg` de ARCA, y dos de ellos **contradicen al WSDL**.

| # | Supuesto | Resultado |
|---|---|---|
| R1 | WSFEX acepta `Moneda_Id=PES` | ✅ **Sí.** `Moneda_ctz=1` fijo. `FEXGetPARAM_Ctz(PES)` da `[1800] inexistente o SIN cotización` — es esperable, la moneda local no cotiza contra sí misma: hay que **no llamarlo** para PES. DOL también funciona (ctz 1152,42) |
| R2 | `Permiso_existente` vacío para servicios | ⚠️ **Al revés del folclore.** El tag va **SIEMPRE**, y para servicios va **vacío**. Ver 5.3 |
| R3 | El PV 5 sirve para WSFEX | ✅ No sirve. Ver 3.3 |
| R4 | `Pro_umed` para un servicio | ✅ **`7` = "unidades"** aceptado |
| R5 | `Forma_pago` acepta texto libre | ✅ **Sí**, `"Criptomonedas"` pasó sin chistar. Es texto libre |
| R6 | Códigos de país, idioma, tipo de exportación | ✅ Ver 5.2 |
| R7 | Ventana de fechas | ⚠️ **Regla completamente distinta a la Factura C.** Ver 5.3 |
| R8 | Vencimiento del CAE | ✅ **CAE vto = fecha de emisión**, igual que tu PDF de referencia (en Factura C son 10 días) |
| R9 | Qué lleva el QR (RG 4892) | ✅ Ver 5.1 |
| R10 | ¿`Actividades[]` es obligatorio? | ✅ **No.** Emití con y sin el bloque, las dos aprobadas. Tu código (`620100`) está en la tabla, así que se puede mandar; queda opcional |
| R11 | ¿WSFEX valida el punto de venta? | 🟡 **Homologación NO valida**: emití en el PV 1 aunque `FEXGetPARAM_PtoVenta` devuelve 0 filas. Producción sí va a validar → el alta del PV (3.3) sigue siendo obligatoria antes de la primera E real |

---

### 5.2 Parámetros confirmados contra WSFEX homologación (06-ago-2026)

Con el ticket de `wsfex` ya autorizado. Todo esto sale del WS, no de manuales:

```
FEXDummy → AppServer=OK DbServer=OK AuthServer=OK

FEXGetPARAM_Cbte_Tipo  → 19 Facturas de Exportación          ← LA confirmación
                          20 Nota de Débito por Op. con el Exterior
                          21 Nota de Crédito por Op. con el Exterior
                          88 Remito Electrónico · 89 Resumen de Datos

FEXGetPARAM_Tipo_Expo  → 1 Exportación definitiva de Bienes
                          2 Servicios          ← el nuestro
                          4 Otros

FEXGetPARAM_Idiomas    → 1 Español · 2 Inglés · 3 Portugués

FEXGetPARAM_DST_pais   → 303 países. SUECIA = 429
FEXGetPARAM_DST_CUIT   → 777 entradas. 55000004293 = "SUECIA - Persona Jurídica"
                          ← coincide exactamente con tu PDF de referencia

FEXGetPARAM_Incoterms  → 11 (EXW FCA FAS FOB CFR CIF CPT CIP DDP DAP DPU)
                          no aplica a servicios → va vacío

FEXGetPARAM_UMed       → 48. Relevantes: 7=unidades, 98=otras unidades, 0=(vacía)
FEXGetPARAM_MON        → 50. PES y DOL presentes
FEXGetPARAM_Ctz(DOL)   → 1152.42 (20260805)
FEXGetPARAM_Ctz(PES)   → [1800] inexistente o SIN cotización   ← ver R1
FEXGetLast_ID          → 0  → el primer request va con Id = 1
FEXGetPARAM_PtoVenta   → 0 filas                               ← ver R11
```

**`Opcionales` queda vacío y eso es un riesgo menos.** `FEXGetPARAM_Opcionales`
devuelve solo dos códigos, ambos del *Régimen de Exportación Simplificada*
(`2401` Documento de Exportación Simple, `2402` Valor FOB de la operación) —
nada aplicable a exportación de servicios. La sospecha del prompt de que WSFEX
pudiera exigir un bloque `Opcionales` queda descartada para nuestro caso.

> Detalle de implementación: la tabla de `FEXGetPARAM_Actividades` viene con
> encoding roto del lado de ARCA (`CRÃ¿A DE GANADO`, mezclado con entradas
> correctas como `SUBPRODUCTOS CÁRNICOS`). No es un bug de parseo nuestro —
> conviene usar solo los `Id`, nunca las descripciones, para nada que importe.

---

### 5.3 Reglas que solo se descubren emitiendo

Seis Facturas E emitidas en homologación (PV 1, tipo 19). Estas cuatro reglas
**no están en el WSDL, y dos lo contradicen abiertamente**:

**1. `Permiso_existente`: el tag va siempre, y vacío.** El WSDL lo marca
`minOccurs=0` y el folclore dice "omitilo si son servicios". Las dos cosas son
falsas. ARCA responde:

```
omitir el tag   → [1550] Campo Permiso_existente madatorio: Debe ser S, N o
                         vacio (debe enviarse tag)              [sic]
mandar "N"      → [1550] Campo Permiso_existente:'N'. Debe ser 'vacio' para
                         comprobantes 20 o 21 y Tipo_expo=2 o 4
mandar ""       → ✅ aprobada
```

(El segundo mensaje menciona "comprobantes 20 o 21" aunque estábamos emitiendo
un 19: es un texto mal redactado de ARCA. Lo que manda es el `Tipo_expo`.)

**2. `Fecha_pago` es obligatoria para servicios**, pese al `minOccurs=0`:

```
sin Fecha_pago  → [1672] Para facturas de exportacion (2 – Servicios /
                         4 - Otros) es obligatorio informar la fecha de pago
anterior a la
fecha de emisión→ [1674] la fecha de pago debe ser igual o posterior a la
                         fecha de emision del comprobante
```

Default sano: `Fecha_pago = fecha del comprobante`, que cumple las dos.

**3. La ventana de fechas es ±5 días, y admite FUTURO.** Nada que ver con la
regla de la Factura C (10 días atrás para servicios, futuro prohibido):

```
[1500] Campo fecha_cbte: La fecha debe estar incluida en el periodo
       20260801 - 20260811          ← consultado el 06/08/2026
```

Verificado emitiendo con fecha 09/08 (hoy + 3): **aprobada**. O sea
`validarFecha()`/`diasAtrasMax()` del WSFEv1 **no se pueden reusar** — va una
`validarFechaExpo()` aparte (ya implementada en `domain.ts`).

**4. La idempotencia por `Id` funciona de verdad.** Reenviar el mismo
`Id`+`Cbte_nro` de un comprobante ya emitido devolvió **el mismo CAE con
`Reproceso=S`**, sin duplicar nada. Esto es una mejora real sobre el WSFEv1,
donde un timeout deja al usuario sin saber si la factura salió.

**5. Las fechas futuras tienen un efecto colateral feo.** WSFEX exige
numeración cronológica igual que el WSFEv1, pero con otro código:

```
[1535] La fecha de comprobante ingresada debe ser mayor o igual a la del
       ultimo comprobante autorizado
```

Y como acepta hasta +5 días (regla 3), emitir con fecha futura **bloquea todo
lo que quieras emitir con fecha anterior** hasta que el calendario alcance.
Lo descubrí en carne propia: después de la prueba con fecha 09/08, emitir con
fecha 06/08 (la de ese día) daba 1535. `WsfexError` explica esto en el mensaje
de los códigos 1535 y 1500, igual que `WsfeError` hace con el 10016.

Comprobantes de prueba emitidos (homologación, PV 1):

| Nº | Qué probaba | CAE |
|---|---|---|
| 1 | caso base en PES | `76326015909401` |
| 1 (bis) | reenvío del mismo `Id` → `Reproceso=S`, mismo CAE | `76326015909401` |
| 2 | sin bloque `Actividades` | `76326015909414` |
| 3 | en DOL, ctz 1152,42 | `76326015909427` |
| 4 | defaults puros del core | `76326015909430` |
| 5 | fecha futura (hoy + 3) | aprobada |

---

### 5.1 R9 cerrado: el QR de una Factura E (evidencia directa)

El QR de tu comprobante real de Proxify, decodificado:

```json
{ "ver": 1, "fecha": "2025-07-30", "cuit": 20372114356, "ptoVta": 4,
  "tipoCmp": 19, "nroCmp": 29, "importe": 1277320,
  "moneda": "PES", "ctz": 1,
  "tipoDocRec": 80, "nroDocRec": 55000004293,
  "tipoCodAut": "E", "codAut": 75316312117383 }
```

Cuatro conclusiones, todas accionables:

1. **El CUIT País viaja en el QR como `tipoDocRec: 80`** (o sea: DocTipo CUIT)
   con el número del CUIT País en `nroDocRec`. No hay tipo de documento
   especial. `urlQrArca()` **no necesita cambios**: alcanza con alimentarlo con
   `docTipoRec: 80` y `docNroRec: <cuitPais>`. Un problema menos.
2. **La estructura del payload es idéntica a la de la Factura C** — mismas 13
   claves, mismo orden. `urlQrArca()` sirve tal cual para el tipo 19.
3. **`moneda: "PES"` con `ctz: 1` en una Factura E es legítimo** y así lo
   refleja el QR. No cierra R1 (este comprobante salió de RCEL, no de WSFEX),
   pero baja bastante la sospecha de que PES sea un problema conceptual: el
   problema, si existe, sería del WS, no del régimen.
4. **El host del QR es `arca.gob.ar`, no `afip.gob.ar`.** ARCA hoy emite
   `https://www.arca.gob.ar/fe/qr/?p=…`; `domain.ts` genera
   `https://www.afip.gob.ar/fe/qr/?p=…`. **No es un bug**: verifiqué que los
   dos hosts responden y sirven el mismo verificador. Queda como ítem
   cosmético del flujo de Factura C, ajeno a este plan.

---

## 6. Estado

- ✅ Resuelto: **WSFEX**, no WSFEv1 — tipo 19 confirmado en su propia tabla.
- ✅ Hecho: trámite 3.1 (`wsfex` autorizado en homologación para el DN
  `facturador2`, 06-ago-2026).
- ✅ **Cerrados los 11 riesgos** con emisiones reales en homologación.
- ✅ **Implementado y verificado contra ARCA** (paso 4.7.1):
  - `src/core/domain.ts` — tipos 19/20/21, `esExportacion()`, `TipoExpo`,
    `Idioma`, unidades de medida, `ReceptorExterior`, `esCuitPais()` /
    `parsearCuitPais()`, `validarFechaExpo()`, nombres de archivo.
  - `src/core/wsfex.ts` — nuevo. `armarCmpExpo()` puro + `FEXGetLast_CMP`,
    `FEXGetLast_ID`, `FEXGetPARAM_Ctz`, `FEXAuthorize`, `emitirExportacion()`.
  - `src/core/wsaa.ts` — se exportó `escaparXml` (WSFEX manda texto libre del
    usuario; WSFEv1 solo mandaba números y nunca lo necesitó).
  - Tests: 120 en verde (`test/wsfex.test.ts` nuevo + `domain.test.ts`).
- ✅ **Implementadas las capas 4.3–4.6**:
  - `config.ts` — `Emisor.puntoVentaExportacion` y `Template.exterior`
    (`DatosExportacion`), con validación legible de lo que se edita a mano.
  - `store.ts` — `cuitPais`, `clienteExterior`, `paisDestino`, `tipoExpo`,
    `formaPago`, `fechaPago`, `idRequest`. La E suma al tope de monotributo y
    la NC E (21) resta, igual que la 13.
  - `pdf.ts` — layout E completo: letra E / COD. 19, copias
    ORIGINAL/DUPLICADO/**COPIA**, leyenda «IVA EXENTO OPERACIÓN DE
    EXPORTACIÓN», bloque de receptor con CUIT País, bloques de Divisa /
    Destino y Forma de Pago / Fecha de Pago / Incoterms, tabla de 5 columnas
    con 6 decimales, y el QR con el CUIT País como DocTipo 80.
  - `commands/facturar.ts` — rama de exportación completa (preview propio,
    ticket de `wsfex`, emisión, log, PDF), disparada por el template.
  - `commands/template.ts` — wizard de cliente del exterior que trae las
    tablas de países y CUIT País de ARCA y hace elegir de la lista.
- ✅ **Verificado de punta a punta**: `facturar 3000 proxify` emitió la
  `00001-00000006` en homologación (CAE `76326015909456`), con PDF y log.
- ✅ 138 tests en verde, `tsc` limpio, flujo de Factura C intacto.
- 🔴 **Bloqueado por trámite tuyo**: la primera E real necesita 3.2
  (autorizar `wsfex` en producción) y 3.3 (alta del PV de exportación, que en
  homologación no hizo falta porque ese entorno no valida el PV).

Scripts de verificación (solo lectura, reutilizables) en el scratchpad de la
sesión: `verificar-factura-e.ts` (WSFEv1) y `verificar-wsfex.ts` (WSFEX).
El segundo ya trae todas las consultas de R1–R6: apenas autorices `wsfex`,
una corrida cierra media tabla de riesgos.
