Quiero un PLAN de implementación (todavía NO implementes código) para agregar
soporte de Factura E (comprobantes de exportación) a mi CLI de facturación.

## Contexto del proyecto

Repo principal: /Users/ann0nip_mac_mini/Documents/ann0nip/facturador-arca-cli
Leé su CLAUDE.md primero — tiene la arquitectura, las decisiones cerradas y
las reglas de dominio de WSFE que hay que respetar.

Repo hermano (Python, mismo dominio, referencia de reglas ARCA):
/Users/ann0nip_mac_mini/Documents/ann0nip/facturador-ARCA/NOTAS-ARCA.md
Ese archivo documenta trampas del web service verificadas contra el WS real
(no contra la documentación oficial). Su CLAUDE.md aclara que ese bot excluye
Factura E "por decisión de scope, no por pendiente" — o sea, ese repo no te
sirve de referencia de implementación para esto, solo de contexto.

PDF de referencia real (comprobante que YO ya emití, pero por el portal web
de ARCA, no por este CLI): /Users/ann0nip_mac_mini/Downloads/20372114356_019_00004_00000029.pdf
Es una Factura E real: cliente "Proxify" (Suecia), identificado por CUIT País
55000004293, servicios profesionales, en pesos, forma de pago "Criptomonedas".
Usalo como referencia de qué campos debe imprimir el PDF y qué datos necesita
el receptor — pero OJO, fue generado por el sistema "Comprobantes en Línea"
de ARCA (copias ORIGINAL/DUPLICADO/COPIA), no por WSFEv1 directo como hace
este CLI (que genera ORIGINAL/DUPLICADO/TRIPLICADO) — no asumas que el layout
tiene que ser idéntico, solo que los DATOS que aparecen ahí son los que hacen
falta capturar.

## Caso de uso real que motiva esto

Quiero poder hacer algo como `facturar 3000 proxify --moneda DOL` (o como
termine quedando el comando) para facturarle a un cliente en el exterior sin
CUIT argentino, en vez de tener que usar el portal web de ARCA a mano.

## Aclaración importante sobre moneda (no asumir divisa extranjera)

Aunque el cliente es del exterior, la factura queda en **Pesos Argentinos**
(`MonId=PES`), NO en USD. El flujo real de cobro es: el cliente paga en
criptomonedas → se convierten a pesos vía Wallbit → llega como transferencia
en pesos al banco argentino (nunca entra divisa extranjera directo a la
cuenta local). Según el criterio del contador del usuario, mientras el
ingreso llegue como pesos (no como divisa extranjera directa), no se activa
la obligación de presentar la Factura E + documentación al banco dentro de
los 20 días hábiles — esa obligación aplica solo cuando ingresan dólares
directo. La Factura E se emite igual porque documenta ante ARCA que es una
exportación de servicios, justifica el origen de los pesos, y cuenta para el
tope de facturación de la categoría de monotributo.

Consecuencia para el plan: NO asumas que hace falta reutilizar/extender la
maquinaria de moneda extranjera y cotización que el CLI ya tiene para
Factura C en USD (`MonCotiz`, `CanMisMonExt` en `wsfe.ts`) — para el caso de
uso real que motiva esto, `MonId` es PES y no hay conversión de por medio.
Lo que SÍ hay que modelar en serio es el campo "Forma de Pago" / medio de
pago (ej. "Criptomonedas") como dato real del comprobante, no decorativo del
PDF nomás — no lo trates como el `condicionVenta` actual de Factura C, que
"el WSFE no lo recibe, es solo del PDF" (así lo aclara el CLAUDE.md): puede
que acá SÍ importe, hay que verificarlo. No des por sentado que TODAS las
Facturas E futuras van a ser en pesos (el usuario podría facturarle en USD a
otro cliente el día de mañana) — pero el caso base que hay que soportar
primero es en pesos.

## Gaps ya identificados (verificar que sigan así, el código puede haber cambiado)

Comparé el PDF de referencia contra el código actual y hasta ahora esto es lo
que falta, capa por capa — validalo vos mismo leyendo el código actual, no lo
des por hecho:

