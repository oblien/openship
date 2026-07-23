<h1 align="center">Openship</h1>

<p align="center">
  Plataforma de deploy open source e auto-hospedável com CI/CD integrado.<br>
  Faça push do código, publique contêineres e gerencie sua infraestrutura — a partir de um app de desktop, um painel web ou a CLI.
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
  <a href="README.es.md"><img src="https://img.shields.io/badge/lang-Español-555" alt="Español" /></a>
  <a href="README.fr.md"><img src="https://img.shields.io/badge/lang-Français-555" alt="Français" /></a>
  <a href="README.ja.md"><img src="https://img.shields.io/badge/lang-日本語-555" alt="日本語" /></a>
  <a href="README.pt.md"><img src="https://img.shields.io/badge/lang-Português-0b7285" alt="Português" /></a>
  <a href="README.de.md"><img src="https://img.shields.io/badge/lang-Deutsch-555" alt="Deutsch" /></a>
  <a href="README.tr.md"><img src="https://img.shields.io/badge/lang-Türkçe-555" alt="Türkçe" /></a>
</p>

<p align="center">
  <img src="../screenshots/screen.png" alt="Openship dashboard" width="800" />
</p>

---

## Início rápido

```bash
npm i -g openship
openship init
```

É só isso. Ou, se você preferir Docker:

```bash
git clone https://github.com/oblien/openship.git && cd openship
cp .env.example .env
docker compose up -d
```

Ou baixe o app de desktop em [openship.io](https://openship.io).

---

## O que ele faz

Aponte para um repositório. O Openship detecta sua stack, faz o build, configura tudo e publica — sem arquivos de configuração, sem pipelines, sem YAML.

Bancos de dados, domínios, SSL, CDN, e-mail, backups — tudo gerenciado em um só lugar.

Funciona com o **Openship Cloud** (gerenciado) ou **qualquer servidor Linux** que você tenha. Desenvolvedores solo publicando projetos paralelos e times rodando produção usam a mesma ferramenta.

---

## Recursos

| | |
|---|---|
| **CI/CD integrado** | Deploy no push, ambientes de preview, fluxos staging/prod, rollbacks |
| **Qualquer stack** | Node, Python, Go, Rust, PHP, Ruby, Java, .NET, Docker, monorepos |
| **Backend completo** | Postgres, MySQL, MongoDB, Redis, workers, WebSockets, armazenamento |
| **Domínios e SSL** | Let's Encrypt automático, curingas, domínios ilimitados, renovação automática |
| **CDN** | Cache na borda, HTTP/3, compressão Brotli, purge instantâneo |
| **Servidor de e-mail** | SMTP integrado com DKIM/SPF/DMARC — sem precisar de Mailgun ou SES |
| **Backups** | Agendados, bancos de dados + volumes, restauração com um clique, exporte quando quiser |
| **Monitoramento em tempo real** | Logs de build ao vivo, métricas de contêineres e uso de recursos transmitidos para sua tela |
| **Escalabilidade** | Autoescala na nuvem, pronto para multinó no auto-hospedado |
| **Portabilidade** | Contêineres Docker padrão — mova-se livremente entre provedores |
| **Docker Compose** | Faça deploy dos seus arquivos compose existentes como estão |

---

## Faça deploy em qualquer lugar

- **Openship Cloud** — gerenciado, autoescala, configuração zero
- **Qualquer VPS** — Hetzner, DigitalOcean, Linode, OVH e outros
- **Servidores dedicados** — bare metal, colocation, homelab
- **Multiservidor** — distribua as cargas entre máquinas

A mesma interface, não importa onde você faça deploy.

---

## Três interfaces

- **App de desktop** — GUI completa, logs em tempo real, tudo com um clique.
- **Painel web** — a mesma interface no navegador, feita para times.
- **CLI** — scriptável e amigável para CI.

Uma **API REST** e o **MCP** (protocolo para agentes de IA) completam o conjunto para automação e integração com ferramentas. Referência completa de comandos e API em [openship.io/docs](https://openship.io/docs).

> [!NOTE]
> A documentação ainda está em andamento — estamos preenchendo ativamente. Se algo estiver faltando ou pouco claro, [contribuições](../../CONTRIBUTING.md) são muito bem-vindas e nos ajudam a chegar lá mais rápido.

---

## Status

Núcleo pronto para produção, em desenvolvimento ativo.

**Em breve:** clusters multinó, UI de balanceamento de carga, redes privadas, monitoramento avançado e pipelines de CI/CD visuais.

---

## Contribuindo

Veja [CONTRIBUTING.md](../../CONTRIBUTING.md).

---

## Licença

O Openship é software **open source**, licenciado sob a [Licença Apache 2.0](../../LICENSE).

Você pode usar, executar, modificar, auto-hospedar e distribuir — inclusive em produtos comerciais e de código fechado — sob os termos da licença Apache 2.0. Veja [LICENSE](../../LICENSE) para o texto completo.
