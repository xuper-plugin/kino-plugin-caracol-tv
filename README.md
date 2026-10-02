# Caracol TV plugin for Kino

Plugin de [Kino](https://github.com/kinotvapp/kino-light) que trae el catálogo de
[Caracol Streaming](https://www.caracoltv.com/) (la plataforma también conocida como
**Ditu**): series, películas y canales en vivo. Es la conversión del módulo nativo de
Caracol que vivía escondido en la app.

> **Solo funciona en Colombia.** Caracol Streaming solo sirve dentro del país. Fuera de
> Colombia el backend de Caracol bloquea cada intento de abrir un video con el mensaje
> "solo disponible en Colombia" (`USERDATA`, el primero de los siete bloqueos que
> chequea el plugin). El plugin lo anuncia de tres formas para que no parezca un bug
> del app:
>
> - la descripción del manifiesto dice "Solo funciona en Colombia" y sale en la hoja
>   de consentimiento al instalar;
> - cada resultado trae la insignia `SOLO COLOMBIA` en su tarjeta;
> - al intentar reproducir un video, Caracol devuelve el mensaje exacto.

## Qué hace

| Capacidad | Cómo |
| --- | --- |
| `search` | Mismo endpoint con el que se carga el Home pero con la `query` llena. Caracol devuelve los títulos que matchean y el plugin los entrega tal cual, sin re-ranking ni filtros locales. Cada resultado lleva la insignia `SOLO COLOMBIA` y el `genre` del vocabulario cerrado del contrato (`series` o `peliculas`). |
| `home` | Dos filas: "Series de Caracol (solo Colombia)" y "Películas de Caracol (solo Colombia)", con hasta 60 títulos cada una (el límite de Kino por fila). El catálogo completo (~330 títulos) se trae en una sola llamada y se cachea en `kino.storage` por 6 horas —el mismo TTL que tenía la versión nativa—. |
| `browse` | "Ver más" sobre las filas del Home: paginación de 60 títulos por página, el número de página como cursor. |
| `episodes` | Capítulos de una serie. Una serie puede ser un `BUNDLE` (una temporada) o un `GROUP_OF_BUNDLES` (varias temporadas); en el segundo caso se pide la lista de hijos y se enumeran las temporadas según la posición del bundle dentro del grupo, no según el `season` que mande Caracol (que suele venir siempre como 1 y haría colisionar las temporadas). |
| `resolve` | Tres pasos: `CONTENT/DETAIL` (saca el `assetId`), `CONTENT/USERDATA` (revisa los siete bloqueos de entitlement que Caracol puede activar) y `CONTENT/VIDEOURL` (entrega la URL del `.mpd` y la cookie `playback_token`). Devuelve un stream DASH con DRM Widevine y la cookie ya inyectada en los headers de licencia. |
| `drm` | Declarativa: el plugin reproduce Widevine. |
| `channels` | Una sola categoría ("Canales en vivo"). El `liveChannels` resuelve cada uno inline (USERDATA + VIDEOURL) para entregar el stream listo, con la cookie ya en los headers de la licencia. |

## Qué no intenta ser

- **No reemplaza la app de Caracol**. Es la versión "ver la tele" de Caracol Streaming, sin autenticación: lo que es gratis para cualquiera en su web y app, lo es aquí también.
- **No descarga series**. La descarga nativa de Caracol funciona guardando los segmentos cifrados de DASH más un `.ditu.json` con la lista de pistas; eso es código del equipo de Kino, no algo que un plugin pueda pedir —la capacidad `download` de los plugins es solo para archivos progresivos como mp4/webm.
- **No descubre `playback_token` en runtime**. La cookie viaja en el `Set-Cookie` que devuelve `CONTENT/VIDEOURL` y se guarda en la cookie jar del plugin; dura algunas horas, lo que dura el TTL de Caracol. Cuando expira, el próximo `resolve` la vuelve a sacar.

## Hosts y por qué hay cuatro declarados

```
middleware.ditu.caracoltv.com   → la API de Caracol (TRAY, CONTENT/…)
image-registry.ditu.caracoltv.com → el CDN de posters y backdrops
image-registry.avscaracoltv.com → el CDN de logos de los canales en vivo
```

Los hosts donde se sirve el video (`.mpd` y segmentos) **no están declarados**: Caracol los elige en tiempo de ejecución (típicamente `mdstrm.com` y dominios de CloudFront), por eso el manifiesto usa `streamHosts: "any"` y `liveStreamHosts: "any"`. Eso es lo que le permite al player abrir el `.mpd` que Caracol devuelve sin tener que declararlo.

Tres cabeceras son obligatorias en cada GET — sin ellas el CDN responde 403 y el error se ve como "el video no existe":

```
restful: yes
Accept: application/json, text/plain, */*
User-Agent: okhttp/4.12.0
```

## Estados de entitlement traducidos

Caracol devuelve hasta siete flags y el plugin los traduce en el mismo orden que la versión
nativa (el primero que esté activo gana, porque es el más informativo):

| Flag | Mensaje |
| --- | --- |
| `isGeoBlocked` | solo disponible en Colombia |
| `isChannelNotSubscribed` | requiere suscripción |
| `isPCBlocked` | control parental activo |
| `isContentOOHBlocked` | contenido OOH bloqueado |
| `isGeofencedBlocked` | geofence bloqueado |
| `isSportBlackoutBlocked` | deportes en blackout |
| `isPlatformBlacklisted` | plataforma no permitida |

## Instalar

En Kino abrir **Ajustes ▸ Plugins** y escribir el repositorio:

```
kinotvapp/kino-light
```

Kino lee `plugins/caracol-tv/kino-plugin.json` y `plugins/caracol-tv/plugin.js`, muestra los hosts
y las capacidades del plugin, y pide confirmación antes de instalar.

## Desarrollar

```bash
node plugins/sdk/validate.mjs plugins/caracol-tv
node plugins/sdk/run.mjs plugins/caracol-tv search "pasión"
node plugins/sdk/run.mjs plugins/caracol-tv home
node plugins/sdk/run.mjs plugins/caracol-tv live channels all
```

Las pruebas offline requieren haber grabado primero `test/fixtures.json`:

```bash
node plugins/sdk/run.mjs --record plugins/caracol-tv/test/fixtures.json plugins/caracol-tv search "pasión"
node --test plugins/caracol-tv/test/plugin.test.mjs
```

## Coexistencia con el módulo nativo

El módulo nativo de Caracol sigue en `app/src/main/java/com/arkiv/player/data/ditu/`,
escondido por `CaracolVisibility.HIDDEN = true` desde la versión 0.9.44. La razón de
mantenerlo: las bibliotecas que las personas guardaron antes de que el plugin existiera
siguen teniendo refs con el prefijo `ditu1:`, y la nativa sigue activa como `ResolveOnlySource`
para resolverlas. El plugin usa el prefijo `cditu1:` para que sea claro cual es la versión
plugin cuando se mira una ref.

Para volver a la versión nativa y quitar el plugin, basta con desinstalarlo en
**Ajustes ▸ Plugins**.

## Licencia

El código de este plugin está licenciado bajo la Apache License 2.0 (ver `LICENSE` en la raíz
de Kino). Lo que se reproduce no es nuestro: Caracol Streaming es un servicio de Caracol
Televisión S.A. y los videos que sirve son los de su catálogo bajo las condiciones que esa
plataforma establece.