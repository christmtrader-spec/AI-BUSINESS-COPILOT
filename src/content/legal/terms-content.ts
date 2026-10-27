/**
 * terms content — RECOVERY-GENERATED from the audited old-shape
 * document (termsContent) by scripts/rebuild-legal-content.ts.
 * The TEXT is the reviewed copy — NOT rewritten, only reshaped
 * into the paired-locale LegalDocumentContent model.
 */
import type { LegalDocumentContent } from "./types";

export const termsContent: LegalDocumentContent = {
  key: "terms",
  title: { en: "Terms of Service", fa: "شرایط استفاده از خدمات" },
  intro: [
    { en: "The rules for using AI Business Copilot — accounts, acceptable use, AI features, billing, trials and termination.", fa: "قواعد استفاده از دستیار هوشمند کسب‌وکار — حساب‌ها، استفادهٔ مجاز، قابلیت‌های هوش مصنوعی، صورتحساب، دورهٔ آزمایشی و خاتمه." },
  ],
  sections: [
    {
      id: "service",
      heading: { en: "Service", fa: "خدمات" },
      paragraphs: [
        { en: "AI Business Copilot (\"the service\") is an online tool for small businesses to record customers, suppliers, products, sales, expenses and payments, produce reports, and ask questions about that data through an AI assistant. The service is offered as-is, in the languages and with the features published in the product.", fa: "«دستیار هوشمند کسب‌وکار» («سرویس») ابزار برخطی برای کسب‌وکارهای کوچک است تا مشتریان، تأمین‌کنندگان، محصولات، فروش، هزینه‌ها و پرداخت‌ها را ثبت کنند، گزارش بسازند و از طریق دستیار هوشمند دربارهٔ آن داده‌ها پرسش کنند. سرویس «همان‌گونه که هست» و با زبان‌ها و قابلیت‌های منتشرشده در محصول ارائه می‌شود." },
        { en: "The functional rules of the service — plans, limits, roles and lifecycle — are the ones the software actually enforces. Where these Terms and the product's behavior ever differ, that difference is treated as a defect to fix, not a hidden term.", fa: "قواعد کارکردی سرویس — پلن‌ها، سقف‌ها، نقش‌ها و چرخهٔ حیات — همان چیزی است که نرم‌افزار واقعاً اعمال می‌کند. اگر این شرایط و رفتار محصول روزی ناسازگار شوند، آن ناسازگاری نقصی برای رفع است، نه شرطی پنهان." },
      ],
    },
    {
      id: "accounts",
      heading: { en: "Accounts", fa: "حساب‌ها" },
      bullets: [
        { en: "You register with a name, an email address and a password. You are responsible for the accuracy of that information and for keeping your credentials confidential.", fa: "ثبت‌نام با نام، نشانی ایمیل و رمز عبور انجام می‌شود. مسئولیت درستی این اطلاعات و محرمانه نگه‌داشتن اعتبارنامه‌ها با شماست." },
        { en: "One person may hold multiple business workspaces; a workspace may have several members with role-based permissions (owner, admin, member).", fa: "یک نفر می‌تواند چند فضای کاری داشته باشد؛ هر فضای کاری می‌تواند چند عضو با مجوزهای نقش‌محور داشته باشد (مالک، مدیر، عضو)." },
        { en: "Changing or resetting your password invalidates your existing sessions.", fa: "تغییر یا بازیابی رمز عبور، نشست‌های فعال شما را باطل می‌کند." },
        { en: "You cannot delete your account while you own a business workspace; ownership must be resolved first. This constraint protects the other members of that workspace.", fa: "تا وقتی مالک فضای کاری هستید نمی‌توانید حساب را حذف کنید؛ ابتدا باید تکلیف مالکیت روشن شود. این محدودیت از سایر اعضای آن فضای کاری محافظت می‌کند." },
        { en: "You are responsible for activity that happens through your account. Notify the service through the configured support contact if you believe your account was compromised.", fa: "مسئولیت فعالیتی که از طریق حساب شما انجام می‌شود با شماست. اگر فکر می‌کنید حساب شما لو رفته، از طریق «تماس پشتیبانی» پیکربندی‌شده اطلاع دهید." },
      ],
    },
    {
      id: "acceptable-use",
      heading: { en: "Acceptable Use", fa: "استفادهٔ مجاز" },
      paragraphs: [
        { en: "You agree not to use the service:", fa: "می‌پذیرید که از سرویس برای این موارد استفاده نکنید:" },
        { en: "The service applies technical limits (rate limiting, quotas, plan entitlements) and records consequential actions in an audit trail. These clauses describe obvious abuse; they do not claim any automated enforcement beyond what the software actually does.", fa: "سرویس محدودیت‌های فنی (محدودسازی نرخ، سهمیه‌ها، مجوزهای پلن) به کار می‌برد و اقدامات مهم را در دفتر ممیزی ثبت می‌کند. این بندها سوءاستفادهٔ آشکار را توصیف می‌کنند و ادعای اجرای خودکارِ فراتر از رفتار واقعی نرم‌افزار ندارند." },
      ],
      bullets: [
        { en: "for illegal activity or content, or to infringe others' rights;", fa: "فعالیت یا محتوای غیرقانونی، یا نقض حقوق دیگران؛" },
        { en: "to attempt unauthorized access to the service, other tenants, or accounts (including probing, credential stuffing or automated scraping);", fa: "تلاش برای دسترسی غیرمجاز به سرویس، اجاره‌نشین‌های دیگر یا حساب‌ها (شامل پویش، آزمودن اعتبارنامه یا جمع‌آوری خودکار داده)؛" },
        { en: "to upload or distribute malware;", fa: "بارگذاری یا انتشار بدافزار؛" },
        { en: "to commit fraud, or to misrepresent your identity to the service or to other users;", fa: "کلاهبرداری یا جعل هویت شما نزد سرویس یا کاربران دیگر؛" },
        { en: "to abuse the AI features (for example, generating unlawful content, attacking the provider, or circumventing usage limits);", fa: "سوءاستفاده از قابلیت‌های هوش مصنوعی (مانند تولید محتوای غیرقانونی، حمله به ارائه‌دهنده یا دور زدن سقف مصرف)؛" },
        { en: "to interfere with the service's operation, security controls, or other users' use of it.", fa: "اخلال در کارکرد سرویس، کنترل‌های امنیتی یا استفادهٔ دیگران از آن." },
      ],
    },
    {
      id: "business-data",
      heading: { en: "Your Business Data", fa: "داده‌های کسب‌وکار شما" },
      paragraphs: [
        { en: "You keep control of the data you store in your business workspace. You represent that you have the rights needed to store and process that data with the service, including data about your customers, suppliers and team members.", fa: "کنترل داده‌هایی که در فضای کاری خود ذخیره می‌کنید با شماست. اعلام می‌کنید که حقوق لازم برای ذخیره و پردازش آن داده‌ها با سرویس را دارید، از جمله داده‌های مربوط به مشتریان، تأمین‌کنندگان و اعضای تیم." },
        { en: "The service processes your business data only to provide the functionality: storage, reports, dashboards, exports and AI answers grounded in that data. The service does not claim ownership of your business data, and specific intellectual-property wording is subject to legal review.", fa: "سرویس داده‌های کسب‌وکار شما را فقط برای ارائهٔ کارکرد پردازش می‌کند: ذخیره‌سازی، گزارش، داشبورد، خروجی گرفتن و پاسخ‌های هوش مصنوعیِ بر پایهٔ همان داده‌ها. سرویس ادعای مالکیت داده‌های کسب‌وکار شما را ندارد و عبارت‌بندی دقیق مالکیت فکری منوط به بازبینی حقوقی است." },
      ],
    },
    {
      id: "ai-features",
      heading: { en: "AI Features", fa: "قابلیت‌های هوش مصنوعی" },
      bullets: [
        { en: "The AI assistant answers questions about the business data of the workspace you are using, grounded in a snapshot the service computes on the server.", fa: "دستیار هوشمند به پرسش‌های شما دربارهٔ داده‌های همان فضای کاری پاسخ می‌دهد و مبنا، تصویری است که سرویس روی سرور محاسبه می‌کند." },
        { en: "AI-generated output may be inaccurate or incomplete. Figures are quoted from that snapshot; anything outside it is refused rather than invented.", fa: "خروجی هوش مصنوعی ممکن است نادرست یا ناقص باشد. ارقام از همان تصویر نقل می‌شوند؛ هرچه بیرون از آن باشد به‌جای ساخته شدن، رد می‌شود." },
        { en: "The assistant is read-only: it cannot create, change or delete your records.", fa: "دستیار فقط خواندنی است: نمی‌تواند رکوردهای شما را بسازد، تغییر دهد یا حذف کند." },
        { en: "AI assistance is informational. It is not accounting, tax, legal or financial advice, and important decisions should be independently reviewed.", fa: "کمک هوش مصنوعی اطلاع‌رسانانه است. مشاورهٔ حسابداری، مالیاتی، حقوقی یا مالی نیست و تصمیم‌های مهم باید مستقلاً بازبینی شود." },
        { en: "AI requests may be processed by third-party AI providers configured by the platform; see the AI Data Use page (/ai-data-use) for exactly what is sent and what is not.", fa: "درخواست‌های هوش مصنوعی ممکن است توسط ارائه‌دهندگان شخص ثالثِ پیکربندی‌شده در پلتفرم پردازش شوند؛ صفحهٔ «استفاده از داده در هوش مصنوعی» (/ai-data-use) دقیقاً می‌گوید چه چیزی ارسال می‌شود و چه چیزی نمی‌شود." },
        { en: "AI usage is metered against your plan's limits.", fa: "مصرف هوش مصنوعی در برابر سقف پلن شما اندازه‌گیری می‌شود." },
      ],
    },
    {
      id: "billing",
      heading: { en: "Billing and Subscriptions", fa: "صورتحساب و اشتراک‌ها" },
      paragraphs: [
        { en: "Plans and their limits are published on the pricing page (/pricing) and come from the platform's price catalog. A business has exactly one current subscription; subscription history is retained as events.", fa: "پلن‌ها و سقف‌هایشان در صفحهٔ قیمت‌گذاری (/pricing) منتشر می‌شود و از کاتالوگ قیمت پلتفرم می‌آید. هر کسب‌وکار دقیقاً یک اشتراک جاری دارد؛ تاریخچهٔ اشتراک به‌صورت رخداد نگه‌داری می‌شود." },
        { en: "Online payment is not active yet. Where the pricing page shows a plan as purchasable, checkout becomes available when payment is enabled; until then, paid plan states are handled operationally. These Terms do not claim completed online payment capability, automatic renewal billing, or any refund policy — none of that exists in the product today, and none is promised here.", fa: "پرداخت آنلاین هنوز فعال نیست. هر جا صفحهٔ قیمت‌گذاری پلنی را قابل خرید نشان دهد، امکان پرداخت با فعال شدن درگاه فراهم می‌شود؛ تا آن زمان وضعیت پلن‌های پرداختی به‌صورت عملیاتی مدیریت می‌شود. این شرایط ادعای قابلیت پرداخت آنلاینِ تکمیل‌شده، صورتحساب خودکار تمدید یا هر سیاست بازپرداخت ندارد — هیچ‌کدام امروز در محصول وجود ندارد و هیچ‌کدام اینجا وعده داده نمی‌شود." },
        { en: "Prices are shown in the settlement currency of the platform. Currency display of your business workspace is independent and does not imply conversion.", fa: "قیمت‌ها بر حسب واحد پول تسویهٔ پلتفرم نمایش داده می‌شوند. واحد پول نمایشی فضای کاری شما مستقل است و به معنای تبدیل ارز نیست." },
      ],
    },
    {
      id: "trials",
      heading: { en: "Free Trials", fa: "دورهٔ آزمایشی رایگان" },
      paragraphs: [
        { en: "When a free trial is offered, the terms shown at the moment you start it apply: the trial plan and the number of days are displayed on the pricing page and in the trial flow. A trial gives the selected business access to the trial plan's features for the stated period.", fa: "هر جا دورهٔ آزمایشی رایگان ارائه شود، شرایطی که هنگام شروع آن نمایش داده می‌شود معتبر است: پلن آزمایشی و تعداد روزها در صفحهٔ قیمت‌گذاری و مسیر شروع آزمایشی نشان داده می‌شود. دورهٔ آزمایشی به کسب‌وکار منتخب، برای مدت اعلام‌شده، دسترسی به قابلیت‌های پلن آزمایشی می‌دهد." },
        { en: "Nothing is charged when a trial ends. When the trial period is over, the trial subscription expires and the business no longer has the trial plan's features unless a plan is purchased when payment is available. Starting a trial requires an eligible business; the eligibility rules are enforced by the service and shown to you at the time.", fa: "در پایان دورهٔ آزمایشی هیچ مبلغی دریافت نمی‌شود. با پایان دوره، اشتراک آزمایشی منقضی می‌شود و کسب‌وکار تا زمان خرید پلن (وقتی پرداخت فعال شود) قابلیت‌های آن پلن را ندارد. شروع دورهٔ آزمایشی نیازمند کسب‌وکار واجد شرایط است؛ قواعد واجد شرایط بودن توسط سرویس اعمال و همان‌جا به شما نشان داده می‌شود." },
      ],
    },
    {
      id: "user-content",
      heading: { en: "User Content", fa: "محتوای کاربر" },
      paragraphs: [
        { en: "\"User content\" means the business records, texts and other material you or your team store in the service. You are responsible for having appropriate rights to that content. The service stores and processes it to provide the functionality described in these Terms and in the Privacy Policy (/privacy).", fa: "«محتوای کاربر» یعنی رکوردهای کسب‌وکار، متن‌ها و سایر موادی که شما یا تیم‌تان در سرویس ذخیره می‌کنید. مسئولیت دارید که حقوق لازم برای آن محتوا را داشته باشید. سرویس آن را برای ارائهٔ کارکردی که در این شرایط و در «سیاست حریم خصوصی» (/privacy) توضیح داده شده، ذخیره و پردازش می‌کند." },
        { en: "You must not store content that violates the Acceptable Use rules above. The service does not review user content as a matter of course.", fa: "نباید محتوایی ذخیره کنید که قواعد «استفادهٔ مجاز» را نقض کند. سرویس به‌طور معمول محتوای کاربران را بازبینی نمی‌کند." },
      ],
    },
    {
      id: "third-party",
      heading: { en: "Third-Party Services", fa: "خدمات شخص ثالث" },
      paragraphs: [
        { en: "The service relies on third-party providers where applicable: AI providers for AI features, hosting/infrastructure providers, and payment or email providers when those integrations are configured and active. Only providers whose status matches the actual configuration are described in the public pages. The service is not responsible for third-party providers' own terms, availability or processing, which are governed by the applicable provider documentation and configuration.", fa: "سرویس در موارد لازم به ارائه‌دهندگان شخص ثالث تکیه دارد: ارائه‌دهندگان هوش مصنوعی برای قابلیت‌های هوش مصنوعی، ارائه‌دهندگان میزبانی/زیرساخت، و ارائه‌دهندگان پرداخت یا ایمیل وقتی آن یکپارچه‌سازی‌ها پیکربندی و فعال شده باشند. صفحات عمومی فقط ارائه‌دهندگانی را توصیف می‌کنند که وضعیت‌شان با پیکربندی واقعی هم‌خوان است. سرویس مسئول شرایط، دسترس‌پذیری یا پردازشِ خودِ ارائه‌دهندگان شخص ثالث نیست؛ آن‌ها تابع مستندات و پیکربندی همان ارائه‌دهنده است." },
      ],
    },
    {
      id: "availability",
      heading: { en: "Service Availability", fa: "دسترس‌پذیری سرویس" },
      paragraphs: [
        { en: "The service is provided without an availability guarantee. Maintenance, incidents and configuration changes may interrupt it. The service does not publish an SLA and does not promise specific uptime percentages. Status information is not provided through these Terms.", fa: "سرویس بدون تضمین دسترس‌پذیری ارائه می‌شود. نگه‌داری، رخدادها و تغییرات پیکربندی ممکن است آن را قطع کنند. سرویس SLA منتشر نمی‌کند و درصد خاصی از زمان کار کردن را وعده نمی‌دهد. اطلاعات وضعیت از طریق این شرایط ارائه نمی‌شود." },
      ],
    },
    {
      id: "termination",
      heading: { en: "Termination and Data Handling", fa: "خاتمه و سرنوشت داده‌ها" },
      bullets: [
        { en: "By you: you can delete a business workspace (owner-only) and delete your account in settings. Deleting a business removes the workspace and everything in it, as described in the Privacy Policy. Deleting your account requires resolving business ownership first.", fa: "از سوی شما: می‌توانید فضای کاری کسب‌وکار را (فقط مالک) و حساب خود را در تنظیمات حذف کنید. حذف کسب‌وکار، فضای کاری و همهٔ درون آن را مطابق «سیاست حریم خصوصی» حذف می‌کند. حذف حساب پیش‌تر نیازمند تکلیف مالکیت کسب‌وکار است." },
        { en: "Subscription end: when a paid or trial subscription ends, the subscription state expires and the business returns to the features of the Free plan until a plan is purchased when payment is available.", fa: "پایان اشتراک: وقتی اشتراک پرداختی یا آزمایشی تمام می‌شود، وضعیت اشتراک منقضی می‌گردد و کسب‌وکار تا خرید پلن (وقتی پرداخت فعال شود) در قابلیت‌های پلن رایگان می‌ماند." },
        { en: "By the service: the service does not currently operate automated account suspension. Any operational action against an account for abuse is handled directly with the account holder through the configured contact channel.", fa: "از سوی سرویس: سرویس در حال حاضر معلق‌سازی خودکار حساب ندارد. هر اقدام عملیاتی علیه حسابی به‌دلیل سوءاستفاده، مستقیماً از طریق کانال تماس پیکربندی‌شده با دارندهٔ حساب پیگیری می‌شود." },
        { en: "Data after termination: what is deleted and what is retained follows the Privacy Policy (/privacy) — in particular the Retention and Deletion sections. No grace period is promised beyond what the software actually does.", fa: "داده‌ها پس از خاتمه: چه چیزی حذف و چه چیزی نگه‌داری می‌شود تابع «سیاست حریم خصوصی» (/privacy) است — به‌ویژه بخش‌های «نگه‌داری» و «حذف». فراتر از رفتار واقعی نرم‌افزار، هیچ دورهٔ مهلتی وعده داده نمی‌شود." },
      ],
    },
    {
      id: "disclaimers",
      heading: { en: "Disclaimers", fa: "سلب مسئولیت" },
      paragraphs: [
        { en: "The service is provided \"as is\" and \"as available\". To the extent permitted by applicable law, the service does not warrant that it will be uninterrupted, error-free, or that generated reports, exports or AI output are always accurate or complete. Financial and AI-generated analyses are informational and should be independently reviewed for important decisions.", fa: "سرویس «همان‌گونه که هست» و «همان‌گونه که در دسترس است» ارائه می‌شود. تا حد مجاز قانون قابل اعمال، سرویس تضمین نمی‌کند که بدون وقفه و بدون خطا باشد یا گزارش‌ها، خروجی‌ها و پاسخ‌های هوش مصنوعی همیشه دقیق و کامل باشند. تحلیل‌های مالی و خروجی هوش مصنوعی اطلاع‌رسانانه‌اند و برای تصمیم‌های مهم باید مستقلاً بازبینی شوند." },
        { en: "Nothing in these Terms excludes responsibility that cannot be excluded under applicable law. Specific liability wording is subject to legal review.", fa: "هیچ‌جای این شرایط، مسئولیت‌هایی را که طبق قانون قابل اعمال قابل سلب نیستند، سلب نمی‌کند. عبارت‌بندی دقیق مسئولیت حقوقی منوط به بازبینی حقوقی است." },
      ],
    },
    {
      id: "changes",
      heading: { en: "Changes to These Terms", fa: "تغییرات این شرایط" },
      paragraphs: [
        { en: "These Terms carry a version (shown at the top of the page). Material changes are published as a new version with a new \"last updated\" date. The version you accepted at signup is recorded with your account when acceptance is implemented.", fa: "این شرایط نسخه دارند (بالای صفحه نمایش داده می‌شود). تغییرات مهم به‌صورت نسخهٔ جدید با تاریخ «آخرین به‌روزرسانی» جدید منتشر می‌شوند. نسخه‌ای که هنگام ثبت‌نام پذیرفته‌اید (در صورت فعال بودن ثبت پذیرش) همراه حساب شما ثبت می‌شود." },
      ],
    },
    {
      id: "contact",
      heading: { en: "Contact", fa: "اطلاعات تماس" },
      paragraphs: [
        { en: "Legal and support contacts are shown on the legal pages based on the service's live configuration. Where a contact is not configured, the pages display that fact honestly instead of an invented address.", fa: "تماس‌های حقوقی و پشتیبانی بر اساس پیکربندی زندهٔ سرویس در صفحات حقوقی نمایش داده می‌شوند. هر جا تماسی پیکربندی نشده باشد، صفحات همان واقعیت را صادقانه نشان می‌دهند، نه نشانی ساختگی." },
      ],
    },
  ],
};
