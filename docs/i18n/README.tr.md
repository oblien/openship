<h1 align="center">Openship</h1>

<p align="center">
  Yerleşik CI/CD özelliklerine sahip, açık kaynaklı ve kendi sunucunuzda barındırabileceğiniz dağıtım platformu.<br>
  Kodunuzu gönderin, konteynerleri dağıtın ve altyapınızı masaüstü uygulaması, web paneli veya CLI üzerinden yönetin.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/openship"><img src="https://img.shields.io/npm/v/openship?color=0b7285&label=npm" alt="npm sürümü" /></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Lisans" /></a>
  <a href="https://openship.io"><img src="https://img.shields.io/badge/website-openship.io-0b7285" alt="Web sitesi" /></a>
</p>

<p align="center">
  <a href="#hızlı-başlangıç">Hızlı Başlangıç</a> ·
  <a href="#özellikler">Özellikler</a> ·
  <a href="#üç-arayüz">Arayüzler</a> ·
  <a href="https://openship.io/docs">Belgeler</a> ·
  <a href="../../CONTRIBUTING.md">Katkıda Bulunma</a>
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
  <a href="README.tr.md"><img src="https://img.shields.io/badge/lang-Türkçe-0b7285" alt="Türkçe" /></a>
</p>

<p align="center">
  <img src="../screenshots/screen.png" alt="Openship kontrol paneli" width="800" />
</p>

---

## Hızlı Başlangıç

Çalışma biçiminize göre seçim yapın: **tek başınıza → masaüstü uygulaması**, **ekip veya kesintisiz çalışma → sunucuda CLI**.

### Tek başınıza — masaüstü uygulaması

Kontrol düzlemi bilgisayarınızda çalışır ve sunucularınızı SSH üzerinden yönetir; Openship'in hiçbir bileşeni herkese açık hâle getirilmez. İndirin ve açın; terminal kullanmanız gerekmez:

