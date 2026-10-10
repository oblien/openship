<h1 align="center">Openship</h1>

<p align="center">
  Платформа развертывания с открытым исходным кодом и возможностью селф-хостинга со встроенным CI/CD.<br>
  Укажите репозиторий — Openship соберет, доставит, настроит маршрутизацию и TLS-терминацию для приложения. Управляйте через десктопное приложение, веб-панель или CLI.
</p>

<p align="center">
  <a href="https://trendshift.io/repositories/38817?utm_source=repository-badge&utm_medium=badge&utm_campaign=badge-repository-38817">
    <img src="https://trendshift.io/api/badge/repositories/38817" alt="Trendshift" width="250" height="55" />
  </a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/openship"><img src="https://img.shields.io/npm/v/openship?color=0b7285&label=npm" alt="npm version" /></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License" /></a>
  <a href="https://openship.io"><img src="https://img.shields.io/badge/website-openship.io-0b7285" alt="Website" /></a>
</p>

<p align="center">
  <a href="#quick-start">Быстрый старт</a> ·
  <a href="#how-it-works">Как это работает</a> ·
  <a href="#interfaces">Интерфейсы</a> ·
  <a href="https://openship.io/docs">Документация</a> ·
  <a href="../../CONTRIBUTING.md">Участие в разработке</a>
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
  <a href="README.ko.md"><img src="https://img.shields.io/badge/lang-한국어-555" alt="한국어" /></a>
  <a href="README.ru.md"><img src="https://img.shields.io/badge/lang-Русский-0b7285" alt="Русский" /></a>
</p>

<p align="center">
  <img src="../screenshots/screen.png" alt="Панель управления Openship" width="800" />
</p>

---

## Quick Start

Сначала нужно принять одно решение: **как запускать сам Openship** (control plane). Всё остальное после этого одинаково.

| Ваша ситуация | Запуск Openship | Где запускаются приложения |
|---|---|---|
| **Один пользователь, один сервер, без администрирования** | **Десктопное приложение** | Сервер, к которому подключаетесь по SSH, или Openship Cloud |
| **Команда — или нужен push-to-deploy / хостинг на своем сервере** | **Self-hosted сервер** (`openship up`) | На том же сервере (режим Compose) или на удаленном сервере / Cloud (режим bare) |
| **Не хотите ничего администрировать** | **Openship Cloud** | Управляемые песочницы, нулевая настройка |

> [!TIP]
> **Один пользователь? Используйте десктопное приложение.** Оно запускает control plane Openship на вашем компьютере *только пока приложение открыто* — ничего не остается запущенным на сервере и не публикуется наружу. Постоянно работающий сервер нужен только если требуется **push-to-deploy (CI/CD)**, **командный доступ** или **хостинг приложений на этом же сервере** — то есть задачи, требующие публичного и всегда доступного эндпоинта.

### Solo — десктопное приложение

Control plane работает локально и управляет вашими серверами по SSH. Без логинов, без терминала, без публичных портов — скачал, открыл, готово:

