<h1 align="center">Openship</h1>

<p align="center" dir="rtl">منصة <strong><bdi dir="ltr">Open Source</bdi></strong> للنشر والاستضافة الذاتية مع <strong><bdi dir="ltr">CI/CD</bdi></strong> مدمج.<br>ادفع الـ <bdi dir="ltr">Code</bdi>، ابنِ الحاويات، وأدر بنيتك التحتية من تطبيق سطح المكتب أو لوحة التحكم عبر <bdi dir="ltr">Web</bdi> أو <strong><bdi dir="ltr">CLI</bdi></strong>.</p>

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
  <a href="README.ko.md"><img src="https://img.shields.io/badge/lang-한국어-555" alt="한국어" /></a>
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

وهذا كل ما تحتاجه للبدء.

أو، إذا كنت تفضل استخدام <strong><bdi dir="ltr">Docker</bdi></strong>:

```bash
git clone https://github.com/oblien/openship.git && cd openship
cp .env.example .env
docker compose up -d
```

كما يمكنك تنزيل تطبيق سطح المكتب من <a href="https://openship.io"><bdi dir="ltr">openship.io</bdi></a>.

---

## ما الذي يقدمه <bdi dir="ltr">Openship</bdi>؟

وجّه <bdi dir="ltr">Openship</bdi> إلى مستودعك، وسيكتشف التقنية المستخدمة، ويبني المشروع، ويهيئه للنشر تلقائيًا — دون الحاجة إلى ملفات إعداد، أو <strong><bdi dir="ltr">CI/CD pipelines</bdi></strong>، أو ملفات <strong><bdi dir="ltr">YAML</bdi></strong>.

كما يتيح لك إدارة قواعد البيانات، و<strong><bdi dir="ltr">Domains</bdi></strong>، وشهادات <strong><bdi dir="ltr">SSL</bdi></strong>، و<strong><bdi dir="ltr">CDN</bdi></strong>، والبريد الإلكتروني، والنسخ الاحتياطية من مكان واحد.

يعمل <bdi dir="ltr">Openship</bdi> مع <strong><bdi dir="ltr">Openship Cloud</bdi></strong> (خدمة مُدارة) أو على أي خادم <strong><bdi dir="ltr">Linux</bdi></strong> تملكه. سواء كنت مطورًا فرديًا تنشر مشاريعك، أو فريقًا يدير تطبيقات في بيئة الإنتاج، فستستخدم الأداة نفسها.

---

## الميزات

|                      |                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| <strong><bdi dir="ltr">CI/CD</bdi> مدمج</strong> | <strong><bdi dir="ltr">Push-to-deploy</bdi></strong>، و<strong><bdi dir="ltr">Preview Environments</bdi></strong>، وبيئات <strong><bdi dir="ltr">staging</bdi></strong> و<strong><bdi dir="ltr">production</bdi></strong>، مع <strong><bdi dir="ltr">Rollbacks</bdi></strong> |
| **أي تقنية**         | <bdi dir="ltr">Node.js، Python، Go، Rust، PHP، Ruby، Java، .NET، Docker</bdi>، و<strong><bdi dir="ltr">Monorepos</bdi></strong> |
| **الخدمات الخلفية**  | <bdi dir="ltr">Postgres، MySQL، MongoDB، Redis</bdi>، و<strong><bdi dir="ltr">Workers</bdi></strong>، و<bdi dir="ltr">WebSockets</bdi>، والتخزين |
| <strong><bdi dir="ltr">Domains</bdi> و<bdi dir="ltr">SSL</bdi></strong> | شهادات <bdi dir="ltr">Let's Encrypt</bdi> تلقائيًا، و<bdi dir="ltr">Wildcard Certificates</bdi>، وعدد غير محدود من النطاقات، مع تجديد تلقائي |
| <strong><bdi dir="ltr">CDN</bdi></strong> | <bdi dir="ltr">Edge Caching</bdi>، ودعم <bdi dir="ltr">HTTP/3</bdi>، وضغط <bdi dir="ltr">Brotli</bdi>، ومسح فوري للـ <bdi dir="ltr">Cache</bdi> |
| **خادم بريد**        | <bdi dir="ltr">SMTP</bdi> مدمج مع <bdi dir="ltr">DKIM وSPF وDMARC</bdi>، دون الحاجة إلى <bdi dir="ltr">Mailgun</bdi> أو <bdi dir="ltr">Amazon SES</bdi> |
| **النسخ الاحتياطية** | نسخ مجدولة تشمل قواعد البيانات ووحدات التخزين، مع استعادة بنقرة واحدة وإمكانية التصدير في أي وقت    |
| **المراقبة**         | سجلات البناء، ومقاييس الحاويات، واستهلاك الموارد تُعرض مباشرة                                       |
| **التوسع**           | <strong><bdi dir="ltr">Auto Scaling</bdi></strong> على <bdi dir="ltr">Openship Cloud</bdi>، مع جاهزية لدعم <strong><bdi dir="ltr">Multi-node</bdi></strong> في الاستضافة الذاتية |
| **قابلية النقل**     | يعتمد على حاويات <bdi dir="ltr">Docker</bdi> القياسية، مما يسهّل الانتقال بين مزودي الاستضافة |
| <strong><bdi dir="ltr">Docker Compose</bdi></strong> | انشر ملفات <bdi dir="ltr">Docker Compose</bdi> الحالية كما هي |

