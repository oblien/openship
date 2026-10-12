<h1 align="center">Openship</h1>

<p align="center">
  Платформа для розгортання з відкритим кодом і можливістю самостійного хостингу, з вбудованим CI/CD.<br>
  Вкажіть репозиторій — вона збирає, доставляє, маршрутизує та налаштовує TLS для вашого застосунку. Керуйте нею з десктопного застосунку, веб-панелі або CLI.
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
  <a href="#швидкий-старт">Швидкий старт</a> ·
  <a href="#як-це-працює">Як це працює</a> ·
  <a href="#інтерфейси">Інтерфейси</a> ·
  <a href="https://openship.io/docs">Документація</a> ·
  <a href="../../CONTRIBUTING.md">Участь у розробці</a>
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
  <a href="README.uk.md"><img src="https://img.shields.io/badge/lang-Українська-0b7285" alt="Українська" /></a>
  <a href="README.ko.md"><img src="https://img.shields.io/badge/lang-한국어-555" alt="한국어" /></a>
</p>

<p align="center">
  <img src="../screenshots/screen.png" alt="Openship dashboard" width="800" />
</p>

---

## Швидкий старт

Спочатку потрібно прийняти одне рішення: **як ви запускаєте сам Openship** (площину керування). Усе інше далі однакове.

| Якщо ви… | Запускайте Openship як | Де працюють ваші застосунки |
|---|---|---|
| **Самостійно, на одній машині, без DevOps** | **Десктопний застосунок** | Сервер, до якого ви підключаєтесь через SSH, або Openship Cloud |
| **Команда — або хочете push-to-deploy / хостити застосунки на своєму сервері** | **Сервер із самостійним хостингом** (`openship up`) | На цьому сервері (режим Compose) — або на інший сервер / Cloud (режим bare) |
| **Не хочете нічого запускати самостійно** | **Openship Cloud** | Керовані пісочниці, без налаштувань |

> [!TIP]
> **Самостійно? Використовуйте десктопний застосунок.** Він запускає площину керування Openship на вашій власній машині *лише поки застосунок відкритий* — на завжди увімкненому сервері нічого не залишається працювати, назовні нічого не відкрито. Завжди увімкнений сервер потрібен лише тоді, коли вам потрібні **push-to-deploy (CI/CD)**, **доступ для команди** або **хостинг застосунків на цьому сервері** — те, що потребує публічної, завжди доступної точки входу.

### Самостійно — десктопний застосунок

Площина керування працює локально та керує вашими серверами через SSH. Без входу в систему, без термінала, без публічної поверхні — завантажте, відкрийте, готово:

