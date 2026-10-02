<h1 align="center">Openship</h1>

<p align="center">
  Platform deployment open-source dan self-hosted dengan CI/CD bawaan.<br>
  Arahkan ke repository — ia akan membangun, mengirimkan, merutekan, dan mengakhiri TLS untuk aplikasi Anda. Kendalikan dari aplikasi desktop, dashboard web, atau CLI.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/openship"><img src="https://img.shields.io/npm/v/openship?color=0b7285&label=npm" alt="npm version" /></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License" /></a>
  <a href="https://openship.io"><img src="https://img.shields.io/badge/website-openship.io-0b7285" alt="Website" /></a>
</p>

<p align="center">
  <a href="#mulai-cepat">Mulai Cepat</a> ·
  <a href="#cara-kerjanya">Cara Kerja</a> ·
  <a href="#antarmuka">Antarmuka</a> ·
  <a href="https://openship.io/docs">Dokumentasi</a> ·
  <a href="../../CONTRIBUTING.md">Berkontribusi</a>
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
  <a href="README.id.md"><img src="https://img.shields.io/badge/lang-Bahasa Indonesia-0b7285" alt="Bahasa Indonesia" /></a>
</p>

<p align="center">
  <img src="../screenshots/screen.png" alt="Dashboard Openship" width="800" />
</p>

---

## Mulai Cepat

Ada satu keputusan yang harus diambil terlebih dahulu: **cara menjalankan OpenShip itu sendiri** (control plane). Sisanya sama setelahnya.

| Jika Anda… | Jalankan OpenShip sebagai | Di mana aplikasi Anda berjalan |
|---|---|---|
| **Sendirian, satu mesin, tanpa operasional** | **Aplikasi desktop** | Server yang Anda hubungkan melalui SSH, atau OpenShip Cloud |
| **Tim — atau Anda ingin push-to-deploy / meng-host aplikasi di server sendiri** | **Server self-hosted** (`openship up`) | Di server tersebut (mode Compose) — atau ke server lain / Cloud (mode bare) |
| **Tidak tertarik menjalankan apa pun** | **OpenShip Cloud** | Sandbox terkelola, zero setup |

> [!TIP]
> **Sendirian? Gunakan aplikasi desktop.** Aplikasi ini menjalankan control plane OpenShip di mesin Anda sendiri *hanya saat aplikasi terbuka* — tidak ada yang ditinggal berjalan di server yang selalu aktif, tidak ada yang diekspos secara publik. Anda hanya perlu instalasi server yang selalu aktif ketika Anda ingin **push-to-deploy (CI/CD)**, **akses tim**, atau **menghost aplikasi di server tersebut** — hal-hal yang memerlukan endpoint publik yang selalu aktif.

### Sendirian — aplikasi desktop

Control plane berjalan secara lokal dan mengendalikan server Anda melalui SSH. Tanpa login, tanpa terminal, tanpa permukaan publik — unduh, buka, selesai:

