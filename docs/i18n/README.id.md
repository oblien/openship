<h1 align="center">Openship</h1>

<p align="center">
  Platform deployment open-source dan bisa self-host dengan CI/CD bawaan.<br>
  Push kode, kirim container, kelola infrastruktur — lewat aplikasi desktop, dashboard web, atau CLI.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/openship"><img src="https://img.shields.io/npm/v/openship?color=0b7285&label=npm" alt="npm version" /></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License" /></a>
  <a href="https://openship.io"><img src="https://img.shields.io/badge/website-openship.io-0b7285" alt="Website" /></a>
</p>

<p align="center">
  <a href="#memulai-cepat">Memulai Cepat</a> ·
  <a href="#fitur">Fitur</a> ·
  <a href="#tiga-antarmuka">Antarmuka</a> ·
  <a href="https://openship.io/docs">Dokumentasi</a> ·
  <a href="../../CONTRIBUTING.md">Kontribusi</a>
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
  <a href="README.id.md"><img src="https://img.shields.io/badge/lang-Bahasa%20Indonesia-0b7285" alt="Bahasa Indonesia" /></a>
</p>

<p align="center">
  <img src="../screenshots/screen.png" alt="Openship dashboard" width="800" />
</p>

---

## Memulai Cepat

```bash
npm i -g openship     # or: curl -fsSL https://get.openship.io | sh
openship up           # installs Openship as a background service (starts on boot, auto-restarts)
```

`openship open` membuka dashboard; `openship stop` menghentikan layanan. Lebih suka menjalankannya sekali saja di foreground (attached)? `openship up --foreground`. Untuk men-deploy sebuah proyek:

```bash
cd your-project
openship init         # link this directory to a project
openship deploy
```

Lebih suka Docker? Klon repo dan pakai stack Compose:

```bash
git clone https://github.com/oblien/openship.git && cd openship
cp .env.example .env
docker compose up -d
```

Atau ambil aplikasi desktop (`openship install` atau unduh dari [openship.io](https://openship.io)).

---

## Apa yang Dilakukannya

Arahkan ke sebuah repo. Openship mendeteksi stack Anda, membangunnya, mengonfigurasi semuanya, dan mengirimkannya — tanpa file konfigurasi, tanpa pipeline, tanpa YAML.

Database, domain, SSL, CDN, email, dan backup — semua dikelola dari satu tempat.

Bekerja dengan **Openship Cloud** (managed) atau **server Linux mana pun** milik Anda. Developer solo yang merilis proyek sampingan dan tim di produksi memakai alat yang sama.

---

## Fitur

| | |
|---|---|
| **CI/CD Bawaan** | Push-to-deploy, environment preview, alur staging/prod, rollback |
| **Semua Stack** | Node, Python, Go, Rust, PHP, Ruby, Java, .NET, Docker, monorepo |
| **Backend Lengkap** | Postgres, MySQL, MongoDB, Redis, worker, WebSocket, storage |
| **Domain & SSL** | Let's Encrypt otomatis, wildcard, domain tanpa batas, perpanjangan otomatis |
| **CDN** | Edge caching, HTTP/3, kompresi Brotli, purge instan |
| **Mail server** | SMTP bawaan dengan DKIM/SPF/DMARC — tanpa perlu Mailgun atau SES |
| **Backup** | Terjadwal, database + volume, restore satu klik, ekspor kapan saja |
| **Monitoring real-time** | Log build langsung, metrik container, dan penggunaan resource di-stream ke layar Anda |
| **Scaling** | Auto-scaling di cloud, siap multi-node saat self-host |
| **Portabilitas** | Container Docker standar — pindah antar penyedia dengan bebas |
| **Docker Compose** | Deploy file compose yang sudah ada apa adanya |

---

## Deploy di Mana Saja

- **Openship Cloud** — managed, auto-scaling, tanpa setup
- **VPS mana pun** — Hetzner, DigitalOcean, Linode, OVH, dan lainnya
- **Server dedicated** — bare metal, colocation, homelab
- **Multi-server** — sebarkan beban kerja ke banyak mesin

Antarmuka yang sama di mana pun Anda men-deploy.

---

## Tiga Antarmuka

- **Aplikasi desktop** — GUI lengkap, log real-time, semua sekali klik.
- **Dashboard web** — UI yang sama di browser, dibuat untuk tim.
- **CLI** — bisa di-script dan ramah CI.

**REST API** dan **MCP** (protokol agen AI) melengkapinya untuk otomatisasi dan integrasi tool. Referensi perintah dan API lengkap di [openship.io/docs](https://openship.io/docs).

> [!NOTE]
> Dokumentasi masih dalam pengerjaan — kami sedang aktif melengkapinya. Jika ada yang kurang atau tidak jelas, [kontribusi](../../CONTRIBUTING.md) sangat kami harapkan dan membantu kami mencapainya lebih cepat.

---

## Status

Inti siap produksi, terus dikembangkan secara aktif.

**Selanjutnya:** cluster multi-node, UI load-balancing, jaringan privat, monitoring lanjutan, dan pipeline CI/CD visual.

---

## Kontribusi

Lihat [CONTRIBUTING.md](../../CONTRIBUTING.md).

---

## Lisensi

Openship adalah perangkat lunak **open-source**, dilisensikan di bawah [Apache License 2.0](../../LICENSE).

Anda boleh menggunakan, menjalankan, memodifikasi, self-host, dan mendistribusikannya — termasuk dalam produk komersial dan closed-source — sesuai ketentuan lisensi Apache 2.0. Teks lengkapnya ada di [LICENSE](../../LICENSE).
