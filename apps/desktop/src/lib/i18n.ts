/**
 * AI Repeat — lightweight i18n (PRD: "Arabic first; English optional").
 * Dictionary-based; the language lives in settings (persisted server-side)
 * and also flips the document direction RTL/LTR.
 */
export type Lang = "ar" | "en";

const dict = {
  // Sidebar / navigation
  "nav.home": { ar: "الرئيسية", en: "Home" },
  "nav.assistant": { ar: "المساعد", en: "Assistant" },
  "nav.teach": { ar: "علّمني مهمة", en: "Teach a task" },
  "nav.skills": { ar: "مهاراتي", en: "My skills" },
  "nav.tasks": { ar: "المهام", en: "Tasks" },
  "nav.logs": { ar: "سجل التنفيذ", en: "Execution log" },
  "nav.settings": { ar: "الإعدادات", en: "Settings" },
  "nav.stopAll": { ar: "⛔ إيقاف الكل", en: "⛔ Stop all" },
  "nav.connected": { ar: "● متصل بالخدمة المحلية", en: "● Connected to local service" },
  "nav.disconnected": { ar: "○ غير متصل", en: "○ Disconnected" },

  // Home
  "home.title": { ar: "الرئيسية", en: "Home" },
  "home.tagline": {
    ar: "علّمه شغلك مرة، وخليه يشتغل معاك — في متصفح مستقل من غير ما يتحرك الماوس بتاعك.",
    en: "Teach it your task once, let it work with you — in a separate browser, without touching your mouse.",
  },
  "home.start": { ar: "ابدأ في 3 خطوات", en: "Start in 3 steps" },
  "home.step1": { ar: "متصفح التطبيق", en: "App browser" },
  "home.step1.ready": { ar: "جاهز", en: "ready" },
  "home.step1.missing": { ar: "مش متسطب — الإعدادات فيها التنزيل بموافقتك", en: "not installed — Settings has consent-based download" },
  "home.step2": { ar: "مفتاح النموذج", en: "Model API key" },
  "home.step2.set": { ar: "محفوظ", en: "saved" },
  "home.step2.missing": { ar: "مش مضبوط — الإعدادات → مفتاح API", en: "not set — Settings → API key" },
  "home.step2.optional": { ar: "(اختياري: المهارات بتشتغل من غير نموذج)", en: "(optional: skills run without a model)" },
  "home.step3": { ar: "أول تشغيل", en: "First run" },
  "home.step3.done": { ar: "اتعمل", en: "done" },
  "home.step3.todo": { ar: "— شغّل أي مهارة من «مهاراتي» وشوف التقرير", en: "— run any skill from My skills and see the report" },
  "home.teachNew": { ar: "علّمني مهمة جديدة", en: "Teach a new task" },
  "home.runSaved": { ar: "شغّل مهمة محفوظة", en: "Run a saved task" },
  "home.noApiKey": {
    ar: "مفيش مفتاح API محفوظ — الذهاب للإعدادات واختبر الاتصال قبل تشغيل مهام تعتمد على النموذج.",
    en: "No API key saved — go to Settings and test the connection before model-dependent tasks.",
  },
  "home.running": { ar: "مهام شغالة أو في الطابور", en: "Running or queued tasks" },
  "home.noneRunning": { ar: "مفيش مهام شغالة دلوقتي.", en: "No tasks running right now." },
  "home.kpi.completed": { ar: "تشغيلات مكتملة (محليًا)", en: "completed runs (locally)" },
  "home.kpi.attention": { ar: "مهام محتاجة انتباهك", en: "tasks needing attention" },
  "home.kpi.skills": { ar: "مهارات محفوظة", en: "saved skills" },
  "home.kpi.verifiedRate": { ar: "نسبة النجاح المتحقق", en: "verified success rate" },
  "home.kpi.avgRun": { ar: "متوسط زمن التشغيل", en: "avg run time" },
  "home.kpi.tokensPerRun": { ar: "توكنز لكل تشغيل موثق", en: "tokens per verified run" },
  "home.upcoming": { ar: "الجداول القادمة", en: "Upcoming schedules" },
  "home.nextRun": { ar: "التشغيل القادم", en: "Next run" },

  // States
  "state.queued": { ar: "في الطابور", en: "Queued" },
  "state.running": { ar: "قيد التنفيذ", en: "Running" },
  "state.awaiting_approval": { ar: "بانتظار موافقتك", en: "Awaiting your approval" },
  "state.paused": { ar: "متوقفة مؤقتًا", en: "Paused" },
  "state.verifying": { ar: "قيد التحقق", en: "Verifying" },
  "state.completed": { ar: "مكتملة", en: "Completed" },
  "state.failed": { ar: "فشلت", en: "Failed" },
  "state.cancelled": { ar: "ملغاة", en: "Cancelled" },

  // Tasks page
  "tasks.title": { ar: "المهام", en: "Tasks" },
  "tasks.subtitle": {
    ar: "كل التشغيلات السابقة والحالية مع حالتها الحقيقية — مفيش حالة نجاح مزيفة.",
    en: "All past and current runs with their real state — no fake success.",
  },
  "tasks.col.task": { ar: "المهمة", en: "Task" },
  "tasks.col.state": { ar: "الحالة", en: "State" },
  "tasks.col.steps": { ar: "الخطوات", en: "Steps" },
  "tasks.col.verify": { ar: "التحقق", en: "Verification" },
  "tasks.col.created": { ar: "أُنشئت", en: "Created" },
  "tasks.viewDetails": { ar: "عرض التفاصيل", en: "Details" },
  "tasks.back": { ar: "← كل المهام", en: "← All tasks" },
  "tasks.verificationPassed": { ar: "التحقق نجح", en: "Verification passed" },
  "tasks.verificationFailed": { ar: "التحقق فشل", en: "Verification failed" },
  "tasks.pause": { ar: "إيقاف مؤقت", en: "Pause" },
  "tasks.resume": { ar: "استكمال", en: "Resume" },
  "tasks.stopNow": { ar: "إيقاف فورًا", en: "Stop now" },
  "tasks.retry": { ar: "إعادة المحاولة (تشغيل جديد)", en: "Retry (new run)" },
  "tasks.recordFromHere": { ar: "سجّل من هنا", en: "Re-record from here" },
  "tasks.steps": { ar: "الخطوات", en: "Steps" },
  "tasks.verificationReport": { ar: "تقرير التحقق", en: "Verification report" },
  "tasks.results": { ar: "النتائج", en: "Results" },
  "tasks.downloadOutput": { ar: "تنزيل الملف الناتج", en: "Download output file" },
  "tasks.preview10": { ar: "عرض أول 10 صفوف", en: "Show first 10 rows" },
  "tasks.inputsSanitized": { ar: "المدخلات (مُنقّاة)", en: "Inputs (sanitized)" },
  "tasks.attempt": { ar: "محاولة", en: "attempt" },
  "tasks.shotOfFailure": { ar: "لقطة الفشل", en: "Failure shot" },

  // Skills page
  "skills.title": { ar: "مهاراتي", en: "My skills" },
  "skills.subtitle": {
    ar: "المهارات المحفوظة على جهازك — كل مهارة نسخة قابلة للتعديل والتصدير.",
    en: "Skills saved on your machine — each is an editable, exportable version.",
  },
  "skills.import": { ar: "استيراد مهارة (ملف JSON)", en: "Import skill (JSON file)" },
  "skills.search": { ar: "ابحث بالاسم أو الوصف…", en: "Search by name or description…" },
  "skills.details": { ar: "التفاصيل والتشغيل", en: "Details & run" },
  "skills.hideDetails": { ar: "إخفاء التفاصيل", en: "Hide details" },
  "skills.edit": { ar: "تعديل", en: "Edit" },
  "skills.export": { ar: "تصدير", en: "Export" },
  "skills.run": { ar: "شغّل", en: "Run" },
  "skills.version": { ar: "نسخة", en: "version" },
  "skills.domains": { ar: "النطاقات المسموحة", en: "Allowed domains" },
  "skills.runInputs": { ar: "مدخلات التشغيل", en: "Run inputs" },
  "skills.schedule": { ar: "التشغيل المجدول", en: "Scheduled runs" },
  "skills.scheduleNote": {
    ar: "بيشتغل بس والتطبيق مفتوح على الجهاز — الموافقات والتحققات بتنطبق زي أي تشغيل.",
    en: "Runs only while the app is open — approvals and verification apply as with any run.",
  },
  "skills.enableSchedule": { ar: "+ فعّل الجدولة", en: "+ Enable schedule" },
  "skills.prevVersions": { ar: "النسخ السابقة", en: "Previous versions" },
  "skills.hideVersions": { ar: "إخفاء النسخ السابقة", en: "Hide versions" },
  "skills.restore": { ar: "استرجع", en: "Restore" },
  "skills.noSkills": {
    ar: "مفيش مهارات محفوظة — ابدأ من «علّمني مهمة» أو استورد ملف.",
    en: "No skills saved — start from Teach or import a file.",
  },
  "skills.noResults": { ar: "مفيش نتائج للبحث ده.", en: "No search results." },
  "skills.everyN": { ar: "كل فترة محددة", en: "Every fixed interval" },
  "skills.daily": { ar: "يوميًا في وقت", en: "Daily at time" },
  "skills.minutes": { ar: "دقيقة", en: "min" },
  "skills.scheduleOff": { ar: "موقوف", en: "off" },
  "skills.scheduleToggleOn": { ar: "تشغيل الجدولة", en: "Enable schedule" },
  "skills.scheduleToggleOff": { ar: "إيقاف الجدولة", en: "Disable schedule" },
  "skills.delete": { ar: "حذف", en: "Delete" },

  // Teach page
  "teach.title": { ar: "علّمني مهمة", en: "Teach a task" },
  "teach.subtitle": { ar: "هنستخدم متصفح المساعد، مش الماوس بتاعك.", en: "We'll use the assistant's browser, not your mouse." },
  "teach.start": { ar: "ابدأ التسجيل", en: "Start recording" },
  "teach.stop": { ar: "وقف التسجيل", en: "Stop recording" },
  "teach.recording": { ar: "التسجيل شغّال — نفّذ الخطوات في متصفح المساعد اللي فتح. لما تخلص اضغط وقف التسجيل.", en: "Recording — perform the steps in the opened assistant browser, then press Stop." },

  // Assistant page
  "assistant.title": { ar: "المساعد", en: "Assistant" },
  "assistant.placeholder": {
    ar: "قولّي عايزني أعمل إيه... زي: افتح لوحة المنتجات وطلّعلي الأصناف اللي ناقصة صور",
    en: "Tell me what to do… e.g. open the products dashboard and list items missing images",
  },
  "assistant.describe": { ar: "وصف المهمة (عربي أو إنجليزي)", en: "Task description (Arabic or English)" },
  "assistant.propose": { ar: "اقترح خطة", en: "Propose a plan" },
  "assistant.generateDraft": { ar: "ولّد مسودة مهارة من الوصف", en: "Generate a skill draft" },
  "assistant.generating": { ar: "جاري التوليد…", en: "Generating…" },
  "assistant.chipScope": { ar: "النطاق المسموح", en: "Allowed scope" },
  "assistant.chipSteps": { ar: "الخطوات المتوقعة: 3–5", en: "Expected steps: 3–5" },
  "assistant.chipRisk": { ar: "المخاطر: قراءة/كتابة محلية", en: "Risks: read/local write" },

  // Logs page
  "logs.title": { ar: "سجل التنفيذ", en: "Execution log" },
  "logs.subtitle": {
    ar: "إيه اللي اتنفذ وامتى — القيم الحساسة منقّاة قبل التخزين والعرض.",
    en: "What ran and when — sensitive values redacted before storage and display.",
  },
  "logs.export": { ar: "تنزيل تقرير تشخيص مُنقّى", en: "Download redacted diagnostics" },
  "logs.clear": { ar: "امسح السجل", en: "Clear log" },
  "logs.col.time": { ar: "الوقت", en: "Time" },
  "logs.col.event": { ar: "الحدث", en: "Event" },
  "logs.col.task": { ar: "المهمة", en: "Task" },
  "logs.col.step": { ar: "الخطوة", en: "Step" },
  "logs.col.details": { ar: "تفاصيل", en: "Details" },

  // Settings page
  "settings.title": { ar: "الإعدادات", en: "Settings" },
  "settings.subtitle": { ar: "الاتصال بالنموذج، المساحات المسموحة، وحدود الأمان.", en: "Model connection, allowed scopes, and safety limits." },
  "settings.model": { ar: "اتصال النموذج", en: "Model connection" },
  "settings.provider": { ar: "المزود", en: "Provider" },
  "settings.modelId": { ar: "معرّف الموديل", en: "Model ID" },
  "settings.baseUrl": { ar: "Base URL", en: "Base URL" },
  "settings.timeout": { ar: "المهلة (ثواني)", en: "Timeout (s)" },
  "settings.saveModel": { ar: "احفظ الإعدادات", en: "Save settings" },
  "settings.apiKey": { ar: "مفتاح API", en: "API key" },
  "settings.keySaved": { ar: "مفتاح محفوظ ✓ (مخفي)", en: "Key saved ✓ (hidden)" },
  "settings.noKey": { ar: "مفيش مفتاح محفوظ", en: "No key saved" },
  "settings.keyPlaceholder": { ar: "الصق المفتاح هنا — مش هيُخزن في أي مكان تاني", en: "Paste the key — it is stored nowhere else" },
  "settings.saveKey": { ar: "احفظ المفتاح", en: "Save key" },
  "settings.testConnection": { ar: "اختبر الاتصال", en: "Test connection" },
  "settings.testing": { ar: "جاري الاختبار…", en: "Testing…" },
  "settings.voice": { ar: "الصوت (اختياري)", en: "Voice (optional)" },
  "settings.sttEngine": { ar: "محرك الإدخال الصوتي (STT)", en: "Speech-to-text engine" },
  "settings.stt.builtin": { ar: "مدمج (Web Speech)", en: "Built-in (Web Speech)" },
  "settings.stt.whisper": { ar: "whisper محلي", en: "Local whisper" },
  "settings.stt.none": { ar: "بدون", en: "None" },
  "settings.stt.binPath": { ar: "مسار whisper-cli.exe", en: "whisper-cli.exe path" },
  "settings.stt.modelPath": { ar: "مسار الموديل (ggml .bin)", en: "Model path (ggml .bin)" },
  "settings.saveStt": { ar: "احفظ محرك الصوت", en: "Save voice engine" },
  "settings.sttNote": {
    ar: "whisper المحلي بيشتغل أوفلاين تمامًا — بتنزّله مرة واحدة من المستودع الرسمي (ggml-base يكفي للبداية، ggml-small أدق للعربي).",
    en: "Local whisper runs fully offline — download once from the official repo (ggml-base to start, ggml-small is more accurate for Arabic).",
  },
  "settings.sttToggle": { ar: "إدخال صوتي (اضغط وتكلم) في المساعد", en: "Voice input (push-to-talk) in Assistant" },
  "settings.ttsToggle": { ar: "نطق ملخص عند انتهاء المهمة (أصوات ويندوز المحلية)", en: "Speak a summary when a task ends (local Windows voices)" },
  "settings.notifications": { ar: "إشعارات سطح المكتب", en: "Desktop notifications" },
  "settings.notifyToggle": { ar: "إشعار عند انتهاء كل مهمة (اكتمال/فشل/إلغاء)", en: "Notify when each task ends (done/failed/cancelled)" },
  "settings.notifyPermission": { ar: "الصلاحية", en: "Permission" },
  "settings.backup": { ar: "نسخة احتياطية واستعادة", en: "Backup & restore" },
  "settings.backupDownload": { ar: "نزّل النسخة الاحتياطية", en: "Download backup" },
  "settings.backupRestore": { ar: "استعادة من ملف", en: "Restore from file" },
  "settings.uia": { ar: "أتمتة ويندوز — تجريبي (المرحلة 5، خطوة 1)", en: "Windows automation — experimental (Phase 5, step 1)" },
  "settings.uiaToggle": { ar: "فعّل الفاحص التجريبي (قراءة فقط — بموافقتك)", en: "Enable the experimental inspector (read-only — with your consent)" },
  "settings.evidence": { ar: "الأدلة والاحتفاظ", en: "Evidence & retention" },
  "settings.screenshotToggle": {
    ar: "حفظ لقطة شاشة عند فشل خطوة (اختياري — جوه مساحة عمل التطبيق فقط، بتتحذف تلقائيًا بعد مدة الاحتفاظ)",
    en: "Save a screenshot when a step fails (optional — inside the app workspace only, auto-deleted after retention)",
  },
  "settings.retention": { ar: "مدة الاحتفاظ (يوم)", en: "Retention (days)" },
  "settings.security": { ar: "الأمان والخصوصية", en: "Security & privacy" },
  "settings.knownLimits": { ar: "حدود معروفة (بشفافية)", en: "Known limits (transparently)" },

  // Editor
  "editor.review": { ar: "راجع وعدّل الخطوات", en: "Review & edit steps" },
  "editor.name": { ar: "اسم المهارة", en: "Skill name" },
  "editor.variables": { ar: "المتغيرات", en: "Variables" },
  "editor.noVariables": { ar: "مفيش متغيرات — القيم ثابتة زي ما اتسجلت.", en: "No variables — values are fixed as recorded." },
  "editor.steps": { ar: "الخطوات", en: "Steps" },
  "editor.verifications": { ar: "التحققات", en: "Verifications" },
  "editor.addVerify": { ar: "+ ضيف تحقق", en: "+ Add verification" },
  "editor.save": { ar: "احفظ المهارة", en: "Save skill" },
  "editor.discard": { ar: "استبعد", en: "Discard" },
  "editor.advancedJson": { ar: "متقدم: تعديل JSON", en: "Advanced: edit JSON" },
  "editor.hideJson": { ar: "إخفاء JSON", en: "Hide JSON" },
  "editor.needsVerify": { ar: "ضيف تحقق واحد على الأقل قبل الحفظ.", en: "Add at least one verification before saving." },
  "editor.summary": { ar: "الوصف اللي يظهر في السجل", en: "Description shown in the log" },
  "editor.newName": { ar: "اسم جديد (اختياري)", en: "New name (optional)" },
  "editor.delete": { ar: "حذف", en: "Delete" },

  // Approvals
  "approval.title": { ar: "محتاج موافقتك قبل الخطوة دي", en: "I need your approval before this step" },
  "approval.approve": { ar: "موافق على الخطوة دي", en: "Approve this step" },
  "approval.reject": { ar: "رفض", en: "Reject" },
  "approval.highRisk": {
    ar: "خطوة خارجية قد تحدث أثرًا على موقع حقيقي — اتأكد من التفاصيل قبل الموافقة.",
    en: "An external step that may affect a real site — verify the details before approving.",
  },

  // Assistant details
  "assistant.planReview": { ar: "الخطة المقترحة — راجعها قبل التنفيذ", en: "Proposed plan — review before running" },
  "assistant.draftNote": {
    ar: "المسودة بتفتح في المحرر للمراجعة — بتتحفظ بعد مراجعتك وبموافقات التشغيل زي أي مهارة.",
    en: "The draft opens in the editor for review — saved after your review with the same runtime approvals.",
  },
  "assistant.chipScopeLabel": { ar: "النطاق المسموح: ", en: "Allowed scope: " },

  // Skills details
  "skills.description": { ar: "الوصف", en: "Description" },

  // Tasks detail
  "tasks.pauseBtn": { ar: "إيقاف مؤقت", en: "Pause" },
  "tasks.resumeBtn": { ar: "استكمال", en: "Resume" },

  // Settings sections
  "settings.modelNotice": {
    ar: "لما تستخدم نموذج خارجي، جزء من نص المهمة (مش كلمات السر ولا الكوكيز) ممكن يتبعت لمزود النموذج. المفتاح محفوظ في مخزن بيانات اعتماد ويندوز (DPAPI) — مش في قاعدة البيانات ولا في المتصفح.",
    en: "When using an external model, part of the task text (not passwords or cookies) may be sent to the model provider. The key is stored in Windows DPAPI credential vault — not in the database or browser.",
  },
  "settings.sttToggleNote": {
    ar: "محرك التعرف: ",
    en: "Recognition engine: ",
  },
  "settings.sttAvailable": { ar: "متاح في النافذة دي ✓", en: "available in this window ✓" },
  "settings.sttUnavailable": { ar: "غير متاح في النافذة دي — الزر مش هيظهر", en: "unavailable in this window — button won't appear" },
  "settings.uiaNote": {
    ar: "قراءة فقط: عرض النوافذ وعناصرها كقائمة معلومات. لا يوجد في التطبيق أي كود يبعت نقرات أو كتابة لويندوز — المرحلة دي استكشافية بوضوح ومفصولة عن أتمتة المتصفح.",
    en: "Read-only: view windows and their elements as an information list. The app contains no code that sends clicks or typing to Windows — this phase is clearly experimental and separate from browser automation.",
  },
  "settings.securityItems": {
    ar: "مساحة العمل المسموحة للملفات|النطاقات المسموحة|حد الخطوات لكل مهمة|حد التوكنز لكل مهمة|مدة الاحتفاظ بلقطات الشاشة (اختيارية) — لقطات الشاشة مطفأة افتراضيًا|الاستهلاك المُقاس من المزود",
    en: "Allowed file workspace|Allowed domains|Max steps per task|Token budget per task|Screenshot retention (optional) — screenshots off by default|Provider-reported usage",
  },
  "settings.knownLimitItems": {
    ar: "التطبيق مش بيتحكم في ماوس/كيبورد ويندوز — أتمتة المتصفح فقط|المهام شغالة بس والجهاز شغّال — مفيش تنفيذ سحابي في النسخة دي|التسجيل الصوتي مش مفعّل في النسخة دي (Feature flag مطفي)|مش بنتجاوز CAPTCHA أو MFA — لو ظهرت هتطلب منك تدخل بنفسك",
    en: "The app does not control Windows mouse/keyboard — browser automation only|Tasks run only while the device is on — no cloud execution in this version|Voice recording is not enabled (feature flag off)|Does not bypass CAPTCHA or MFA — manual handoff when they appear",
  },
  "settings.language": { ar: "Language / اللغة", en: "Language / اللغة" },

  // Editor
  "editor.newNamePh": { ar: "اسم جديد (اختياري)", en: "New name (optional)" },
  "editor.logDesc": { ar: "الوصف اللي يظهر في السجل", en: "Description shown in the log" },
  "editor.convertVar": { ar: "حوّلها لمتغير", en: "Convert to variable" },
  "editor.advanced": { ar: "متقدم: تعديل JSON", en: "Advanced: edit JSON" },
  "editor.hideAdv": { ar: "إخفاء JSON", en: "Hide JSON" },

} as const;

export type StringKey = keyof typeof dict;

export function t(lang: Lang, key: StringKey): string {
  const entry = dict[key];
  return entry ? entry[lang] : key;
}

export function applyDirection(lang: Lang): void {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
}
