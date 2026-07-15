# Setup en ARCA — certificado y permisos, paso a paso

> **Objetivo:** dejar tu CUIT habilitado para emitir Factura C por web
> service, **sin darle tu clave fiscal a nadie**. Es un trámite de una sola
> vez por entorno.
>
> ⚠️ ARCA cambia los nombres de menús seguido: tratá cada nombre como
> orientativo. El flujo general no cambia.

Hay dos "mundos" separados, cada uno con su propio certificado:

| | 🧪 Práctica (homologación) | 🔴 Producción |
|---|---|---|
| ¿Las facturas valen? | No — son de mentira | Sí — son reales |
| Certificado | app **WSASS** | app **Administrador de Certificados Digitales** |
| Autorizar el servicio | dentro de WSASS | app **Administrador de Relaciones** → "Nueva Relación" |
| Punto de venta | cualquiera (ej: 1) | uno REAL tipo "Web Service" |

Empezá siempre por práctica. `facturar init` arranca en ese modo.

---

## Paso 0 — La clave y el pedido (los hace el programa)

```bash
facturar init
```

Elegí **"Generar ahora la clave privada y el pedido (CSR)"**. Te deja:

- `privada.key` → tu clave. **No se comparte NUNCA.** Hacele backup.
- `pedido.csr` → el "formulario" que le vas a dar a ARCA para que te emita
  el certificado. Se puede compartir tranquilamente.

*(Sin OpenSSL, sin comandos raros: funciona igual en Windows/Mac/Linux.)*

---

## 🧪 Parte A — Modo práctica (WSASS)

**1.** Copiá el pedido al portapapeles:

```bash
# macOS
cat ~/.config/facturador/keys/pedido.csr | pbcopy
# Linux:   ... | xclip -sel clip      # Windows (PowerShell): Get-Content ... | Set-Clipboard
```

**2.** Entrá a WSASS con tu clave fiscal:
**https://wsass-homo.afip.gob.ar/wsass/portal/main.aspx**
*(si no te deja entrar, adherí antes el servicio "WSASS" desde el portal de
ARCA con el botón "Adherir Servicio")*

**3.** **"Nuevo Certificado"**:
- *Nombre simbólico del DN*: un alias para reconocerlo (ej: `facturador`).
  Es solo una etiqueta.
- Pegá el contenido completo del `pedido.csr` (con las líneas
  `-----BEGIN...` y `-----END...`).

**4.** WSASS te muestra el certificado (`-----BEGIN CERTIFICATE-----…`).
Copialo ENTERO y guardalo **exactamente** en la ruta que te dijo el wizard:

```bash
# macOS
pbpaste > ~/.config/facturador/keys/certificado.crt
```

> El archivo `certificado.crt` **lo creás vos** con este paso — no existe
> hasta que lo guardes. Y ojo: apuntá al `.crt`, no al `.csr` (el programa
> te avisa si te confundís).

**5.** En WSASS: **"Crear autorización a servicio"** → elegí el DN que
creaste → servicio **`wsfe`** → autorizar.

**6.** ¡A probar!

```bash
facturar 1000 --si
```

Si sale el CAE: listo, el circuito funciona. 🎉

### Trampas conocidas del mundo de práctica

- **El padrón de práctica no conoce CUITs reales** (error 10015): para
  probar con receptor identificado usá el CUIT de testing `20-40937847-2`.
- **No podés facturarte a vos mismo** (error 10069) — regla de ARCA.
- El **último comprobante** arranca en 0: tu primera factura de práctica es
  la N° 1.

---

## 🔴 Parte B — Producción (cuando ya validaste todo)

**1. Certificado real** — portal de ARCA (clave fiscal nivel 3) →
**"Administrador de Certificados Digitales"** → *Agregar alias* → subí tu
`pedido.csr` (podés reusar el mismo) → descargá el `.crt`. Guardalo por ej.
como `~/.config/facturador/keys/certificado-produccion.crt`.

**2. Autorizar el servicio** — **"Administrador de Relaciones con Clave
Fiscal"** → botón **"Nueva Relación"** *(ojo: NO "Adherir Servicio" — ese es
para otra cosa)* → Servicio → ARCA → WebServices → **Facturación
Electrónica** → como *representante* elegí tu certificado (el alias).

**3. Punto de venta Web Service** — **"Administración de Puntos de Venta y
Domicilios"** → Alta → sistema: **"Factura Electrónica - Monotributo - Web
Services"**. Anotá el número. *(No sirve reusar el PV de "Comprobantes en
Línea": cada sistema tiene su propia numeración.)*

**4. Cambiá el config** (`~/.config/facturador/config.json`):

```json
{
  "produccion": true,
  "puntoVenta": <el PV nuevo>,
  "certPath": ".../keys/certificado-produccion.crt"
}
```

**5. Primera factura real chica** para validar todo:

```bash
facturar 1000
```

*(sin `--si`: mirá bien el preview — ahora el cartel es rojo y la factura
es REAL).*

---

## Verificaciones útiles

```bash
# ¿El certificado y la clave son pareja?
openssl x509 -in certificado.crt -noout -modulus | openssl md5
openssl rsa  -in privada.key     -noout -modulus | openssl md5
# → los dos hashes tienen que ser IGUALES

# ¿Qué certificado tengo? (emisor "Computadores Test" = práctica)
openssl x509 -in certificado.crt -noout -subject -issuer -dates
```

- Los certificados duran **2 años**. Cuando venza, mismo trámite con un CSR
  nuevo.
- Si al autenticar ves *"El CEE ya posee un TA valido"*: ya hay un ticket
  vigente — el programa los cachea y reusa solo; ese error solo aparece si
  borraste el cache a mano. Esperá o restaurá el archivo.
