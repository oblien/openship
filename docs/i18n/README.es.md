<h1 align="center">Openship</h1>

<p align="center">
  Plataforma de despliegue de código abierto y autoalojable con CI/CD integrado.<br>
  Sube tu código, despliega contenedores y gestiona tu infraestructura — desde una app de escritorio, un panel web o la CLI.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/openship"><img src="https://img.shields.io/npm/v/openship?color=0b7285&label=npm" alt="npm version" /></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License" /></a>
  <a href="https://openship.io"><img src="https://img.shields.io/badge/website-openship.io-0b7285" alt="Website" /></a>
</p>

<p align="center">
  <a href="../../README.md"><img src="https://img.shields.io/badge/lang-English-555" alt="English" /></a>
  <a href="README.ar.md"><img src="https://img.shields.io/badge/lang-العربية-555" alt="العربية" /></a>
  <a href="README.zh.md"><img src="https://img.shields.io/badge/lang-简体中文-555" alt="简体中文" /></a>
  <a href="README.es.md"><img src="https://img.shields.io/badge/lang-Español-0b7285" alt="Español" /></a>
  <a href="README.fr.md"><img src="https://img.shields.io/badge/lang-Français-555" alt="Français" /></a>
  <a href="README.ja.md"><img src="https://img.shields.io/badge/lang-日本語-555" alt="日本語" /></a>
  <a href="README.pt.md"><img src="https://img.shields.io/badge/lang-Português-555" alt="Português" /></a>
  <a href="README.de.md"><img src="https://img.shields.io/badge/lang-Deutsch-555" alt="Deutsch" /></a>
  <a href="README.tr.md"><img src="https://img.shields.io/badge/lang-Türkçe-555" alt="Türkçe" /></a>
</p>

<p align="center">
  <img src="../screenshots/screen.png" alt="Openship dashboard" width="800" />
</p>

---

## Inicio rápido

```bash
npm i -g openship
openship init
```

Eso es todo. O, si prefieres Docker:

```bash
git clone https://github.com/oblien/openship.git && cd openship
cp .env.example .env
docker compose up -d
```

O descarga la app de escritorio desde [openship.io](https://openship.io).

---

## Qué hace

Apúntalo a un repositorio. Openship detecta tu stack, lo compila, lo configura todo y lo despliega — sin archivos de configuración, sin pipelines, sin YAML.

Bases de datos, dominios, SSL, CDN, correo, copias de seguridad — todo gestionado desde un solo lugar.

Funciona con **Openship Cloud** (gestionado) o **cualquier servidor Linux** que tengas. Tanto los desarrolladores en solitario con proyectos personales como los equipos en producción usan la misma herramienta.

---

## Características

| | |
|---|---|
| **CI/CD integrado** | Despliegue con push, entornos de vista previa, flujos staging/prod, reversiones |
| **Cualquier stack** | Node, Python, Go, Rust, PHP, Ruby, Java, .NET, Docker, monorepos |
| **Backend completo** | Postgres, MySQL, MongoDB, Redis, workers, WebSockets, almacenamiento |
| **Dominios y SSL** | Let's Encrypt automático, comodines, dominios ilimitados, renovación automática |
| **CDN** | Caché en el borde, HTTP/3, compresión Brotli, purga instantánea |
| **Servidor de correo** | SMTP integrado con DKIM/SPF/DMARC — sin necesidad de Mailgun ni SES |
| **Copias de seguridad** | Programadas, bases de datos + volúmenes, restauración con un clic, exporta cuando quieras |
| **Monitorización en tiempo real** | Registros de compilación en vivo, métricas de contenedores y uso de recursos transmitidos a tu pantalla |
| **Escalado** | Autoescalado en la nube, listo para multinodo en autoalojado |
| **Portabilidad** | Contenedores Docker estándar — muévete entre proveedores libremente |
| **Docker Compose** | Despliega tus archivos compose existentes tal cual |

---

## Despliega donde sea

- **Openship Cloud** — gestionado, autoescalado, sin configuración
- **Cualquier VPS** — Hetzner, DigitalOcean, Linode, OVH y demás
- **Servidores dedicados** — bare metal, colocation, homelab
- **Multiservidor** — reparte las cargas entre varias máquinas

La misma interfaz sin importar dónde despliegues.

---

## Tres interfaces

- **App de escritorio** — GUI completa, registros en tiempo real, todo con un clic.
- **Panel web** — la misma interfaz en el navegador, pensada para equipos.
- **CLI** — programable y compatible con CI.

Una **API REST** y **MCP** (protocolo para agentes de IA) completan el conjunto para la automatización e integración con herramientas. Referencia completa de comandos y API en [openship.io/docs](https://openship.io/docs).

> [!NOTE]
> La documentación aún está en desarrollo — la estamos completando activamente. Si algo falta o no queda claro, las [contribuciones](../../CONTRIBUTING.md) son muy bienvenidas y nos ayudan a llegar más rápido.

---

## Estado

Núcleo listo para producción, en desarrollo activo.

**Próximamente:** clústeres multinodo, UI de balanceo de carga, redes privadas, monitorización avanzada y pipelines de CI/CD visuales.

---

## Contribuir

Consulta [CONTRIBUTING.md](../../CONTRIBUTING.md).

---

## Licencia

Openship es software de **código abierto**, licenciado bajo la [Licencia Apache 2.0](../../LICENSE).

Puedes usarlo, ejecutarlo, modificarlo, autoalojarlo y distribuirlo — incluso en productos comerciales y de código cerrado — según los términos de la licencia Apache 2.0. Consulta [LICENSE](../../LICENSE) para el texto completo.