---

## انشر في أي مكان

* <strong><bdi dir="ltr">Openship Cloud</bdi></strong> — خدمة مُدارة بالكامل مع <strong><bdi dir="ltr">Auto Scaling</bdi></strong> ودون أي إعدادات معقدة.
* <strong>أي <bdi dir="ltr">VPS</bdi></strong> — مثل <bdi dir="ltr">Hetzner وDigitalOcean وLinode وOVH</bdi> وغيرها.
* **الخوادم المخصصة** — <bdi dir="ltr">Bare Metal</bdi> أو <bdi dir="ltr">Colocation</bdi> أو حتى <bdi dir="ltr">Homelab</bdi>.
* **عدة خوادم** — وزّع أحمال العمل بين أكثر من خادم بسهولة.

نفس الواجهة، بغض النظر عن مكان النشر.

---

## ثلاث طرق للاستخدام

* **تطبيق سطح المكتب** — واجهة رسومية متكاملة مع سجلات مباشرة وإدارة كاملة.
* <strong>لوحة التحكم عبر <bdi dir="ltr">Web</bdi></strong> — نفس التجربة من المتصفح، ومصممة للعمل الجماعي.
* <strong><bdi dir="ltr">CLI</bdi></strong> — مناسب للأتمتة وبيئات <bdi dir="ltr">CI</bdi>.

كما يوفر <bdi dir="ltr">Openship</bdi> واجهتي <strong><bdi dir="ltr">REST API</bdi></strong> و<strong><bdi dir="ltr">MCP (Model Context Protocol)</bdi></strong> لدعم الأتمتة والتكامل مع الأدوات الأخرى.

للاطلاع على جميع الأوامر ومرجع <bdi dir="ltr">API</bdi>، راجع <a href="https://openship.io/docs"><bdi dir="ltr">openship.io/docs</bdi></a>.

> **ملاحظة:** لا تزال الوثائق قيد التطوير. إذا وجدت أي جزء غير مكتمل أو غير واضح، فإن [مساهماتك](../../CONTRIBUTING.md) مرحب بها وستساعد في تحسين المشروع.

---

## الحالة

النواة الأساسية جاهزة للإنتاج، والمشروع يشهد تطويرًا نشطًا.

**قريبًا:** دعم <strong><bdi dir="ltr">Multi-node Clusters</bdi></strong>، وواجهة لإدارة <strong><bdi dir="ltr">Load Balancers</bdi></strong>، والشبكات الخاصة، والمراقبة المتقدمة، وواجهة مرئية لإدارة <strong><bdi dir="ltr">CI/CD Pipelines</bdi></strong>.

---

## المساهمة

راجع <a href="../../CONTRIBUTING.md"><bdi dir="ltr">CONTRIBUTING.md</bdi></a> لمعرفة كيفية المساهمة في المشروع.

---

## الترخيص

<bdi dir="ltr">Openship</bdi> مشروع **مفتوح المصدر** مرخص بموجب <a href="../../LICENSE"><bdi dir="ltr">Apache License 2.0</bdi></a>.

يمكنك استخدامه، وتشغيله، وتعديله، واستضافته، وإعادة توزيعه، بما في ذلك ضمن مشاريع تجارية أو مغلقة المصدر، وفقًا لشروط <strong><bdi dir="ltr">Apache License 2.0</bdi></strong>. راجع <a href="../../LICENSE"><bdi dir="ltr">LICENSE</bdi></a> للاطلاع على النص الكامل.

</div>
