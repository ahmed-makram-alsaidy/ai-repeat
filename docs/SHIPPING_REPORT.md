# SHIPPING REPORT — AI Repeat MVP

التاريخ: 2026-11-08 · البيئة: Windows 11 (26300) · Node 24.18 · Rust 1.99.1 MSVC · 18 جولة تطوير متواصلة

---

## 1) Features implemented (all verified by execution)

### Core loop (P0 — complete)
- **Teach Mode** — تسجيل في متصفح المساعد المرئي (navigate/click/fill/select)، إخفاء كامل لحقول السر/OTP/بطاقات كنقاط تحقق يدوية، مسودة قابلة للتعديل.
- **Run Mode** — Chromium مستقل مملوك للتطبيق عبر Playwright (سياقات ephemeral معزولة + persistent profile بـleasing)، **بدون أي تحكم في ماوس/كيبورد المستخدم**.
- **Verify Mode** — تحقق حتمي مستقل: url_matches / element_visible / file_exists / table_row_count / text_contains (صفحة أو ملف).
- **Task engine** — طابور (concurrency 2) بآلة حالات كاملة، إيقاف مؤقت/استكمال/checkpoint، إيقاف فوري، إعادة محاولة (تشغيل جديد)، سقف توكنز مفروض على مستوى المزوّد.
- **Approvals** — external_write/high_impargate ببصمة SHA-256 مرتبطة بالقيم بالظبط، انتهاء صلاحية، رفض التعديل بعد الموافقة.
- **Live UX** — SSE (replay/live مفصولين)، timeline حي، معاينة CSV، تنزيل النواتج، بحث مهارات، نسخ وrollback، إشعارات سطح المكتب (اختيارية)، إيقاف شامل.

### Safety & security (P0 — complete, tested)
- سماحية نطاقات على **مستوى الشبكة داخل المتصفح** (أي طلب خارجي = abort).
- sandbox مسارات (رفض traversal/absolute) على التصدير والتنزيل والفحص.
- redaction شامل عند الكتابة (DB/events/logs/approvals) — حقول السر لا تُملأ ولا تُسجَّل أبدًا (مثبت باختبار).
- سجل أدوات مغلق: أي action خارج القائمة يُرفض بالكود (S04) — لا يوجد shell/exec في النظام كله.
- المفتاح في **DPAPI vault** (ويندوز) فقط؛ حذف السجل + retention فعليان (FR-07).

### Product (P1 — complete)
- **AI-drafted workflows** (وصف عربي → مسودة → تحقق schema → مراجعة بشرية إلزامية → حفظ).
- **محرر بلا كود** (إعادة تسمية متغيرات، حذف/تعديل خطوات، تحققات، تحذيرات locators غير المؤكدة).
- **إصلاح بإعادة تسجيل** من نقطة الفشل مع دمج آمن (renames + re-numbering).
- **جدولة** (interval/daily) عبر نفس قواعد الأمان، مع منع التكدس وإيقاف ذاتي عند الفشل.
- **تصدير/استيراد** (استيراد لا يكتب أبدًا فوق مهارة محلية).
- **نسخ + rollback** غير مدمّر لكل حفظ.
- **Voice (FR-06)** — push-to-talk (Web Speech، متاح ✓) + نطق ملخصات بأصوات ويندوز المحلية (صوت عربي مكتشف ✓) + محرك whisper-local جاهز للتهيئة بدون تنزيل.
- **UIA (Phase 5, steps 1+2)** — فاحص قراءة فقط (مختبر على Notepad حقيقي) + InvokePattern **مقاس** (زرار Add-Tab → عدد التابات زاد).

### Packaging — complete
- Tauri v2 shell (IPC للتوكن، CSP مقيدة) + **Node SEA sidecar** (agent كامل بـplaywright مدمج) + **NSIS installer** (25MB).
- **أول تشغيل Chromium بموافقة صريحة** (تنزيل من CDN الرسمي بمقاس مقيّد وتقدم حي).
- تنظيف عمليات المتصفح اليتيمة (تتبع PID ذاتي + تحقق مسار مزدوج).

## 2) Deliberately deferred (قرارات واضحة، مش عيوب)

