<h1 align="center">Openship</h1>

<p align="center">
  منصّة نشر مفتوحة المصدر وقابلة للاستضافة الذاتية مع CI/CD مدمج.<br>
  ادفع الكود، اشحن الحاويات، وأدر البنية التحتية — من تطبيق سطح المكتب أو لوحة التحكم على الويب أو سطر الأوامر.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/openship"><img src="https://img.shields.io/npm/v/openship?color=0b7285&label=npm" alt="npm version" /></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License" /></a>
  <a href="https://openship.io"><img src="https://img.shields.io/badge/website-openship.io-0b7285" alt="Website" /></a>
</p>

<p align="center">
  <a href="../../README.md"><img src="https://img.shields.io/badge/lang-English-555" alt="English" /></a>
  <a href="README.ar.md"><img src="https://img.shields.io/badge/lang-العربية-0b7285" alt="العربية" /></a>
  <a href="README.zh.md"><img src="https://img.shields.io/badge/lang-简体中文-555" alt="简体中文" /></a>
  <a href="README.es.md"><img src="https://img.shields.io/badge/lang-Español-555" alt="Español" /></a>
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

<div dir="rtl">

## البدء السريع

```bash
npm i -g openship
openship init
```

هذا كل شيء. أو، إن كنت تفضّل Docker:

```bash
git clone https://github.com/oblien/openship.git && cd openship
cp .env.example .env
docker compose up -d
```

أو نزّل تطبيق سطح المكتب من [openship.io](https://openship.io).

---

## ماذا يفعل

وجّهه إلى مستودع. يكتشف Openship تقنياتك، ويبنيها، ويضبط كل شيء، ويشحنها — بدون ملفات إعداد، بدون خطوط أنابيب، بدون YAML.

قواعد البيانات، النطاقات، SSL، CDN، البريد، النسخ الاحتياطية — كلها تُدار من مكان واحد.

يعمل مع **Openship Cloud** (مُدارة) أو **أي خادم Linux** تملكه. المطورون الأفراد الذين يشحنون مشاريع جانبية والفرق التي تُشغّل الإنتاج يستخدمون الأداة نفسها.

---

## الميزات

| | |
|---|---|
| **CI/CD مدمج** | نشر بالدفع، بيئات معاينة، تدفقات staging/prod، التراجعات |
| **أي تقنية** | Node، Python، Go، Rust، PHP، Ruby، Java، ‎.NET‎، Docker، المستودعات الأحادية |
| **خلفية كاملة** | Postgres، MySQL، MongoDB، Redis، العمال، WebSockets، التخزين |
| **النطاقات وSSL** | Let's Encrypt تلقائي، أحرف البدل، نطاقات غير محدودة، تجديد تلقائي |
| **CDN** | تخزين مؤقت طرفي، HTTP/3، ضغط Brotli، مسح فوري |
| **خادم بريد** | SMTP مدمج مع DKIM/SPF/DMARC — دون الحاجة إلى Mailgun أو SES |
| **النسخ الاحتياطية** | مجدولة، قواعد بيانات + وحدات تخزين، استعادة بنقرة واحدة، تصدير في أي وقت |
| **مراقبة فورية** | سجلات بناء حيّة، مقاييس الحاويات، واستخدام الموارد يُبثّ إلى شاشتك |
| **التوسّع** | توسّع تلقائي على السحابة، جاهز لتعدد العقد على الاستضافة الذاتية |
| **قابلية النقل** | حاويات Docker قياسية — انتقل بين المزودين بحرية |
| **Docker Compose** | انشر ملفات compose الحالية كما هي |

---

## انشر في أي مكان

- **Openship Cloud** — مُدارة، توسّع تلقائي، بدون إعداد
- **أي VPS** — Hetzner، DigitalOcean، Linode، OVH، وغيرها
- **خوادم مخصّصة** — معدن خام، colocation، مختبر منزلي
- **متعدد الخوادم** — وزّع الأحمال عبر الأجهزة

الواجهة نفسها بغضّ النظر عن مكان النشر.

---

## ثلاث واجهات

- **تطبيق سطح المكتب** — واجهة رسومية كاملة، سجلات فورية، كل شيء بنقرة واحدة.
- **لوحة التحكم على الويب** — الواجهة نفسها في المتصفح، مبنية للفرق.
- **سطر الأوامر (CLI)** — قابل للبرمجة وملائم لـ CI.

تُكمل **واجهة REST API** و**MCP** (بروتوكول وكلاء الذكاء الاصطناعي) المنظومة للأتمتة وتكامل الأدوات. مرجع الأوامر وواجهة البرمجة الكامل على [openship.io/docs](https://openship.io/docs).

> **ملاحظة:** لا تزال الوثائق قيد التطوير — نعمل بنشاط على استكمالها. إن وجدت شيئًا ناقصًا أو غير واضح، فإن [المساهمات](../../CONTRIBUTING.md) مُرحّب بها جدًا وتساعدنا على الوصول أسرع.

---

## الحالة

نواة جاهزة للإنتاج، قيد التطوير النشط.

**قادم قريبًا:** عناقيد متعددة العقد، واجهة موازنة الأحمال، الشبكات الخاصة، المراقبة المتقدمة، وخطوط أنابيب CI/CD مرئية.

---

## المساهمة

راجع [CONTRIBUTING.md](../../CONTRIBUTING.md).

---

## الترخيص

Openship برنامج **مفتوح المصدر**، مُرخّص بموجب [رخصة Apache 2.0](../../LICENSE).

يمكنك استخدامه وتشغيله وتعديله واستضافته وتوزيعه — بما في ذلك في المنتجات التجارية ومغلقة المصدر — بموجب شروط رخصة Apache 2.0. راجع [LICENSE](../../LICENSE) للنص الكامل.

</div>