| Платформа | Завантаження |
|---|---|
| **macOS** (Apple Silicon) | [Openship-arm64.dmg](https://github.com/oblien/openship/releases/latest/download/Openship-arm64.dmg) |
| **macOS** (Intel) | [Openship-x64.dmg](https://github.com/oblien/openship/releases/latest/download/Openship-x64.dmg) |
| **Windows** | [Openship-win32-x64.zip](https://github.com/oblien/openship/releases/latest/download/Openship-win32-x64.zip) |
| **Linux** | [Openship.AppImage](https://github.com/oblien/openship/releases/latest/download/Openship.AppImage) |

Linux: `chmod +x Openship.AppImage && ./Openship.AppImage`. Уже маєте CLI? `openship install` завантажить і запустить його. Посилання завжди вказують на найновіший реліз.

З десктопного застосунку ви підключаєте сервер (SSH) або Openship Cloud і розгортаєте на ньому — сам застосунок не хостить публічні застосунки на вашому ноутбуці.

### Команда / завжди увімкнено — сервер із самостійним хостингом

Встановіть CLI (він містить API + панель), потім запустіть **`openship`** — інтерактивний майстер створить першого адміністратора, налаштує ваш домен і встановить Openship як сервісну службу. Запускайте його знову будь-коли, щоб керувати інстансом.

```bash
curl -fsSL https://get.openship.io | sh          # install  (or: npm i -g openship — needs Node 22+)
openship                                          # guided setup, then control panel
```

Установчий скрипт принесе власний Node, якщо ваш системний старіший за 22; встановлення через пакетний менеджер працює на тому Node, який у вас уже є.

Для CI / безголових серверів пропустіть майстер і одразу керуйте через `openship up`:

```bash
openship up                                       # install + start as a background service (boots + auto-restarts)
openship up --public-url https://openship.example.com   # + serve the dashboard on your domain (edge + TLS handled)
```

**`openship up` сам обирає, як йому працювати:**

- **На Linux із Docker → режим Compose** (за замовчуванням). Піднімає весь стек — Postgres, Redis, API, панель і контейнеризований **OpenResty edge на :80/:443** — з опублікованих образів. Саме цей варіант **хостить ваші розгорнуті застосунки на тому самому сервері**, з автоматичними доменами та Let's Encrypt TLS. Примусово увімкнути: `--compose`.
- **Усюди інде → режим bare** (macOS, Windows або Linux без Docker). Один легкий процес із вбудованою базою даних — завжди увімкнена площина керування, яка **розгортає застосунки на зовнішній сервер (SSH) або Cloud**, як десктопний застосунок, але завжди увімкнена та з обов'язковим входом. Примусово увімкнути: `--bare`.

Інстанс із самостійним хостингом **завжди вимагає входу** (адміністратор, якого ви створюєте під час налаштування). `openship open` відкриває панель · `openship stop` зупиняє її · `openship update` оновлює · `openship up --foreground` запускає в приєднаному режимі.

> **Спробувати невипущену збірку (dev).** Щоб запустити CLI, зібраний прямо з вихідного коду — гілки, тега або `main` попереду наступного релізу — встановіть збірку з вихідного коду:
>
> ```bash
> curl -fsSL https://get.openship.io/dev | sh                  # main (default)
> curl -fsSL https://get.openship.io/dev | OPENSHIP_REF=dev sh  # a branch/tag (var goes on sh, not curl)
> openship-dev                                     # same CLI, built from source
> openship-dev update                              # pull latest source + rebuild (no release needed)
> ```
>
> Встановлюється як **окрема команда `openship-dev`** зі своєю ізольованою домівкою (`~/.openship-dev`) і сервісною службою, тож ваш продуктивний `openship` та його дані ніколи не зачіпаються. Потрібні Bun і git; це неперевірена dev-збірка (компіляція панелі потребує реальної RAM/CPU) — не для продакшену.

**Розгортання проєкту:**

```bash
cd your-project
openship init            # link this directory to a project
openship deploy
```

Повний посібник із серверу та повна довідка по CLI: **[openship.io/docs](https://openship.io/docs)**.

<details>
<summary>Автодоповнення в оболонці (bash/zsh/fish)</summary>

Два способи увімкнути автодоповнення по Tab для `openship`:

| | Налаштування | Компроміс |
|---|---|---|
| **Статичний файл** (рекомендовано) | `openship completion <shell> > <path>` | Миттєвий запуск оболонки. Перегенеруйте після оновлення, щоб отримати нові команди. |
| **Динамічне джерело** | додайте `source <(openship completion <shell>)` до конфігурації оболонки | Завжди відображає встановлену версію. Додає невелику затримку до кожної нової сесії оболонки. |

**Статичний файл:**
```bash
openship completion bash > /etc/bash_completion.d/openship
openship completion zsh  > ~/.zsh/completions/_openship
openship completion fish > ~/.config/fish/completions/openship.fish
```
Відкрийте новий термінал — готово.

**Динамічне джерело** (приклад для zsh):
```bash
echo 'source <(openship completion zsh)' >> ~/.zshrc
```

</details>

<details>
<summary>Самостійний хостинг через звичайний Docker Compose (без CLI)</summary>

Стек для самостійного хостингу лежить у **`docker/docker-compose.yml`** і **завантажує** опубліковані образи з GitHub Container Registry (`ghcr.io/oblien/*`) — без інструментів збірки, без компіляції монорепозиторію. Запускайте з кореня репозиторію:

```bash
git clone https://github.com/oblien/openship.git && cd openship
cp .env.example .env          # then edit
docker compose --env-file .env -f docker/docker-compose.yml up -d
```

Стек — це **postgres + redis + api + dashboard + edge**. `edge` — це OpenResty на **:80/:443** як контейнер (`network_mode: host`) — маршрутизація + Let's Encrypt, без встановлення на голий хост. **Тільки Linux** (мережа хоста); на mac/win використовуйте `openship up` (bare). Контейнер `api` монтує Docker-сокет хоста, щоб площина керування могла збирати й запускати ваші застосунки як контейнери хоста — це надає привілеї рівня хоста через сокет, тож запускайте його лише на довіреному хості.

**Оновлення:** зафіксуйте `OPENSHIP_VERSION` у `.env` для відтворюваних завантажень, потім `docker compose --env-file .env -f docker/docker-compose.yml pull && … up -d`. `openship update` узгоджує лише стек, встановлений через CLI, а `openship up` *перебере* цей стек на себе — не використовуйте жодне з них тут. **Натомість зберіть із вихідного коду:** додайте `-f docker/docker-compose.build.yml … up -d --build`.

**Операції на хості** (перехоплення `:80`/`:443`, поштовий рушій, термінал хоста/сканування портів) потребують SSH-каналу контейнер→хост, який надає `openship up`, а цей шлях — ні: п'ять ручних кроків описані в `.env.example` у розділі *Host operations from the container*, а помилка, яку це спричиняє, описана в [Troubleshooting → Host control channel](https://openship.io/docs/troubleshooting/host-channel). Усе інше, включно з розгортаннями, працює й без цього.

> **Кореневий** `docker-compose.yml` — це інший файл: це SaaS / зібрана з вихідного коду **площина керування** (збирається з вихідного коду, доставляє маркетинговий сайт, без edge/сокета). Він **не** хостить ваші застосунки самостійно — використовуйте `docker/docker-compose.yml` вище або `openship up`.

</details>

---

## Як це працює

Вкажіть Openship на джерело — **репозиторій GitHub**, **локальну теку** або **готовий артефакт** — і він виконає один наскрізний конвеєр:

1. **Виявлення.** Читає ваш `package.json`, конфігурацію фреймворку, lock-файли та будь-який `docker-compose.yml` / `openship.json`, щоб визначити стек, пакетний менеджер, команди збірки/запуску та порт. Файли конфігурації не обов'язкові; `openship.json` перевизначає здогадки, якщо потрібен контроль.
2. **Збірка.** На цільовому сервері або локально на оркестраторі, в Docker-образ або bare-реліз. Визначена конфігурація фіксується в знімку, тому повторні розгортання та відкати відтворюють *точно* те, що було доставлено.
3. **Запуск.** Як контейнер (опублікований лише на loopback — ніколи на публічному порту) або керований процес хоста.
4. **Маршрутизація й захист.** Edge на OpenResty записує vhost зворотного проксі для вашого домену та видає сертифікат Let's Encrypt (HTTP-01). Оскільки маршрутизація й TLS відбуваються *після* запуску застосунку, збій DNS або сертифіката проявляється як "потрібна дія" — він ніколи не провалює розгортання й не вимикає ваш застосунок.
5. **Push-to-deploy.** Вебхук GitHub повторно запускає конвеєр при кожному push у відстежувану гілку — перебудовуючи лише ті сервіси, яких фактично торкнувся push у монорепозиторії.

Бази даних, домени, SSL, CDN, пошта та резервні копії керуються з того самого місця. (Push-to-deploy і публічні домени потребують завжди увімкненого сервера або Cloud — десктопний/loopback-інстанс не має публічної точки входу для отримання вебхуків.)

---

## Інтерфейси

Три способи керувати одним і тим самим бекендом:

- **Десктопний застосунок** — повноцінний GUI, логи в реальному часі, усе в один клік. Найкраще для самостійної роботи.
- **Веб-панель** — той самий інтерфейс у браузері, створений для команд.
- **CLI** — придатний для скриптів і CI; також так ви встановлюєте й керуєте інстансом із самостійним хостингом.

Точка входу **MCP** (для AI-агентів) і **REST API** доповнюють це для автоматизації. Як інструменти MCP відкриваються лише ті маршрути, що явно на це погодилися, кожен виклик заново перевіряє ваші дозволи, а маршрути з обліковими даними/токенами ніколи не можуть стати інструментами. Повна довідка на [openship.io/docs](https://openship.io/docs).

> [!NOTE]
> Документація активно наповнюється. Якщо чогось не вистачає або щось незрозуміло, [внески](../../CONTRIBUTING.md) дуже вітаються.

---

## Можливості

| | |
|---|---|
| **Вбудований CI/CD** | Push-to-deploy, preview-середовища, потоки staging/prod, відкати |
| **Будь-який стек** | Node, Python, Go, Rust, PHP, Ruby, Java, .NET, Docker, монорепозиторії |
| **Повноцінний бекенд** | Postgres, MySQL, MongoDB, Redis, воркери, WebSockets, сховище |
| **Домени та SSL** | Автоматичний Let's Encrypt, вайлдкарди, необмежена кількість доменів, автопродовження |
| **CDN** | Кешування на edge, HTTP/3, стиснення Brotli, миттєве очищення |
| **Поштовий сервер** | Вбудований SMTP з DKIM/SPF/DMARC — без потреби в Mailgun чи SES |
| **Резервні копії** | За розкладом, бази даних + томи, відновлення в один клік, експорт будь-коли |
| **Моніторинг у реальному часі** | Логи збірки в реальному часі, метрики контейнерів, географія відвідувачів і розподіл відповідей за кодами — [~1.4 мкс на запит, нуль записів у БД на запит](../monitoring.md) |
| **Масштабування** | Автомасштабування в хмарі, готовність до multi-node при самостійному хостингу |
| **Портативність** | Стандартні Docker-контейнери — вільно переносьте між провайдерами |
| **Docker Compose** | Розгортайте наявні compose-файли як є |

---

## Розгортання будь-де

- **Openship Cloud** — керований, з автомасштабуванням, без налаштувань
- **Будь-який VPS** — Hetzner, DigitalOcean, Linode, OVH та інші
- **Виділені сервери** — bare metal, colocation, домашня лабораторія
- **Multi-server** — розподіляйте навантаження між машинами

Однаковий інтерфейс незалежно від того, де ви розгортаєтесь.

---

## Статус

Продуктивно готове ядро, активна розробка. Самостійний хостинг **безкоштовний** (без оплати).

**Далі в планах:** multi-node-кластери, UI для балансування навантаження, приватні мережі, розширений моніторинг і візуальні CI/CD-конвеєри.

---

## Участь у розробці

Дивіться [CONTRIBUTING.md](../../CONTRIBUTING.md).

---

## Безпека

Знайшли вразливість? Ми вітаємо ваше повідомлення — будь ласка, повідомляйте про неї **приватно**,
ніколи в публічному issue, PR чи обговоренні.

- **Повідомте тут (бажано):** [Report a vulnerability](https://github.com/oblien/openship/security/advisories/new) — приватна консультація GitHub, видима лише вам і мейнтейнерам.
- Обсяг, що включати, і наш процес реагування/розкриття: [SECURITY.md](../../SECURITY.md).

Добросовісні дослідження безпеки **дозволені** відповідно до нашої
[політики safe harbor](../../SECURITY.md#safe-harbor), і ми з радістю відзначимо тих, хто першим повідомив про справжню вразливість.

## Ліцензія

Openship — це **програмне забезпечення з відкритим кодом**, ліцензоване за [Apache License 2.0](../../LICENSE).

Ви можете використовувати, запускати, модифікувати, самостійно хостити та поширювати його — включно з
комерційними продуктами та продуктами із закритим кодом — відповідно до умов ліцензії Apache 2.0. Дивіться
[LICENSE](../../LICENSE) для повного тексту.