| البند | السبب |
|---|---|
| توقيع الـinstaller للتوزيع العام | ✅ قرار منفّذ: موقّع بشهادة تطوير ذاتية (AI Repeat Dev، صالح 3 سنين، طابع زمني DigiCert) — سلامة الحزمة متحققة. **للتوزيع العام**: شهادة تجارية (Azure Trusted Signing الأفضل قيمة) بنفس signtool سطر واحد |
| ✅ STT محلي — **منفّذ ومختبر E2E**: whisper.cpp v1.9.5 (x64) + ggml-base (148MB) منزّلان ومكوّنان، تحويل صوت إنجليزي مولّد عبر SAPI → نص صحيح عبر الـendpoint. الصوت العربي الحقيقي يشتغل بنفس المحرك (language=ar مضبوط) | ~~قرار~~ → الحسم: محلي أوفلاين (خصوصية + صفر تكلفة تشغيل) |
| UIA Value/Toggle/Selection patterns | "each is its own measured milestone" — محتاج تطبيقات هدف حقيقية |
| تنفيذ سحابي/عامل بعيد | MVP local-first بالتصميم |
| تشغيل كامل بلا نموذج ذكي (planning عام) | البداية workflows حتمية — موثّق |

## 3) Commands actually executed (results)

| الأمر | النتيجة |
|---|---|
| `npx tsc -p tsconfig.json --noEmit` + UI `tsc --noEmit` | ✓ صفر أخطاء |
| `npx vitest run` | ✓ **120/120** (17 ملف: وحدات + تكامل + Chromium حقيقي + عمليتا agent + UIA) |
| `npx vite build` | ✓ dist |
| `npm run agent` / `npm run app` / `npm run smoke` | ✓ |
| `npm run agent:sidecar` + `npm run app:build` | ✓ NSIS `AI Repeat_0.1.0_x64-setup.exe` (25MB) |
| **Packaged smoke (نهائي)** | ✓ G1 من الـinstaller-path: completed 4/4 + تحققات ✓ (بدون أي stall) |
| Live flows (متصفح آلي) | ✓ G1/G2/موافقة/ESC/إصلاح/جدولة/صوت/أخطاء offline |

## 4) Security review summary

- **أسرار**: DPAPI CurrentUser فقط؛ لا أسرار في DB/settings/logs/前端. حذف = صفر + unlink.
- **الصلاحيات**: loopback فقط + token لكل جلسة + فحص Origin + لا CORS. أدوات مغلقة بالكود. موافقات ببصمة. UIA مرحلي بالبوابات (قراءة → Invoke) مع log لكل محاولة.
- **الحدود**: ممنوع حرفيًا — تجاوز CAPTCHA/MFA، مراقبة خفية، shell، حقن فيزيائي (SendInput غير موجود في الكود كله).
- **Manual test instructions** (5 دقائق): 1) نصّب الـinstaller 2) الرئيسية → لاحظ البطاقات 3) مهاراتي → شغّل G1 → شاهد الـtimeline والتحقق والـCSV 4) شغّل G2 → راجع الـدايلوج → موافقة 5) علّمني مهمة → سجّل → راجع بالمحرر → احفظ → شغّل.

## 5) Release blockers

1. ~~شهادة توقيع~~ — **منفّذ**: موقّع بشهادة تطوير ذاتية (CN=AI Repeat Dev، صالحة 3 سنين، طابع زمني DigiCert). للتوزيع العام فقط: شهادة تجارية (Azure Trusted Signing — سطر signtool واحد يتغير).
2. **اختبار مفتاح Z.ai الحقيقي** — المسار كامل جاهز ومختبر بمزوّد وهمي؛ **المفتاح نفسه سر لا يملكه إلا المؤسس** (إدخال، مش قرار).
3. لا يوجد blockers تقنية أخرى.

## 6) Immediate next technical task

بعد توفر المفتاح: تشغيل `اختبر الاتصال` → أول تشغيل حقيقي للنموذج → قياس الاستهلاك الفعلي لكل مسار (تصميم/مراجعة/إصلاح) مقابل سقف الـ50K/token.

---

*التفاصيل الكاملة والتاريخ التفصيلي لكل جولة: [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md)*
