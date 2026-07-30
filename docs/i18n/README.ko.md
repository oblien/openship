<h1 align="center">Openship</h1>

<p align="center">
  내장 CI/CD를 갖춘 오픈 소스 자체 호스팅 배포 플랫폼입니다.<br>
  저장소를 연결하면 앱을 빌드하고, 배포하고, 라우팅과 TLS 종료까지 처리합니다. 데스크톱 앱, 웹 대시보드, CLI에서 모두 제어할 수 있습니다.
</p>

<p align="center">
  <a href="https://trendshift.io/repositories/38817?utm_source=repository-badge&utm_medium=badge&utm_campaign=badge-repository-38817">
    <img src="https://trendshift.io/api/badge/repositories/38817" alt="Trendshift" width="250" height="55" />
  </a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/openship"><img src="https://img.shields.io/npm/v/openship?color=0b7285&label=npm" alt="npm 버전" /></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="라이선스" /></a>
  <a href="https://openship.io"><img src="https://img.shields.io/badge/website-openship.io-0b7285" alt="웹사이트" /></a>
</p>

<p align="center">
  <a href="#빠른-시작">빠른 시작</a> ·
  <a href="#작동-방식">작동 방식</a> ·
  <a href="#인터페이스">인터페이스</a> ·
  <a href="https://openship.io/docs">문서</a> ·
  <a href="../../CONTRIBUTING.md">기여하기</a>
</p>

<p align="center">
  <a href="../../README.md"><img src="https://img.shields.io/badge/lang-English-555" alt="English" /></a>
  <a href="README.ar.md"><img src="https://img.shields.io/badge/lang-العربية-555" alt="العربية" /></a>
  <a href="README.zh.md"><img src="https://img.shields.io/badge/lang-简体中文-555" alt="简体中文" /></a>
  <a href="README.es.md"><img src="https://img.shields.io/badge/lang-Español-555" alt="Español" /></a>
  <a href="README.fr.md"><img src="https://img.shields.io/badge/lang-Français-555" alt="Français" /></a>
  <a href="README.ja.md"><img src="https://img.shields.io/badge/lang-日本語-555" alt="日本語" /></a>
  <a href="README.pt.md"><img src="https://img.shields.io/badge/lang-Português-555" alt="Português" /></a>
  <a href="README.de.md"><img src="https://img.shields.io/badge/lang-Deutsch-555" alt="Deutsch" /></a>
  <a href="README.tr.md"><img src="https://img.shields.io/badge/lang-Türkçe-555" alt="Türkçe" /></a>
  <a href="README.ko.md"><img src="https://img.shields.io/badge/lang-한국어-0b7285" alt="한국어" /></a>
</p>

<p align="center">
  <img src="../screenshots/screen.png" alt="Openship 대시보드" width="800" />
</p>

---

## 빠른 시작

먼저 Openship 자체, 즉 control plane을 어떻게 실행할지만 결정하면 됩니다. 이후 과정은 같습니다.

| 이런 경우                                                                     | Openship 실행 방식                   | 앱 실행 위치                                              |
| ----------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------- |
| **개인 개발자, 한 대의 컴퓨터, 운영 부담 없음**                               | **데스크톱 앱**                      | SSH로 연결한 서버 또는 Openship Cloud                     |
| **팀 환경, push-to-deploy가 필요하거나 자체 서버에서 앱을 호스팅하려는 경우** | **자체 호스팅 서버** (`openship up`) | 해당 서버(Compose mode) 또는 다른 서버 / Cloud(bare mode) |
| **아무것도 직접 운영하고 싶지 않은 경우**                                     | **Openship Cloud**                   | 관리형 sandbox, 설정 불필요                               |

> [!TIP]
> **개인 개발자라면 데스크톱 앱을 사용하세요.** 앱을 열어 둔 동안에만 내 컴퓨터에서 Openship control plane이 실행됩니다. 상시 실행 서버에 남는 구성 요소도, 외부에 공개되는 부분도 없습니다. **push-to-deploy(CI/CD)**, **팀 접근**, 또는 **그 서버에서 앱 호스팅**처럼 공개된 상시 실행 endpoint가 필요한 기능을 원할 때만 상시 실행 서버 설치가 필요합니다.

### 개인 개발자 — 데스크톱 앱

