<h1 align="center">Openship</h1>

<p align="center">
  Plateforme de déploiement open source et auto-hébergeable avec CI/CD intégré.<br>
  Poussez votre code, déployez des conteneurs, gérez votre infrastructure — depuis une app de bureau, un tableau de bord web ou la CLI.
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
  <a href="README.fr.md"><img src="https://img.shields.io/badge/lang-Français-0b7285" alt="Français" /></a>
  <a href="README.ja.md"><img src="https://img.shields.io/badge/lang-日本語-555" alt="日本語" /></a>
  <a href="README.pt.md"><img src="https://img.shields.io/badge/lang-Português-555" alt="Português" /></a>
  <a href="README.de.md"><img src="https://img.shields.io/badge/lang-Deutsch-555" alt="Deutsch" /></a>
  <a href="README.tr.md"><img src="https://img.shields.io/badge/lang-Türkçe-555" alt="Türkçe" /></a>
</p>

<p align="center">
  <img src="../screenshots/screen.png" alt="Openship dashboard" width="800" />
</p>

---

## Démarrage rapide

```bash
npm i -g openship
openship init
```

C'est tout. Ou, si vous préférez Docker :

```bash
git clone https://github.com/oblien/openship.git && cd openship
cp .env.example .env
docker compose up -d
```

Ou téléchargez l'app de bureau depuis [openship.io](https://openship.io).

---

## Ce qu'il fait

Pointez-le vers un dépôt. Openship détecte votre stack, la compile, configure tout et la déploie — aucun fichier de config, aucun pipeline, aucun YAML.

Bases de données, domaines, SSL, CDN, e-mail, sauvegardes — tout est géré au même endroit.

Fonctionne avec **Openship Cloud** (managé) ou **n'importe quel serveur Linux** que vous possédez. Les développeurs solo qui publient des projets perso et les équipes en production utilisent le même outil.

---

## Fonctionnalités

| | |
|---|---|
| **CI/CD intégré** | Déploiement au push, environnements de préversion, flux staging/prod, rollbacks |
| **N'importe quelle stack** | Node, Python, Go, Rust, PHP, Ruby, Java, .NET, Docker, monorepos |
| **Backend complet** | Postgres, MySQL, MongoDB, Redis, workers, WebSockets, stockage |
| **Domaines et SSL** | Let's Encrypt automatique, jokers, domaines illimités, renouvellement automatique |
| **CDN** | Cache en périphérie, HTTP/3, compression Brotli, purge instantanée |
| **Serveur mail** | SMTP intégré avec DKIM/SPF/DMARC — sans Mailgun ni SES |
| **Sauvegardes** | Planifiées, bases de données + volumes, restauration en un clic, export à tout moment |
| **Surveillance en temps réel** | Journaux de build en direct, métriques des conteneurs et utilisation des ressources diffusés sur votre écran |
| **Mise à l'échelle** | Autoscaling dans le cloud, prêt pour le multi-nœud en auto-hébergé |
| **Portabilité** | Conteneurs Docker standard — déplacez-vous librement entre fournisseurs |
| **Docker Compose** | Déployez vos fichiers compose existants tels quels |

---

## Déployez n'importe où

- **Openship Cloud** — managé, autoscaling, zéro configuration
- **N'importe quel VPS** — Hetzner, DigitalOcean, Linode, OVH, etc.
- **Serveurs dédiés** — bare metal, colocation, homelab
- **Multi-serveur** — répartissez les charges entre plusieurs machines

La même interface, quel que soit l'endroit où vous déployez.

---

## Trois interfaces

- **App de bureau** — GUI complète, journaux en temps réel, tout en un clic.
- **Tableau de bord web** — la même interface dans le navigateur, pensée pour les équipes.
- **CLI** — scriptable et compatible CI.

Une **API REST** et **MCP** (protocole pour agents IA) complètent l'ensemble pour l'automatisation et l'intégration d'outils. Référence complète des commandes et de l'API sur [openship.io/docs](https://openship.io/docs).

> [!NOTE]
> La documentation est encore en cours de rédaction — nous la complétons activement. Si quelque chose manque ou n'est pas clair, les [contributions](../../CONTRIBUTING.md) sont les bienvenues et nous aident à avancer plus vite.

---

## État

Cœur prêt pour la production, en développement actif.

**Prochainement :** clusters multi-nœuds, interface d'équilibrage de charge, réseau privé, surveillance avancée et pipelines CI/CD visuels.

---

## Contribuer

Voir [CONTRIBUTING.md](../../CONTRIBUTING.md).

---

## Licence

Openship est un logiciel **open source**, sous [licence Apache 2.0](../../LICENSE).

Vous pouvez l'utiliser, l'exécuter, le modifier, l'auto-héberger et le distribuer — y compris dans des produits commerciaux et propriétaires — selon les termes de la licence Apache 2.0. Voir [LICENSE](../../LICENSE) pour le texte complet.