| Platform | Unduh |
|---|---|
| **macOS** (Apple Silicon) | [Openship-arm64.dmg](https://github.com/oblien/openship/releases/latest/download/Openship-arm64.dmg) |
| **macOS** (Intel) | [Openship-x64.dmg](https://github.com/oblien/openship/releases/latest/download/Openship-x64.dmg) |
| **Windows** | [Openship-win32-x64.zip](https://github.com/oblien/openship/releases/latest/download/Openship-win32-x64.zip) |
| **Linux** | [Openship.AppImage](https://github.com/oblien/openship/releases/latest/download/Openship.AppImage) |

Linux: `chmod +x Openship.AppImage && ./Openship.AppImage`. Sudah punya CLI? `openship install` mengunduh dan menjalankannya. Tautan selalu menunjuk ke rilis terbaru.

Dari aplikasi desktop Anda menghubungkan server (SSH) atau OpenShip Cloud dan melakukan deploy ke sana — aplikasi itu sendiri tidak meng-host aplikasi publik di laptop Anda.

### Tim / selalu aktif — server self-hosted

Instal CLI (yang mencakup API + dashboard), lalu jalankan **`openship`** — wizard interaktif membuat admin pertama, menghubungkan domain Anda, dan menginstal OpenShip sebagai layanan boot. Jalankan lagi kapan saja untuk mengelola instance.

```bash
curl -fsSL https://get.openship.io | sh          # instalasi (atau: npm i -g openship — butuh Node 22+)
openship                                          # pengaturan terpandu, lalu control panel
```

Untuk CI / server headless, lewati wizard dan jalankan `openship up` langsung:

```bash
openship up                                       # instalasi + mulai sebagai layanan latar belakang (boot + restart otomatis)
openship up --public-url https://openship.example.com   # + layani dashboard di domain Anda (edge + TLS ditangani)
```

`openship open` membuka dashboard · `openship stop` menghentikannya · `openship update` memperbarui · `openship up --foreground` berjalan terpasang.

**Deploy proyek:**

```bash
cd your-project
openship init            # hubungkan direktori ini ke proyek
openship deploy
```

Panduan server lengkap + referensi CLI: **[openship.io/docs](https://openship.io/docs)**.

<details>
<summary>Self-host dengan Docker Compose mentah (tanpa CLI)</summary>

Stack self-hosted berada di **`docker/docker-compose.yml`** dan **menarik** gambar yang dipublikasikan dari GitHub Container Registry (`ghcr.io/oblien/*`) — tanpa alat build, tanpa kompilasi monorepo. Jalankan dari root repo:

```bash
git clone https://github.com/oblien/openship.git && cd openship
cp .env.example .env          # lalu edit
docker compose --env-file .env -f docker/docker-compose.yml up -d
```

Stack-nya adalah **postgres + redis + api + dashboard + edge**. `edge` adalah OpenResty di **:80/:443** sebagai container (`network_mode: host`) — routing + Let's Encrypt, tanpa instalasi host bare. **Hanya Linux** (host networking); di mac/win gunakan `openship up` (bare). Container `api` me-mount Docker socket host sehingga control plane bisa membangun + menjalankan aplikasi Anda sebagai container host — ia memiliki hak istimewa host melalui socket, jadi jalankan hanya di host tepercaya.

</details>

---

## Cara Kerja

Arahkan OpenShip ke sumber — **repository GitHub**, **folder lokal**, atau **artefak prebuilt** — dan ia menjalankan satu pipeline dari awal hingga akhir:

1. **Deteksi.** Membaca `package.json`, konfigurasi framework, lockfile, dan `docker-compose.yml` / `openship.json` apa pun untuk menentukan stack, manajer paket, command build/mulai, dan port. Tanpa file konfigurasi yang diperlukan; `opsional.json` mengganti tebakan jika Anda ingin mengontrol.
2. **Bangun.** Di server target atau lokal di orkestrator, menjadi gambar Docker atau rilis bare. Konfigurasi yang diselesaikan dibekukan menjadi snapshot, sehingga deploy ulang dan rollback menjalankan *persis* apa yang dikirim.
3. **Jalankan.** Sebagai container (dipublikasikan di loopback saja — tidak pernah port publik) atau proses host yang diawasi.
4. **Rutekan + amankan.** Edge OpenResty menulis vhost reverse-proxy ke domain Anda dan menerbitkan sertifikat Let's Encrypt (HTTP-01). Karena routing dan TLS terjadi *setelah* aplikasi aktif, gangguan DNS atau sertifikat muncul sebagai "aksi diperlukan" — ia tidak pernah gagal dalam deploy atau membawa aplikasi Anda turun.
5. **Push-to-deploy.** Webhook GitHub menjalankan ulang pipeline setiap push ke branch yang dilacak — hanya membangun ulang layanan yang benar-benar disentuh oleh push monorepo.

Database, domain, SSL, CDN, email, dan backup dikelola dari tempat yang sama. (Push-to-deploy dan domain publik memerlukan server yang selalu aktif atau Cloud — instance desktop/loopback tidak memiliki endpoint publik untuk menerima webhook.)

---

## Antarmuka

Tiga cara untuk mengendalikan backend yang sama:

- **Aplikasi desktop** — GUI lengkap, log real-time, satu klik untuk semuanya. Terbaik untuk penggunaan sendirian.
- **Dashboard web** — UI yang sama di browser, dibuat untuk tim.
- **CLI** — dapat di-scipting dan ramah CI; juga cara Anda menginstal dan mengelola instance self-hosted.

Endpoint **MCP** (untuk AI agent) dan **REST API** melengkapi kebutuhan otomatisasi. Hanya route yang memilih untuk ikut yang diekspos sebagai tool MCP, setiap panggilan memeriksa ulang izin Anda, dan route credential/token tidak pernah bisa menjadi tool. Referensi lengkap di [openship.io/docs](https://openship.io/docs).

> [!NOTE]
> Dokumentasi sedang aktif diisi. Jika ada yang kurang atau tidak jelas, [kontribusi](../../CONTRIBUTING.md) sangat kami hargai.

---

## Fitur

| | |
|---|---|
| **CI/CD bawaan** | Push-to-deploy, environment pratinjau, alur staging/produksi, rollback |
| **Stack apa pun** | Node, Python, Go, Rust, PHP, Ruby, Java, .NET, Docker, monorepo |
| **Backend lengkap** | Postgres, MySQL, MongoDB, Redis, worker, WebSocket, penyimpanan |
| **Domain & SSL** | Let's Encrypt otomatis, wildcard, domain tak terbatas, perpanjangan otomatis |
| **CDN** | Caching edge, HTTP/3, kompresi Brotli, purge instan |
| **Server email** | SMTP bawaan dengan DKIM/SPF/DMARC — tanpa Mailgun atau SES |
| **Backup** | Terjadwal, database + volume, pemulihan satu klik, ekspor kapan saja |
| **Monitoring real-time** | Log build langsung, metrik container, geografi pengunjung, dan campuran respons per kode — [~1,4 µs per request, nol tulisan DB per request](docs/monitoring.md) |
| **Skalabilitas** | Auto-scaling di cloud, siap multi-node di self-hosted |
| **Portabilitas** | Container Docker standar — pindah antar penyedia dengan bebas |
| **Docker Compose** | Deploy file compose yang ada apa adanya |

---

## Deploy Ke Mana Saja

- **OpenShip Cloud** — terkelola, auto-scaling, zero setup
- **VPS mana pun** — Hetzner, DigitalOcean, Linode, OVH, dan lainnya
- **Server dedicated** — bare metal, colo, homelab
- **Multi-server** — sebarkan workload ke berbagai mesin

Antarmuka yang sama tidak peduli di mana Anda deploy.

---

## Status

Inti production-ready, sedang aktif dikembangkan. Self-hosting **gratis** (tanpa tagihan).

**Selanjutnya:** cluster multi-node, UI load balancing, networking privat, monitoring lanjutan, dan pipeline CI/CD visual.

---

## Berkontribusi

Lihat [CONTRIBUTING.md](../../CONTRIBUTING.md).

---

## Keamanan

Menemukan kerentanan? Kami menerima laporan Anda — silakan laporkan secara **privat**,
jangan di issue, PR, atau diskusi publik.

- **Laporkan di sini (dianjurkan):** [Laporkan kerentanan](https://github.com/oblien/openship/security/advisories/new) — advisory GitHub privat, hanya terlihat oleh Anda dan maintainer.
- Cakupan, informasi yang perlu disertakan, dan proses respons/pengungkapan kami: [SECURITY.md](../../SECURITY.md).

Penelitian keamanan dengan niat baik **diizinkan** di bawah
[kebijakan safe-harbor](../../SECURITY.md#safe-harbor) kami, dan kami dengan senang hati memberikan pengakuan
untuk laporan pertama yang valid.

---

## Lisensi

OpenShip adalah perangkat lunak **open-source**, berlisensi di bawah [Apache License 2.0](../../LICENSE).

Anda dapat menggunakan, menjalankan, memodifikasi, self-host, dan mendistribusikannya — termasuk dalam
produk komersial dan closed-source — di bawah ketentuan lisensi Apache 2.0. Lihat
[LICENSE](../../LICENSE) untuk teks lengkap.