| Platform                  | İndirme                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **macOS** (Apple Silicon) | [Openship-arm64.dmg](https://github.com/oblien/openship/releases/latest/download/Openship-arm64.dmg)         |
| **macOS** (Intel)         | [Openship-x64.dmg](https://github.com/oblien/openship/releases/latest/download/Openship-x64.dmg)             |
| **Windows**               | [Openship-win32-x64.zip](https://github.com/oblien/openship/releases/latest/download/Openship-win32-x64.zip) |
| **Linux**                 | [Openship.AppImage](https://github.com/oblien/openship/releases/latest/download/Openship.AppImage)           |

Linux: `chmod +x Openship.AppImage && ./Openship.AppImage`. Bağlantılar her zaman en yeni sürümü gösterir.

### Ekip veya kesintisiz çalışma — sunucuda CLI

API ve kontrol panelini birlikte içeren CLI'ı kurup **`openship`** komutunu çalıştırın. Etkileşimli sihirbaz ilk yöneticiyi oluşturur, alan adınızı yapılandırır ve Openship'i açılışta çalışan bir servis olarak kurar. Kurulumu daha sonra yönetmek için aynı komutu yeniden çalıştırabilirsiniz.

```bash
curl -fsSL https://get.openship.io | sh             # kurulum (alternatif: npm i -g openship)
openship                                            # etkileşimli kurulum ve kontrol paneli
```

CI veya etkileşimsiz sunucularda sihirbazı atlayarak doğrudan `openship up` kullanabilirsiniz. Aynı arka plan servisi sistem açılışında başlar ve hata durumunda otomatik olarak yeniden çalışır:

```bash
openship up                                             # bu makinede arka plan servisi
openship up --public-url https://openship.example.com   # kendi alan adınızda yayınla (edge + TLS dâhil)
```

`openship open` kontrol panelini açar · `openship stop` servisi durdurur · `openship update` günceller · `openship up --foreground` ön planda çalıştırır.

**Bir proje dağıtın:**

```bash
cd your-project
openship init          # bu dizini bir projeye bağlar
openship deploy
```

Sunucu kurulum kılavuzu ve eksiksiz CLI başvurusu: **[docs/installation.md](../installation.md)**.

<details>
<summary>Gelişmiş: Docker Compose ile kaynak koddan çalıştırma (önerilen yöntem değildir)</summary>

Bu yöntem CLI'dan daha ağırdır. Compose yığını, kontrol düzlemi konteynerine ana makinenin Docker daemon'ına erişim verir. Yalnızca konteyner içinde çalışan bir kontrol düzlemine özellikle ihtiyacınız varsa kullanın. Desteklenen kurulum yöntemleri yukarıdaki CLI ve masaüstü uygulamasıdır.

```bash
git clone https://github.com/oblien/openship.git && cd openship
cp .env.example .env
docker compose up -d
```

</details>

---

## Ne Yapar?

Bir depoyu seçin. Openship teknoloji yığınınızı algılar, derler, yapılandırır ve dağıtır; yapılandırma dosyaları, işlem hatları veya YAML yazmanız gerekmez.

Veritabanları, alan adları, SSL, CDN, e-posta ve yedeklemeler tek bir yerden yönetilir.

Yan projelerini dağıtan bireysel geliştiriciler ile canlı ortamları yöneten ekipler aynı aracı kullanabilir.

---

## Özellikler

|                           |                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------- |
| **Yerleşik CI/CD**        | Push ile dağıtım, önizleme ortamları, hazırlık/canlı ortam akışları ve geri alma        |
| **Her teknoloji yığını**  | Node, Python, Go, Rust, PHP, Ruby, Java, .NET, Docker ve monorepo desteği               |
| **Eksiksiz backend**      | Postgres, MySQL, MongoDB, Redis, worker'lar, WebSockets ve depolama                     |
| **Alan adları ve SSL**    | Otomatik Let's Encrypt, wildcard sertifikalar, sınırsız alan adı ve otomatik yenileme   |
| **CDN**                   | Edge önbellekleme, HTTP/3, Brotli sıkıştırma ve anında temizleme                        |
| **E-posta sunucusu**      | DKIM/SPF/DMARC destekli yerleşik SMTP; Mailgun veya SES gerekmez                        |
| **Yedeklemeler**          | Zamanlanmış veritabanı ve disk birimi yedekleri, tek tıkla geri yükleme ve dışa aktarma |
| **Gerçek zamanlı izleme** | Canlı derleme günlükleri, konteyner metrikleri ve kaynak kullanımı                      |
| **Ölçeklendirme**         | Bulutta otomatik ölçeklendirme, kendi sunucunuzda çok düğümlü çalışma desteği           |
| **Taşınabilirlik**        | Standart Docker konteynerleriyle sağlayıcılar arasında serbestçe geçiş                  |
| **Docker Compose**        | Mevcut Compose dosyalarını değiştirmeden dağıtma                                        |

---

## İstediğiniz Yere Dağıtın

- **Openship Cloud** — yönetilen, otomatik ölçeklenen ve kurulum gerektirmeyen ortam
- **Herhangi bir VPS** — Hetzner, DigitalOcean, Linode, OVH ve diğerleri
- **Fiziksel sunucular** — bare metal, veri merkezi veya ev laboratuvarı
- **Çoklu sunucu** — iş yüklerini birden fazla makineye dağıtma

Nereye dağıtırsanız dağıtın aynı arayüzü kullanırsınız.

---

## Üç Arayüz

- **Masaüstü uygulaması** — eksiksiz grafik arayüz, gerçek zamanlı günlükler ve tek tıklamalı işlemler.
- **Web paneli** — ekipler için tasarlanmış, tarayıcıdaki aynı kullanıcı arayüzü.
- **CLI** — betiklerle ve CI ortamlarıyla kullanıma uygun komut satırı arayüzü.

Otomasyon ve araç entegrasyonu için ayrıca **REST API** ve **MCP** (yapay zekâ agent protokolü) sunulur. Tüm komut ve API başvuruları [openship.io/docs](https://openship.io/docs) adresindedir.

> [!NOTE]
> Belgeler hâlâ geliştirilmektedir. Eksik veya anlaşılmayan bir bölüm görürseniz [katkılarınızı](../../CONTRIBUTING.md) bekliyoruz.

---

## Durum

Temel özellikler canlı ortamda kullanıma hazırdır ve proje aktif olarak geliştirilmektedir.

**Sırada:** çok düğümlü kümeler, yük dengeleme arayüzü, özel ağlar, gelişmiş izleme ve görsel CI/CD işlem hatları.

---

## Katkıda Bulunma

[CONTRIBUTING.md](../../CONTRIBUTING.md) dosyasına bakın.

---

## Sürüm Yayınlama

Sürüm betiği tüm paketlerin sürümünü eşitler, değişikliği commitler, `vX.Y.Z` etiketi oluşturur ve gönderir:

```bash
bun scripts/release.ts 0.2.0        # açık sürüm numarası
# veya sürüm türü: patch | minor | major | rc   (0.1.x → 0.2.0 için minor)
```

Etiketin gönderilmesi [`.github/workflows/release.yml`](../../.github/workflows/release.yml) iş akışını tetikler. Bu iş akışı:

- **macOS, Windows ve Linux kurulum paketleri** ile sunucu arşivlerini ve SHA-256 dosyalarını oluşturur,
- npm [OIDC güvenilir yayınlama](https://docs.npmjs.com/trusted-publishers) üzerinden **`openship` CLI paketini npm'de yayımlar** ve
- oluşturulan dosyalarla bir **GitHub Release** yayımlar.

Bir sürümü uygulama içi güncelleyicide **kritik** olarak işaretlemek veya öneri/bilgi notları eklemek için etiket oluşturmadan önce [`release-advisories.json`](../../release-advisories.json) dosyasına kayıt ekleyin. Genel sürüm notları [`CHANGELOG.md`](../../CHANGELOG.md) dosyasındadır.

---

## Güvenlik

Bir güvenlik açığı mı buldunuz? Lütfen bunu herkese açık bir issue, PR veya tartışmada paylaşmayın; özel olarak bildirin.

- **Önerilen bildirim yöntemi:** [Güvenlik açığı bildir](https://github.com/oblien/openship/security/advisories/new) — yalnızca sizin ve bakımcıların görebildiği özel GitHub bildirimi.
- Kapsam, gerekli bilgiler ve açıklama süreci: [SECURITY.md](../../SECURITY.md).

İyi niyetli güvenlik araştırmaları [güvenli liman politikamız](../../SECURITY.md#safe-harbor) kapsamında yetkilidir. Geçerli bir açığı ilk bildiren kişiye memnuniyetle teşekkür ederiz.

---

## Lisans

Openship, [Apache License 2.0](../../LICENSE) kapsamında lisanslanan **açık kaynaklı** bir yazılımdır.

Apache 2.0 koşulları kapsamında ticari ve kapalı kaynaklı ürünler dâhil olmak üzere yazılımı kullanabilir, çalıştırabilir, değiştirebilir, kendi sunucunuzda barındırabilir ve dağıtabilirsiniz. Ayrıntılar için [LICENSE](../../LICENSE) dosyasına bakın.