| Платформа | Скачать |
|---|---|
| **macOS** (Apple Silicon) | [Openship-arm64.dmg](https://github.com/oblien/openship/releases/latest/download/Openship-arm64.dmg) |
| **macOS** (Intel) | [Openship-x64.dmg](https://github.com/oblien/openship/releases/latest/download/Openship-x64.dmg) |
| **Windows** | [Openship-win32-x64.zip](https://github.com/oblien/openship/releases/latest/download/Openship-win32-x64.zip) |
| **Linux** | [Openship.AppImage](https://github.com/oblien/openship/releases/latest/download/Openship.AppImage) |

Linux: `chmod +x Openship.AppImage && ./Openship.AppImage`. У вас уже есть CLI? `openship install` скачает и запустит его. Ссылки всегда ведут на самый свежий релиз.

Из десктопного приложения вы подключаете сервер (SSH) или Openship Cloud и деплоите на него — само приложение не хостит публичные приложения на вашем ноутбуке.

### Команда / всегда онлайн — self-hosted сервер

Установите CLI (содержит API + панель управления) и запустите **`openship`** — интерактивный мастер создаст первого администратора, привяжет домен и установит Openship как системную службу. Запускайте снова в любое время для управления инстансом.

```bash
curl -fsSL https://get.openship.io | sh          # установка (или: npm i -g openship — требуется Node 22+)
openship                                          # пошаговая настройка, затем панель управления
```

Скрипт установки содержит собственную Node.js, если системная версия ниже 22; установка через менеджер пакетов использует существующий узел Node.

Для CI / серверов без GUI пропустите мастер и запустите `openship up` напрямую:

```bash
openship up                                       # установка + запуск в фоновом режиме (автозапуск + автоперезапуск)
openship up --public-url https://openship.example.com   # + запуск панели управления на вашем домене (edge + TLS настроены)
```

**`openship up` автоматически выбирает режим работы:**

- **Linux с Docker → режим Compose** (по умолчанию). Запускает полный стек — Postgres, Redis, API, панель управления и контейнеризованный **OpenResty edge на порту :80/:443** из официальных образов. В этом режиме **приложения хостятся на том же сервере** с автоматической настройкой доменов и SSL-сертификатов Let's Encrypt. Принудительный запуск: `--compose`.
- **Остальные системы → режим bare** (macOS, Windows или Linux без Docker). Один легкий процесс со встроенной базой данных — постоянно работающий control plane, который **деплоит приложения на внешний сервер (SSH) или в Cloud**, аналогично десктопному приложению, но в режиме 24/7 и с обязательной авторизацией. Принудительный запуск: `--bare`.

Self-hosted инстанс **всегда требует авторизации** (аккаунт администратора создается при первичной настройке). `openship open` открывает панель управления · `openship stop` останавливает службу · `openship update` обновляет версию · `openship up --foreground` запускает в интерактивном режиме.

> **Предпросмотр нерелизных сборок (dev).** Чтобы запустить CLI, собранный напрямую из исходников (ветка, тег или `main`), установите dev-сборку:
>
> ```bash
> curl -fsSL https://get.openship.io/dev | sh                  # main (по умолчанию)
> curl -fsSL https://get.openship.io/dev | OPENSHIP_REF=dev sh  # ветка/тег (переменная передается в sh)
> openship-dev                                     # тот же CLI, собранный из исходников
> openship-dev update                              # получить последние исходники + пересобрать
> ```
>
> Она устанавливается как **отдельная команда `openship-dev`** с изолированной рабочей директорией (`~/.openship-dev`) и отдельной службой автозапуска, поэтому боевой `openship` и его данные останутся нетронутыми. Требуются Bun + git; это неверифицированная dev-сборка.

**Деплой проекта:**

```bash
cd your-project
openship init            # привязать директорию к проекту
openship deploy
```

Полное руководство по серверу и справка по CLI: **[openship.io/docs](https://openship.io/docs)**.

<details>
<summary>Автодополнение команд (bash/zsh/fish)</summary>

Два способа включить автодополнение по кнопке Tab для `openship`:

| | Настройка | Особенности |
|---|---|---|
| **Статический файл** (рекомендуется) | `openship completion <shell> > <path>` | Мгновенный запуск оболочки. Обновляйте после выхода новых версий CLI. |
| **Динамический запуск** | добавьте `source <(openship completion <shell>)` в конфиг оболочки | Всегда соответствует текущей версии CLI. Добавляет небольшую задержку при открытии нового терминала. |

**Статический файл:**
```bash
openship completion bash > /etc/bash_completion.d/openship
openship completion zsh  > ~/.zsh/completions/_openship
openship completion fish > ~/.config/fish/completions/openship.fish
```
Откройте новый терминал — готово.

**Динамический запуск** (пример для zsh):
```bash
echo 'source <(openship completion zsh)' >> ~/.zshrc
```

</details>

<details>
<summary>Self-host через чистый Docker Compose (без CLI)</summary>

Self-hosted стек находится в **`docker/docker-compose.yml`** и **скачивает** готовые образы из GitHub Container Registry (`ghcr.io/oblien/*`) — без сборки и компиляции. Запустите из корня репозитория:

```bash
git clone https://github.com/oblien/openship.git && cd openship
cp .env.example .env          # отредактируйте конфиг
docker compose --env-file .env -f docker/docker-compose.yml up -d
```

Стек состоит из **postgres + redis + api + dashboard + edge**. Компонент `edge` — это OpenResty на **:80/:443** в контейнере (`network_mode: host`) для маршрутизации и Let's Encrypt. **Только для Linux** (из-за host networking); на macOS/Windows используйте `openship up` (bare). Контейнер `api` монтирует хостовый сокет Docker для сборки и запуска ваших приложений — запускайте только на доверенном сервере.

**Обновление:** зафиксируйте `OPENSHIP_VERSION` в `.env`, затем `docker compose --env-file .env -f docker/docker-compose.yml pull && … up -d`. Команда `openship update` обслуживает только стек, установленный через CLI. **Сборка из исходников:** добавьте `-f docker/docker-compose.build.yml … up -d --build`.

**Операции на хосте** (перехват портов `:80`/`:443`, почтовый движок, сканирование портов) требуют каналов container→host SSH, которые `openship up` пробрасывает автоматически. Для ручного метода следует выполнить 5 шагов из `.env.example` в разделе *Host operations from the container*. Описание возможных ошибок: [Troubleshooting → Host control channel](https://openship.io/docs/troubleshooting/host-channel).

> Файл `docker-compose.yml` в **корне** репозитория — это другой файл: он предназначен для SaaS / сборки **control plane** из исходников. Он **не** подходит для селф-хостинга ваших приложений — используйте `docker/docker-compose.yml` или `openship up`.

</details>

---

## How It Works

Укажите Openship источник — **репозиторий GitHub**, **локальную папку** или **готовый артефакт** — и он выполнит пайплайн от начала до конца:

1. **Определение.** Сканирует `package.json`, конфиг фреймворка, lock-файлы, `docker-compose.yml` или `openship.json` для определения стека, менеджера пакетов, команд сборки/запуска и портов. Конфигурационные файлы не обязательны; `openship.json` нужен только если хотите переопределить автоматические настройки.
2. **Сборка.** На целевом сервере или локально в Docker-образ или bare-релиз. Итоговый конфиг фиксируется в снапшоте, чтобы повторные деплои и откаты воспроизводились *абсолютно идентично*.
3. **Запуск.** В контейнере (доступном только на loopback-интерфейсе — без открытых наружу портов) или как процесс под управлением супервизора.
4. **Маршрутизация и безопасность.** OpenResty edge создает vhost обратного прокси для вашего доменного имени и получает SSL-сертификат Let's Encrypt (HTTP-01). Так как маршрутизация и TLS настраиваются *после* успешного запуска приложения, проблемы с DNS или сертификатами не приводят к падению приложения или сбою деплоя.
5. **Push-to-deploy.** Вебхук GitHub перезапускает пайплайн при каждом пуше в отслеживаемую ветку — с пересборкой только тех сервисов, которые реально изменились.

Базы данных, домены, SSL, CDN, почта и бэкапы управляются из единого интерфейса.

---

## Interfaces

Три способа управления одним бэкендом:

- **Десктопное приложение** — удобный GUI, логи в реальном времени, всё в один клик. Идеально для одного разработчика.
- **Веб-панель управления** — аналогичный UI в браузере, созданный для командной работы.
- **CLI** — для скриптов и CI/CD; также используется для установки и администрирования self-hosted инстанса.

Для автоматизации доступны **MCP-эндпоинт** (для ИИ-агентов) и **REST API**. В качестве MCP-инструментов экспортируются только явно разрешенные маршруты с полной проверкой прав доступа. Документация доступна на [openship.io/docs](https://openship.io/docs).

> [!NOTE]
> Документация активно дополняется. Если вы нашли неточность или недостающую информацию, мы рады вашим [пул-реквестам](../../CONTRIBUTING.md).

---

## Features

| | |
|---|---|
| **Встроенный CI/CD** | Push-to-deploy, preview-окружения, staging/prod потоки, откаты |
| **Любой стек** | Node, Python, Go, Rust, PHP, Ruby, Java, .NET, Docker, монорепозитории |
| **Полноценный бэкенд** | Postgres, MySQL, MongoDB, Redis, воркеры, WebSockets, S3-хранилище |
| **Домены и SSL** | Автоматический Let's Encrypt, wildcard-домены, неограниченное число доменов, автопродление |
| **CDN** | Кэширование на edge, HTTP/3, Brotli-сжатие, мгновенный сброс кэша |
| **Почтовый сервер** | Встроенный SMTP с DKIM/SPF/DMARC — без необходимости в Mailgun или SES |
| **Резервное копирование** | По расписанию, базы данных + тома, восстановление в один клик, экспорт |
| **Мониторинг в реальном времени** | Логи сборки, метрики контейнеров, география посетителей — [~1.4 мкс на запрос, 0 записей в БД на запрос](../../docs/monitoring.md) |
| **Масштабирование** | Автомасштабирование в cloud, multi-node режим на self-hosted |
| **Переносимость** | Стандартные Docker-контейнеры — свободный перенос между провайдерами |
| **Docker Compose** | Деплой существующих compose-файлов без изменений |

---

## Deploy Anywhere

- **Openship Cloud** — управляемый хостинг, автомасштабирование, нулевая настройка
- **Любой VPS** — Hetzner, DigitalOcean, Linode, OVH и другие
- **Выделенные сервера** — bare metal, colocation, homelab
- **Мульти-серверная инфраструктура** — распределение нагрузки по машинам

Единый интерфейс независимо от места деплоя.

---

## Status

Готово к продакшену, активно развивается. Self-hosting **бесплатен** (без скрытых платежей).

**В ближайших релизах:** multi-node кластеры, UI для балансировки нагрузки, приватные сети, расширенный мониторинг и визуальные CI/CD пайплайны.

---

## Contributing

Подробнее в файле [CONTRIBUTING.md](../../CONTRIBUTING.md).

---

## Security

Нашли уязвимость? Пожалуйста, сообщите нам **конфиденциально** (не создавайте публичные issue или PR).

- **Отправить отчет (предпочтительно):** [Сообщить об уязвимости](https://github.com/oblien/openship/security/advisories/new) — приватный GitHub advisory.
- Область охвата и политика раскрытия: [SECURITY.md](../../SECURITY.md).

---

## License

Openship — это ПО с **открытым исходным кодом** под лицензией [Apache License 2.0](../../LICENSE).