- `src/core/domain.ts`: no existe `FACTURA_E` (código 19); `CONDICIONES_IVA`
  solo tiene los 5 códigos válidos para clase C (falta el 9 = Cliente del
  Exterior); no hay tipo de documento para "CUIT País"; `parsearDoc()`
  trataría un CUIT País de 11 dígitos como CUIT normal y lo RECHAZARÍA por
  dígito verificador inválido (bug si no se distingue).
- `src/config.ts` (`Template`): el `Receptor` es solo
  `{docTipo, docNro, condIva}` — no hay lugar para país destino, incoterms,
  forma de pago no monetaria.
- `src/core/wsfe.ts`: `armarFecaeDet` siempre manda `ImpNeto = total` e
  `ImpOpEx = "0"` (correcto para Factura C). Para una operación exenta de
  exportación sospecho que el total va en `ImpOpEx` con `ImpNeto = 0`, pero
  NO está verificado contra el WS real — hay que confirmarlo en homologación,
  no copiarlo de un manual. Tampoco hay soporte para `Idioma_Cbte`,
  `Incoterms`, ni el bloque `Opcionales` que puede exigir WSFE para
  exportación — investigar cuáles son realmente obligatorios.
- `src/core/pdf.ts`: `TIPOS_CBTE` solo mapea 11 y 13; falta el layout con
  CUIT País, Destino del Comprobante, Forma de Pago, Incoterms.

## LA pregunta que hay que responder ANTES de plantear el plan de código

ARCA tiene dos web services de exportación distintos:
1. **WSFEv1** — el mismo que ya usa este CLI para Factura C, vía
   `FECAESolicitar`, solo cambiando `CbteTipo` a 19. Habilitado (creo) para
   exportación de SERVICIOS bajo un régimen simplificado.
2. **WSFEX** — servicio SOAP totalmente aparte, pensado para exportadores de
   BIENES con datos aduaneros (permisos de embarque).

Si es WSFEv1: no hace falta ningún trámite nuevo en ARCA, el certificado ya
autorizado para `wsfe` alcanza. Si hiciera falta WSFEX: hay que autorizar ese
servicio aparte en el portal de ARCA (Administrador de Relaciones de Clave
Fiscal) — un trámite manual mío, no algo que resuelva el código solo.

Para resolverlo con evidencia (no con documentación, siguiendo la convención
de este proyecto de verificar todo contra el WS real): hay que autenticarse
con el ticket WSAA que ya usa este CLI para `wsfe` (ver `src/core/wsaa.ts`) y
llamar a `FEParamGetTiposCbte` — si el código 19 aparece en la lista
habilitada para mi CUIT vía ese mismo ticket, es WSFEv1 y no hace falta
trámite. Si no aparece, es señal de que hace falta WSFEX u otra autorización.
Esta llamada es de solo lectura, sin riesgo — podés armar un script de
prueba puntual (no hace falta que sea parte del CLI final) para correrla
contra homologación y, si el usuario lo autoriza, contra producción.

## Qué quiero como entregable

1. El resultado de esa verificación (WSFEv1 vs WSFEX), con evidencia.
2. Un plan de implementación (archivos a tocar, campos nuevos, estructura de
   datos del Template/Receptor extendido, orden de los cambios) — SIN
   implementar todavía.
3. Los riesgos o supuestos que quedan sin verificar (ej: reglas de ImpOpEx,
   campos Opcionales, si "Forma de Pago" viaja al WSFE o es solo del PDF) y
   cómo pensás validarlos antes de dar el código por bueno (recordá: este
   proyecto no confía en manuales, confía en homologación real).
4. Si detectás que además hace falta algún trámite/config de mi lado en ARCA
   (más allá del código), decilo explícito y aparte del plan de código.

## Convenciones a respetar (ya están en el CLAUDE.md del repo, pero remarco)

- Español rioplatense en todo lo de cara al usuario.
- `core/` sin UI (nada de argv/prompts ahí), `commands/` solo conversa.
- Fechas como enteros `aaaammdd`, nunca `Date` con timezone del host.
- Homologación por default, producción solo explícita.
- No romper el flujo de Factura C existente: esto se agrega, no se reemplaza.