control plane은 로컬에서 실행되고 SSH를 통해 서버를 제어합니다. 로그인이나 터미널 없이 내려받아 열기만 하면 되며 외부에 공개되지 않습니다.

| 플랫폼                    | 다운로드                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **macOS** (Apple Silicon) | [Openship-arm64.dmg](https://github.com/oblien/openship/releases/latest/download/Openship-arm64.dmg)         |
| **macOS** (Intel)         | [Openship-x64.dmg](https://github.com/oblien/openship/releases/latest/download/Openship-x64.dmg)             |
| **Windows**               | [Openship-win32-x64.zip](https://github.com/oblien/openship/releases/latest/download/Openship-win32-x64.zip) |
| **Linux**                 | [Openship.AppImage](https://github.com/oblien/openship/releases/latest/download/Openship.AppImage)           |

Linux에서는 `chmod +x Openship.AppImage && ./Openship.AppImage`를 실행합니다. CLI가 이미 있다면 `openship install`로 앱을 내려받아 실행할 수 있습니다. 링크는 항상 최신 릴리스를 가리킵니다.

데스크톱 앱에서 서버(SSH) 또는 Openship Cloud에 연결해 배포합니다. 앱이 노트북에서 공개 앱을 호스팅하지는 않습니다.

### 팀 환경 / 상시 실행 — 자체 호스팅 서버

API와 대시보드를 포함한 CLI를 설치한 뒤 **`openship`**을 실행하세요. 대화형 마법사가 첫 관리자를 만들고 도메인을 연결한 뒤 Openship을 부팅 서비스로 설치합니다. 인스턴스를 관리하려면 언제든 같은 명령을 다시 실행하면 됩니다.

```bash
curl -fsSL https://get.openship.io | sh          # 설치 (또는 npm i -g openship)
openship                                          # 안내에 따른 설정 후 제어 패널 열기
```

CI 환경이나 headless 서버에서는 마법사를 건너뛰고 `openship up`을 직접 실행할 수 있습니다.

```bash
openship up                                       # 설치 후 백그라운드 서비스 시작(부팅 시 시작 및 자동 재시작)
openship up --public-url https://openship.example.com   # 도메인에서 대시보드 제공(edge + TLS 처리)
```

**`openship up`은 실행 방식을 자동으로 선택합니다.**

- **Docker가 있는 Linux에서는 Compose mode**가 기본입니다. 공개 이미지로 Postgres, Redis, API, 대시보드, 컨테이너화된 **OpenResty edge(:80/:443)**를 포함한 전체 스택을 시작합니다. 배포한 앱을 **같은 서버에서 호스팅**하고 자동 도메인과 Let's Encrypt TLS를 제공하는 방식입니다. `--compose`로 강제할 수 있습니다.
- **그 밖의 환경에서는 bare mode**를 사용합니다. macOS, Windows, Docker가 없는 Linux에서 내장 데이터베이스를 포함한 가벼운 단일 프로세스를 실행합니다. 데스크톱 앱처럼 서버(SSH) 또는 Cloud에 앱을 배포하지만, control plane은 상시 실행되며 로그인해야 합니다. `--bare`로 강제할 수 있습니다.

자체 호스팅 인스턴스는 설정 과정에서 만든 관리자로 **반드시 로그인**해야 합니다. `openship open`은 대시보드를 열고, `openship stop`은 중지하며, `openship update`는 업그레이드합니다. `openship up --foreground`는 연결된 상태로 실행합니다.

> **미공개 개발 빌드 미리 보기.** 다음 릴리스 전의 `main`, 브랜치, 태그에 있는 소스에서 직접 빌드한 CLI를 사용하려면 source build를 설치하세요.
>
> ```bash
> curl -fsSL https://get.openship.io/dev | sh                  # main (기본값)
> curl -fsSL https://get.openship.io/dev | OPENSHIP_REF=dev sh  # 브랜치/태그(var는 curl이 아닌 sh에 지정)
> openship-dev                                     # 같은 CLI, 소스에서 빌드
> openship-dev update                              # 최신 소스 가져오기 + 다시 빌드(릴리스 불필요)
> ```
>
> 이 방식은 별도 `openship-dev` 명령, 독립된 홈 디렉터리(`~/.openship-dev`), 부팅 서비스를 사용합니다. 따라서 운영용 `openship`과 데이터에는 영향이 없습니다. Bun과 git이 필요하며, 대시보드 컴파일에는 충분한 RAM/CPU가 필요한 검증되지 않은 개발 빌드이므로 운영 환경에는 적합하지 않습니다.

**프로젝트 배포:**

```bash
cd your-project
openship init            # 이 디렉터리를 프로젝트에 연결
openship deploy
```

완전한 서버 가이드와 CLI 레퍼런스는 **[openship.io/docs](https://openship.io/docs)**에서 확인할 수 있습니다.

<details>
<summary>원시 Docker Compose로 자체 호스팅하기(CLI 없이)</summary>

자체 호스팅 스택은 **`docker/docker-compose.yml`**에 있으며 GitHub Container Registry(`ghcr.io/oblien/*`)의 공개 이미지를 **pull**합니다. 모노레포를 컴파일하거나 빌드 도구를 설치할 필요가 없습니다. 저장소 루트에서 실행하세요.

```bash
git clone https://github.com/oblien/openship.git && cd openship
cp .env.example .env          # 이후 편집
docker compose --env-file .env -f docker/docker-compose.yml up -d
```

스택은 **postgres + redis + api + dashboard + edge**로 구성됩니다. `edge`는 컨테이너로 실행되는 :80/:443의 OpenResty(`network_mode: host`)입니다. 라우팅과 Let's Encrypt를 담당하므로 별도의 bare host 설치가 필요 없습니다. host networking을 사용하므로 **Linux에서만** 지원됩니다. macOS/Windows에서는 `openship up`(bare)을 사용하세요. `api` 컨테이너는 host Docker socket을 마운트해 control plane이 host container를 빌드하고 실행할 수 있습니다. socket을 통해 host 권한을 가지므로 신뢰할 수 있는 서버에서만 실행해야 합니다.

**업그레이드:** 재현 가능한 pull을 위해 `.env`에 `OPENSHIP_VERSION`을 고정한 뒤 `docker compose --env-file .env -f docker/docker-compose.yml pull && … up -d`를 실행하세요. 또는 `openship update`를 사용합니다. 소스에서 빌드하려면 `-f docker/docker-compose.build.yml … up -d --build`를 추가합니다.

> 루트의 **`docker-compose.yml`**은 다른 파일입니다. 소스에서 빌드하고 marketing site를 제공하는 SaaS/control plane용이며 edge나 socket은 없습니다. 앱을 자체 호스팅하지 않으므로, 위의 `docker/docker-compose.yml` 또는 `openship up`을 사용하세요.

</details>

---

## 작동 방식

**GitHub 저장소**, **로컬 폴더**, **미리 빌드한 artifact** 가운데 하나를 Openship에 연결하면 한 pipeline에서 끝까지 처리합니다.

1. **감지.** `package.json`, framework config, lockfile, `docker-compose.yml` / `openship.json`을 읽어 stack, package manager, build/start 명령, port를 결정합니다. 설정 파일은 필요 없으며, 제어가 필요하면 `openship.json`으로 자동 감지 결과를 덮어쓸 수 있습니다.
2. **빌드.** 대상 서버나 orchestrator 로컬에서 Docker image나 bare release를 만듭니다. 해석된 config는 snapshot으로 고정되므로 재배포와 롤백도 배포 당시의 설정을 **정확히** 다시 실행합니다.
3. **실행.** public port가 아닌 loopback에만 공개되는 container 또는 supervisor가 관리하는 host process로 실행합니다.
4. **라우팅과 보안.** OpenResty edge가 도메인용 reverse-proxy vhost를 작성하고 Let's Encrypt certificate(HTTP-01)를 발급합니다. 라우팅과 TLS는 앱이 올라온 뒤에 처리되므로 DNS나 certificate 문제는 “action required”로 표시됩니다. 배포가 실패하거나 앱이 중단되지는 않습니다.
5. **Push-to-deploy.** GitHub webhook이 추적 중인 branch에 push될 때마다 pipeline을 다시 실행합니다. monorepo에서는 실제로 변경된 service만 다시 빌드합니다.

데이터베이스, 도메인, SSL, CDN, 메일, 백업을 한 곳에서 관리합니다. Push-to-deploy와 공개 도메인은 webhook을 받을 공개 endpoint가 필요하므로 상시 실행 서버 또는 Cloud가 필요합니다. 데스크톱/loopback 인스턴스에는 그런 endpoint가 없습니다.

---

## 인터페이스

같은 backend를 제어하는 세 가지 방법이 있습니다.

- **데스크톱 앱** — 완전한 GUI, 실시간 로그, 모든 작업을 한 번의 클릭으로 처리합니다. 개인 개발자에게 적합합니다.
- **웹 대시보드** — 브라우저에서 쓰는 같은 UI이며 팀 환경을 위해 만들었습니다.
- **CLI** — script와 CI 친화적인 인터페이스이며 자체 호스팅 인스턴스를 설치할 때도 사용합니다.

자동화에는 AI agent를 위한 **MCP** endpoint와 **REST API**도 사용할 수 있습니다. MCP tool로 노출하도록 선택한 route만 제공하고 호출할 때마다 permission을 다시 확인합니다. credential/token route는 tool이 될 수 없습니다. 전체 레퍼런스는 [openship.io/docs](https://openship.io/docs)에 있습니다.

> [!NOTE]
> 문서는 계속 보완하고 있습니다. 빠진 내용이나 이해하기 어려운 부분이 있다면 [기여](../../CONTRIBUTING.md)를 환영합니다.

---

## 기능

|                     |                                                                        |
| ------------------- | ---------------------------------------------------------------------- |
| **내장 CI/CD**      | Push-to-deploy, preview environment, staging/production flow, rollback |
| **모든 stack**      | Node, Python, Go, Rust, PHP, Ruby, Java, .NET, Docker, monorepo        |
| **완전한 backend**  | Postgres, MySQL, MongoDB, Redis, worker, WebSocket, storage            |
| **도메인과 SSL**    | 자동 Let's Encrypt, wildcard, 무제한 도메인, 자동 갱신                 |
| **CDN**             | Edge caching, HTTP/3, Brotli compression, 즉시 purge                   |
| **메일 서버**       | DKIM/SPF/DMARC를 갖춘 내장 SMTP, Mailgun이나 SES 불필요                |
| **백업**            | 예약 실행, database + volume, 한 번의 클릭으로 복원, 언제든 export     |
| **실시간 모니터링** | live build log, container metric, 화면으로 스트리밍되는 resource usage |
| **확장성**          | Cloud에서 auto-scaling, 자체 호스팅에서 multi-node 준비                |
| **이식성**          | 표준 Docker container로 provider 사이를 자유롭게 이동                  |
| **Docker Compose**  | 기존 compose file을 그대로 배포                                        |

---

## 어디에나 배포

- **Openship Cloud** — 관리형, auto-scaling, 설정 불필요
- **모든 VPS** — Hetzner, DigitalOcean, Linode, OVH 등
- **전용 서버** — bare metal, colo, homelab
- **다중 서버** — 여러 장비에 workload 분산

어디에 배포하든 같은 인터페이스를 사용합니다.

---

## 상태

핵심 기능은 운영 환경에 사용할 수 있으며, 프로젝트는 활발하게 개발 중입니다. 자체 호스팅은 **무료**이며 billing이 없습니다.

**다음 계획:** multi-node cluster, load-balancing UI, private networking, advanced monitoring, visual CI/CD pipeline.

---

## 기여하기

[CONTRIBUTING.md](../../CONTRIBUTING.md)를 참고하세요.

---

## 보안

취약점을 발견했다면 공개 issue, PR, discussion이 아닌 **비공개** 경로로 제보해 주세요.

- **제보 방법(권장):** [취약점 제보](https://github.com/oblien/openship/security/advisories/new) — 제보자와 maintainer만 볼 수 있는 비공개 GitHub advisory입니다.
- 범위, 포함할 내용, 대응 및 공개 절차는 [SECURITY.md](../../SECURITY.md)에 있습니다.

선의의 보안 연구는 [safe-harbor policy](../../SECURITY.md#safe-harbor)에 따라 허가되며, 유효한 최초 제보자에게 기꺼이 credit을 제공합니다.

## 라이선스

Openship은 [Apache License 2.0](../../LICENSE)로 제공되는 **오픈 소스** 소프트웨어입니다.

Apache License 2.0의 조건에 따라 상용 및 비공개 소스 제품을 포함해 소프트웨어를 사용, 실행, 수정, 자체 호스팅, 배포할 수 있습니다. 자세한 내용은 [LICENSE](../../LICENSE)를 참고하세요.
