/**
 * privacy content — RECOVERY-GENERATED from the audited old-shape
 * document (privacyContent) by scripts/rebuild-legal-content.ts.
 * The TEXT is the reviewed copy — NOT rewritten, only reshaped
 * into the paired-locale LegalDocumentContent model.
 */
import type { LegalDocumentContent } from "./types";

export const privacyContent: LegalDocumentContent = {
  key: "privacy",
  title: { en: "Privacy Policy", fa: "سیاست حریم خصوصی" },
  intro: [
    { en: "How AI Business Copilot collects, uses, stores and deletes data — written from the actual behavior of the service.", fa: "نحوهٔ جمع‌آوری، استفاده، ذخیره و حذف داده‌ها در دستیار هوشمند کسب‌وکار — بر اساس رفتار واقعی سرویس نوشته شده است." },
  ],
  sections: [
    {
      id: "scope",
      heading: { en: "Scope", fa: "دامنه" },
      paragraphs: [
        { en: "This policy explains how AI Business Copilot (\"the service\") handles data when you create an account, run a business workspace on the service, or use its AI features. It describes the service as it actually behaves today. Where something is not configured, this policy says so instead of making an assumption.", fa: "این سیاست توضیح می‌دهد که «دستیار هوشمند کسب‌وکار» («سرویس») هنگام ساخت حساب، راه‌اندازی فضای کاری کسب‌وکار یا استفاده از قابلیت‌های هوش مصنوعی با داده‌ها چگونه رفتار می‌کند. این سند رفتار واقعی سرویس را امروز توصیف می‌کند؛ هر جا چیزی پیکربندی نشده باشد، به‌جای حدس زدن همان واقعیت گفته می‌شود." },
        { en: "This document is provided for transparency. It is not legal advice, and it does not claim any compliance certification (such as GDPR, CCPA, SOC 2 or ISO 27001). Where a qualified legal review is still required, the service treats that review as open.", fa: "این سند برای شفافیت ارائه شده است. مشاورهٔ حقوقی نیست و هیچ ادعای انطباق با گواهینامه‌هایی مانند GDPR یا CCPA یا SOC 2 یا ISO 27001 ندارد. هر جا بازبینی حقوقیِ واجد شرایط لازم باشد، سرویس آن بازبینی را باز در نظر می‌گیرد." },
      ],
    },
    {
      id: "definitions",
      heading: { en: "Definitions", fa: "تعاریف" },
      bullets: [
        { en: "\"You\" means the person who registers an account.", fa: "«شما» یعنی شخصی که حساب می‌سازد." },
        { en: "\"Business workspace\" (or \"business\") means the tenant workspace you create or join, which holds your commercial records.", fa: "«فضای کاری کسب‌وکار» (یا «کسب‌وکار») یعنی فضای کاری‌ای که می‌سازید یا به آن دعوت می‌شوید و سوابق تجاری شما در آن نگه‌داری می‌شود." },
        { en: "\"Business data\" means the records you and your team store in a business workspace: customers, suppliers, products, inventory, sales, expenses and payments.", fa: "«داده‌های کسب‌وکار» یعنی رکوردهایی که شما و تیم‌تان در فضای کاری ثبت می‌کنید: مشتریان، تأمین‌کنندگان، محصولات، موجودی، فروش، هزینه‌ها و پرداخت‌ها." },
        { en: "\"AI content\" means the questions you type into the AI copilot and the answers it produces.", fa: "«محتوای هوش مصنوعی» یعنی پرسش‌هایی که در دستیار هوشمند می‌نویسید و پاسخ‌هایی که تولید می‌شود." },
        { en: "\"Operator\" means the entity that runs the service. The operator's legal identity and contact channels are shown in the Contact section based on current configuration.", fa: "«بهره‌بردار» یعنی نهادی که سرویس را اداره می‌کند. هویت حقوقی بهره‌بردار و کانال‌های تماس بر اساس پیکربندی فعلی در بخش «اطلاعات تماس» نمایش داده می‌شود." },
      ],
    },
    {
      id: "data-we-collect",
      heading: { en: "Data We Collect", fa: "داده‌هایی که جمع‌آوری می‌کنیم" },
      paragraphs: [
        { en: "The service collects only the data needed to run its features. There is no third-party advertising or tracking. The categories are:", fa: "سرویس فقط داده‌های لازم برای کارکرد قابلیت‌هایش را جمع‌آوری می‌کند. هیچ تبلیغات یا ردیابی شخص ثالثی وجود ندارد. دسته‌ها این‌ها هستند:" },
        { en: "The service does not collect identity documents, payment card numbers, precise location, or any data from your device beyond what is listed above.", fa: "سرویس سند هویتی، شمارهٔ کارت بانکی، موقعیت دقیق جغرافیایی یا داده‌ای فراتر از فهرست بالا از دستگاه شما جمع‌آوری نمی‌کند." },
      ],
      bullets: [
        { en: "Category: Account data — Examples: Name, email address, language preference — Provided by: You", fa: "دسته: داده‌های حساب — نمونه‌ها: نام، نشانی ایمیل، زبان انتخابی — منبع: شما" },
        { en: "Category: Credentials — Examples: Password (stored only as a bcrypt hash), session version counter, two-factor authentication data if you enable it (an encrypted TOTP secret and hashed recovery codes) — Provided by: Generated from your input", fa: "دسته: اعتبارنامه‌ها — نمونه‌ها: رمز عبور (فقط به‌صورت هش bcrypt)، شمارندهٔ نسخهٔ نشست — منبع: از ورودی شما تولید می‌شود" },
        { en: "Category: Business data — Examples: Customers, suppliers, products, sales, expenses, payments, inventory — Provided by: You and your team", fa: "دسته: داده‌های کسب‌وکار — نمونه‌ها: مشتریان، تأمین‌کنندگان، محصولات، فروش، هزینه‌ها، پرداخت‌ها، موجودی — منبع: شما و تیم شما" },
        { en: "Category: AI content — Examples: Copilot questions and answers, per-business AI conversations — Provided by: You and the AI feature", fa: "دسته: محتوای هوش مصنوعی — نمونه‌ها: پرسش و پاسخ‌های دستیار، گفت‌وگوهای هوش مصنوعی هر کسب‌وکار — منبع: شما و قابلیت هوش مصنوعی" },
        { en: "Category: AI usage metadata — Examples: Provider/model identifiers and token counts reported for a request — Provided by: Generated by the service", fa: "دسته: فرادادهٔ مصرف هوش مصنوعی — نمونه‌ها: شناسهٔ ارائه‌دهنده/مدل و تعداد توکنِ گزارش‌شدهٔ هر درخواست — منبع: توسط سرویس تولید می‌شود" },
        { en: "Category: Billing data — Examples: Plan, subscription status, trial and checkout records — Provided by: Generated by the service", fa: "دسته: داده‌های صورتحساب — نمونه‌ها: پلن، وضعیت اشتراک، سوابق دورهٔ آزمایشی و پرداخت — منبع: توسط سرویس تولید می‌شود" },
        { en: "Category: Security data — Examples: IP address and user-agent recorded on authentication, verification and password-reset events; device session entries (device label, hashed IP, last-active time); security activity events; audit log entries — Provided by: Generated by the service", fa: "دسته: داده‌های امنیتی — نمونه‌ها: نشانی IP و عامل کاربر ثبت‌شده در رخدادهای ورود و بازیابی رمز؛ رکوردهای ممیزی — منبع: توسط سرویس تولید می‌شود" },
        { en: "Category: Product analytics — Examples: First-party commercial events (for example \"signup completed\"), linked to an anonymous cookie key and, when you are signed in, to your account — Provided by: Generated by the service", fa: "دسته: تحلیل محصول — نمونه‌ها: رخدادهای تجاری first-party (مثلاً «ثبت‌نام کامل شد») مرتبط با کلید ناشناس کوکی و در صورت ورود، با حساب شما — منبع: توسط سرویس تولید می‌شود" },
        { en: "Category: Preferences — Examples: Theme and sidebar state stored in your browser — Provided by: Your browser/local storage", fa: "دسته: ترجیحات — نمونه‌ها: حالت نمایش و وضعیت نوار کناری در مرورگر شما — منبع: مرورگر/حافظهٔ محلی شما" },
      ],
    },
    {
      id: "business-data",
      heading: { en: "Business Data May Contain Personal Data", fa: "داده‌های کسب‌وکار ممکن است دادهٔ شخصی باشند" },
      paragraphs: [
        { en: "Business data is recorded under a business workspace, but it is not automatically \"non-personal\". A customer, supplier or team member record can contain natural persons' names, emails or phone numbers. You control that content; this policy describes how the service stores and protects it, not what you may do with it.", fa: "داده‌های کسب‌وکار زیر یک فضای کاری ثبت می‌شوند، اما لزوماً «غیرشخصی» نیستند. رکورد یک مشتری یا تأمین‌کننده یا هم‌تیمی می‌تواند شامل نام و ایمیل یا شمارهٔ تماس افراد حقیقی باشد. مدیریت آن محتوا با شماست؛ این سیاست توضیح می‌دهد سرویس آن را چگونه ذخیره و محافظت می‌کند، نه اینکه شما با آن چه می‌توانید بکنید." },
        { en: "Team members you invite see the business workspace they are invited to, under role-based permissions. They do not see your other businesses or your account details beyond the name and email shown in the member list.", fa: "هم‌تیمی‌هایی که دعوت می‌کنید فقط فضای کاری مربوطه را با مجوزهای نقش‌محور می‌بینند؛ کسب‌وکارهای دیگر شما و جزئیات حساب شما فراتر از نام و ایمیلِ نمایش‌داده‌شده در فهرست اعضا برای آن‌ها قابل مشاهده نیست." },
      ],
    },
    {
      id: "how-we-use-data",
      heading: { en: "How We Use Data", fa: "چگونه از داده‌ها استفاده می‌کنیم" },
      paragraphs: [
        { en: "The service does not sell data, does not run advertising, and does not send marketing email. The only email the service sends (when email delivery is configured) is transactional, such as a password-reset message.", fa: "سرویس داده نمی‌فروشد، تبلیغات اجرا نمی‌کند و ایمیل بازاریابی نمی‌فرستد. تنها ایمیلِ سرویس (وقتی ارسال ایمیل پیکربندی شده باشد) تراکنشی است، مانند پیام بازیابی رمز عبور." },
      ],
      bullets: [
        { en: "To provide the service: authenticate you, store your business records, produce reports and dashboards.", fa: "برای ارائهٔ سرویس: احراز هویت شما، ذخیرهٔ سوابق کسب‌وکار، تولید گزارش و داشبورد." },
        { en: "To operate AI features: answer copilot questions grounded in your business data (see the AI Processing and AI Data Use sections).", fa: "برای کارکرد قابلیت‌های هوش مصنوعی: پاسخ به پرسش‌های دستیار بر پایهٔ داده‌های کسب‌وکار شما (بخش‌های «پردازش هوش مصنوعی» و صفحهٔ «استفاده از داده در هوش مصنوعی» را ببینید)." },
        { en: "To meter usage: count AI requests and messages against your plan's limits.", fa: "برای اندازه‌گیری مصرف: شمارش درخواست‌ها و پیام‌های هوش مصنوعی در برابر سقف پلن شما." },
        { en: "To keep the service secure: rate limiting, session invalidation, audit logging, abuse detection.", fa: "برای امنیت سرویس: محدودسازی نرخ، ابطال نشست، ثبت ممیزی، شناسایی سوءاستفاده." },
        { en: "To understand the product funnel: first-party, aggregate product analytics (for example, how many signups completed onboarding).", fa: "برای درک مسیر محصول: تحلیل تجاری first-party و تجمیعی (مثلاً چند ثبت‌نام آنبوردینگ را کامل کرده‌اند)." },
        { en: "To handle billing when payment becomes active: subscription state, checkout sessions, payment transactions.", fa: "برای صورتحساب وقتی پرداخت فعال شود: وضعیت اشتراک، نشست‌های پرداخت و تراکنش‌ها." },
      ],
    },
    {
      id: "ai-processing",
      heading: { en: "AI Processing", fa: "پردازش هوش مصنوعی" },
      paragraphs: [
        { en: "When you ask the copilot a question, the service assembles a business snapshot on the server — pre-computed figures for a time window, open invoice and bill summaries, top products, expense categories, low-stock items and recent payments — and sends it, together with your question and the conversation context, to the third-party AI provider configured by the platform. The provider returns a response, which is stored as part of your conversation history.", fa: "وقتی از دستیار پرسش می‌پرسید، سرویس روی سرور یک تصویر لحظه‌ای از کسب‌وکار می‌سازد — ارقام از پیش محاسبه‌شدهٔ یک بازهٔ زمانی، خلاصهٔ فاکتورهای باز و صورت‌حساب‌های پرداخت‌نشده، محصولات پرفروش، دسته‌های هزینه، اقلام کم‌موجود و پرداخت‌های اخیر — و آن را همراه با پرسش شما و بافت گفت‌وگو به ارائه‌دهندهٔ هوش مصنوعی شخص ثالثِ پیکربندی‌شده در پلتفرم می‌فرستد. ارائه‌دهنده پاسخی برمی‌گرداند که به‌عنوان بخشی از تاریخچهٔ گفت‌وگوی شما ذخیره می‌شود." },
        { en: "Some AI requests may be processed by third-party AI service providers configured by the platform. Provider retention and processing terms are governed by the applicable provider documentation and configuration. The AI Data Use page (/ai-data-use) describes exactly which data is sent, and what is never sent.", fa: "بخشی از درخواست‌های هوش مصنوعی ممکن است توسط ارائه‌دهندگان خدمات هوش مصنوعی شخص ثالثِ پیکربندی‌شده در پلتفرم پردازش شود. نگه‌داری و پردازش سمت ارائه‌دهنده تابع مستندات و پیکربندی همان ارائه‌دهنده است. صفحهٔ «استفاده از داده در هوش مصنوعی» (/ai-data-use) دقیقاً توضیح می‌دهد چه داده‌هایی ارسال می‌شود و چه داده‌هایی هرگز ارسال نمی‌شود." },
        { en: "AI-generated output may be inaccurate or incomplete. The copilot is read-only: it cannot create, change or delete your records.", fa: "خروجی هوش مصنوعی ممکن است نادرست یا ناقص باشد. دستیار فقط خواندنی است: نمی‌تواند چیزی بسازد، تغییر دهد یا حذف کند." },
      ],
    },
    {
      id: "third-party-services",
      heading: { en: "Third-Party Services", fa: "خدمات شخص ثالث" },
      paragraphs: [
        { en: "The service works with a small number of providers, classified by their current state:", fa: "سرویس با تعداد کمی ارائه‌دهنده کار می‌کند که بر اساس وضعیت فعلی دسته‌بندی شده‌اند:" },
        { en: "An up-to-date register is maintained in the service provider documentation, and the public pages only describe providers whose status matches the actual configuration.", fa: "فهرست به‌روز ارائه‌دهندگان در مستندات داخلی «فهرست ارائه‌دهندگان سرویس» نگه‌داری می‌شود و صفحات عمومی فقط ارائه‌دهندگانی را توصیف می‌کنند که وضعیت‌شان با پیکربندی واقعی هم‌خوان است." },
      ],
      bullets: [
        { en: "AI provider — active for AI requests, depending on enabled configuration.", fa: "ارائه‌دهندهٔ هوش مصنوعی — برای درخواست‌های هوش مصنوعی فعال، بسته به پیکربندی فعال." },
        { en: "Payment provider — a payment adapter exists but online payment is not active; no live payment processing occurs today.", fa: "ارائه‌دهندهٔ پرداخت — آداپتور پرداخت وجود دارد اما پرداخت آنلاین فعال نیست؛ امروز پرداختِ واقعیِ زنده‌ای انجام نمی‌شود." },
        { en: "Email delivery — not currently configured for production; password-reset emails require this configuration.", fa: "ارسال ایمیل — در حال حاضر برای تولید پیکربندی نشده است؛ ایمیل بازیابی رمز به این پیکربندی نیاز دارد." },
        { en: "Hosting/infrastructure — the service runs on third-party hosting; providers are not individually enumerated here.", fa: "میزبانی/زیرساخت — سرویس روی میزبانی شخص ثالث اجرا می‌شود؛ ارائه‌دهندگان در اینجا تک‌تک فهرست نمی‌شوند." },
        { en: "Third-party analytics — none. Product analytics are first-party only.", fa: "تحلیل شخص ثالث — هیچ. تحلیل محصول فقط first-party است." },
      ],
    },
    {
      id: "retention",
      heading: { en: "Retention", fa: "نگه‌داری" },
      paragraphs: [
        { en: "Retention follows the actual implementation. Where no explicit retention period is configured, the service says so rather than inventing a number:", fa: "نگه‌داری از پیاده‌سازی واقعی پیروی می‌کند. هر جا دورهٔ نگه‌داری صریحی پیکربندی نشده، سرویس به‌جای ساختن عدد، همان را می‌گوید:" },
      ],
      bullets: [
        { en: "Account data — kept while your account exists; deleted when you delete your account.", fa: "داده‌های حساب — تا وقتی حساب شما وجود دارد نگه‌داری می‌شود و با حذف حساب حذف می‌شود." },
        { en: "Business data — kept while the business workspace exists; deleted when the owner deletes the business.", fa: "داده‌های کسب‌وکار — تا وقتی فضای کاری وجود دارد نگه‌داری می‌شود و با حذف کسب‌وکار توسط مالک حذف می‌شود." },
        { en: "AI conversations — kept while the related business workspace and your account exist; you can delete individual conversations in the product at any time.", fa: "گفت‌وگوهای هوش مصنوعی — تا وقتی کسب‌وکارِ مربوطه و حساب شما وجود دارند نگه‌داری می‌شوند؛ هر گفت‌وگو را هر زمان در خود محصول می‌توانید حذف کنید." },
        { en: "Password-reset records — single-use, short-lived (30 minutes) hashed tokens; opportunistic cleanup of expired tokens.", fa: "رکوردهای بازیابی رمز — توکن هش‌شدهٔ یک‌بارمصرف و کوتاه‌عمر (۳۰ دقیقه) با پاک‌سازی فرصت‌طلبانهٔ توکن‌های منقضی." },
        { en: "Security and audit records — tenant audit records are deleted with the business; platform-level security events (such as account deletion) are retained.", fa: "رکوردهای امنیتی و ممیزی — ممیزیِ سطح کسب‌وکار با حذف کسب‌وکار حذف می‌شود؛ رخدادهای امنیتی سطح پلتفرم (مانند حذف حساب) نگه‌داری می‌شوند." },
        { en: "Product analytics (commercial events) — retained as first-party analytics records; they are not deleted with a business or account.", fa: "تحلیل محصول (رخدادهای تجاری) — به‌عنوان رکورد تحلیلی first-party نگه‌داری می‌شود و با حذف کسب‌وکار یا حساب حذف نمی‌شود." },
        { en: "Internal AI cost records — retained as internal financial records of the platform; they are never shown to tenants.", fa: "رکوردهای داخلی هزینهٔ هوش مصنوعی — به‌عنوان رکورد مالی داخلی پلتفرم نگه‌داری می‌شود و هرگز به کسب‌وکارها نمایش داده نمی‌شود." },
        { en: "Billing records — subscription history is retained; checkout and payment records follow the billing implementation.", fa: "رکوردهای صورتحساب — تاریخچهٔ اشتراک نگه‌داری می‌شود؛ سوابق پرداخت و نشست پرداخت تابع پیاده‌سازی صورتحساب است." },
        { en: "No other explicit retention schedule is currently configured for these categories.", fa: "برای این دسته‌ها هیچ برنامهٔ نگه‌داری صریح دیگری در حال حاضر پیکربندی نشده است." },
      ],
    },
    {
      id: "deletion",
      heading: { en: "Deletion", fa: "حذف" },
      paragraphs: [
        { en: "You can delete data in two distinct ways, and they are not interchangeable:", fa: "حذف داده به دو شیوهٔ متمایز انجام می‌شود و این دو جایگزین هم نیستند:" },
        { en: "The exact behavior is documented in the service's data deletion matrix. Deletion documentation in this policy reflects what the software actually does; where a category is retained by design (for example analytics or security records), it is stated above.", fa: "رفتار دقیق در «ماتریس حذف داده» سرویس مستند است. مستندات حذف در این سیاست بازتاب همان چیزی است که نرم‌افزار واقعاً انجام می‌دهد؛ هر دسته‌ای که به‌عمد نگه‌داری می‌شود (مانند تحلیل یا رکوردهای امنیتی) در بالا گفته شده است." },
      ],
      bullets: [
        { en: "Delete a business (owner-only): removes the workspace and everything in it — customers, suppliers, products, sales, expenses, payments, AI conversations, usage records, subscription records and the tenant audit trail. First-party analytics events and internal platform cost records are retained, and platform-level security events remain.", fa: "حذف کسب‌وکار (فقط مالک): فضای کاری و همهٔ درون آن را حذف می‌کند — مشتریان، تأمین‌کنندگان، محصولات، فروش، هزینه‌ها، پرداخت‌ها، گفت‌وگوهای هوش مصنوعی، رکوردهای مصرف، سوابق اشتراک و ممیزیِ سطح کسب‌وکار. رخدادهای تحلیلی first-party و رکوردهای داخلی هزینهٔ پلتفرم نگه‌داری می‌شوند و رخدادهای امنیتی سطح پلتفرم باقی می‌مانند." },
        { en: "Delete your account: removes your account, profile, AI conversations tied to your user, memberships, password-reset records and acceptance records, plus all account-security records — email-verification tokens, your two-factor credential and recovery-code hashes, login challenges, device session entries and your security activity history. You cannot delete your account while you still own a business — the ownership must be resolved first (delete or transfer the business). Businesses you merely belong to continue to exist.", fa: "حذف حساب شما: حساب، پروفایل، گفت‌وگوهای هوش مصنوعیِ مرتبط با کاربر شما، عضویت‌ها، رکوردهای بازیابی رمز و رکوردهای پذیرش را حذف می‌کند. تا وقتی کسب‌وکاری دارید که مالکش هستید نمی‌توانید حساب را حذف کنید — ابتدا باید تکلیف مالکیت روشن شود (حذف یا واگذاری کسب‌وکار). کسب‌وکارهایی که فقط عضو آن‌ها هستید به حیات خود ادامه می‌دهند. رخدادهای امنیتی سطح نشست با حذف شناسهٔ شما باقی می‌مانند." },
      ],
    },
    {
      id: "security",
      heading: { en: "Security", fa: "امنیت" },
      paragraphs: [
        { en: "The service applies technical measures that are verifiable in its implementation:", fa: "سرویس تدابیر فنی‌ای به کار می‌برد که در پیاده‌سازی آن قابل راستی‌آزمایی است:" },
        { en: "Transport encryption depends on the deployment configuration of the hosting layer. The service does not claim to be unbreakable, \"bank-grade\" or 100% secure; no online service can make that claim honestly. If a security issue is configured to be reported, the contact appears in the Contact section when configured.", fa: "رمزنگاری مسیر انتقال به پیکربندی استقرار در لایهٔ میزبانی بستگی دارد. سرویس ادعای «شکست‌ناپذیر» یا «بانکی» یا «۱۰۰٪ امن» بودن ندارد؛ هیچ سرویس برخطی نمی‌تواند چنین ادعایی را صادقانه بکند. در صورت پیکربندی کانال گزارش مشکل امنیتی، آن تماس در بخش «اطلاعات تماس» نمایش داده می‌شود." },
      ],
      bullets: [
        { en: "Passwords are stored only as bcrypt hashes.", fa: "رمزهای عبور فقط به‌صورت هش bcrypt ذخیره می‌شوند." },
        { en: "Sessions are invalidated server-side when your password changes or is reset.", fa: "نشست‌ها هنگام تغییر یا بازیابی رمز عبور در سمت سرور باطل می‌شوند." },
        { en: "Role-based access control separates owners, admins and members.", fa: "کنترل دسترسی نقش‌محور، مالک و مدیر و عضو را از هم جدا می‌کند." },
        { en: "Tenant isolation: every query is scoped to your business workspace.", fa: "جداسازی اجاره‌نشین‌ها (tenant isolation): هر پرس‌وجو به فضای کاری شما محدود است." },
        { en: "Rate limiting on authentication, AI, destructive and export endpoints.", fa: "محدودسازی نرخ روی نقاط ورود، هوش مصنوعی، عملیات مخرب و خروجی گرفتن." },
        { en: "Audit logging of consequential actions.", fa: "ثبت ممیزی برای اقدامات مهم." },
      ],
    },
    {
      id: "your-choices",
      heading: { en: "Your Choices", fa: "انتخاب‌های شما" },
      paragraphs: [
        { en: "These are product controls. This policy does not imply that a statutory right exists merely because a control exists — and it does not claim that every legal right is automated.", fa: "این‌ها کنترل‌های محصول‌اند. این سیاست به این دلیل که کنترلی وجود دارد، وجود حق قانونی را ضمناً نتیجه نمی‌گیرد و ادعا نمی‌کند هر حق قانونی به‌صورت خودکار فراهم است." },
      ],
      bullets: [
        { en: "Profile: change your name and language preference in settings.", fa: "پروفایل: تغییر نام و زبان در تنظیمات." },
        { en: "AI conversations: delete any conversation in the product; deleting a business or your account removes the related conversations.", fa: "گفت‌وگوهای هوش مصنوعی: حذف هر گفت‌وگو در محصول؛ حذف کسب‌وکار یا حساب، گفت‌وگوهای مرتبط را هم حذف می‌کند." },
        { en: "Business data: export your business as a JSON backup (owners and admins), or delete the business.", fa: "داده‌های کسب‌وکار: خروجی JSON از کسب‌وکار (مالک/مدیر) یا حذف کسب‌وکار." },
        { en: "Account: delete your account in settings (after resolving business ownership).", fa: "حساب: حذف حساب در تنظیمات (پس از تکلیف مالکیت کسب‌وکار)." },
        { en: "Cookies: see the Cookie Policy (/cookies) for the specific cookies used and how to control them in your browser.", fa: "کوکی‌ها: «سیاست کوکی» (/cookies) کوکی‌های مشخصِ استفاده‌شده و کنترل آن‌ها در مرورگر را توضیح می‌دهد." },
      ],
    },
    {
      id: "user-requests",
      heading: { en: "Requests About Your Data", fa: "درخواست دربارهٔ داده‌های شما" },
      paragraphs: [
        { en: "Most data tasks can be done directly in the product (see Your Choices). For anything else, contact the privacy contact shown in the Contact section — when it is configured. Requests are handled operationally through the configured contact channel; the service does not run an automated rights-request portal, and it does not treat an unverified email as proof of identity for account-level requests.", fa: "بیشتر کارهای داده را می‌توان مستقیم در محصول انجام داد (بخش «انتخاب‌های شما»). برای بقیه، با «تماس حریم خصوصی» نشان‌داده‌شده در بخش «اطلاعات تماس» تماس بگیرید — وقتی پیکربندی شده باشد. درخواست‌ها به‌صورت عملیاتی از طریق کانال تماس پیکربندی‌شده رسیدگی می‌شوند؛ سرویس درگاه خودکار درخواست حقوقی ندارد و ایمیلی که هویتش تأیید نشده را برای درخواست‌های سطح حساب اثباتِ هویت نمی‌داند." },
      ],
    },
    {
      id: "international",
      heading: { en: "International Processing", fa: "پردازش بین‌المللی" },
      paragraphs: [
        { en: "The service and its providers may process data in more than one country. The service does not publish provider server geography because it is not verified; provider processing terms are governed by the applicable provider documentation and configuration.", fa: "سرویس و ارائه‌دهندگانش ممکن است داده‌ها را در بیش از یک کشور پردازش کنند. سرویس جغرافیای سرورهای ارائه‌دهندگان را منتشر نمی‌کند، چون راستی‌آزمایی نشده است؛ پردازش سمت ارائه‌دهنده تابع مستندات و پیکربندی همان ارائه‌دهنده است." },
      ],
    },
    {
      id: "changes",
      heading: { en: "Changes to This Policy", fa: "تغییرات این سیاست" },
      paragraphs: [
        { en: "This policy carries a version (shown at the top of the page). Material changes are published as a new version with a new \"last updated\" date; the effective date is shown once it is configured. The version of the Terms and Privacy Policy you accepted at signup is recorded with your account when acceptance is implemented.", fa: "این سیاست نسخه دارد (بالای صفحه نمایش داده می‌شود). تغییرات مهم به‌صورت نسخهٔ جدید با تاریخ «آخرین به‌روزرسانی» جدید منتشر می‌شوند؛ تاریخ اجرا پس از پیکربندی نمایش داده می‌شود. نسخهٔ شرایط و سیاستی که هنگام ثبت‌نام پذیرفته‌اید (در صورت فعال بودن ثبت پذیرش) همراه حساب شما ثبت می‌شود." },
      ],
    },
    {
      id: "contact",
      heading: { en: "Contact", fa: "اطلاعات تماس" },
      paragraphs: [
        { en: "The contact entries below are produced from the service's live configuration and never fall back to invented addresses:", fa: "موارد تماس زیر از پیکربندی زندهٔ سرویس تولید می‌شود و هرگز شامل نشانی‌های ساختگی نیست:" },
        { en: "If no contact is configured, the service displays that fact instead of a fake address.", fa: "اگر تماسی پیکربندی نشده باشد، سرویس به‌جای نشانی ساختگی، همان واقعیت را نشان می‌دهد." },
      ],
      bullets: [
        { en: "Privacy contact: shown here when configured; otherwise the honest state \"not currently configured\" is displayed.", fa: "تماس حریم خصوصی: وقتی پیکربندی شده باشد اینجا نمایش داده می‌شود؛ در غیر این صورت وضعیت صادقانهٔ «در حال حاضر پیکربندی نشده است» نشان داده می‌شود." },
        { en: "Legal contact: same rule.", fa: "تماس حقوقی: همین قاعده." },
        { en: "Support contact: same rule.", fa: "تماس پشتیبانی: همین قاعده." },
        { en: "Security contact: same rule (see also the AI Data Use and Cookie pages).", fa: "تماس امنیتی: همین قاعده (صفحات «استفاده از داده در هوش مصنوعی» و «کوکی» را هم ببینید)." },
      ],
    },
  ],
};
