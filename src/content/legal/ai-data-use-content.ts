/**
 * ai-data-use content — RECOVERY-GENERATED from the audited old-shape
 * document (aiDataUseContent) by scripts/rebuild-legal-content.ts.
 * The TEXT is the reviewed copy — NOT rewritten, only reshaped
 * into the paired-locale LegalDocumentContent model.
 */
import type { LegalDocumentContent } from "./types";

export const aiDataUseContent: LegalDocumentContent = {
  key: "ai-data-use",
  title: { en: "AI Data Use", fa: "استفاده از داده در هوش مصنوعی" },
  intro: [
    { en: "What the AI copilot does, exactly which business data it may process, what is stored, what is sent to third-party providers, and what you control.", fa: "دستیار هوشمند چه می‌کند، دقیقاً کدام داده‌های کسب‌وکار ممکن است پردازش شود، چه چیزی ذخیره می‌شود، چه چیزی به ارائه‌دهندگان شخص ثالث می‌رود و چه کنترل‌هایی دارید." },
  ],
  sections: [
    {
      id: "ai-features",
      heading: { en: "AI Features", fa: "قابلیت‌های هوش مصنوعی" },
      paragraphs: [
        { en: "AI Business Copilot includes an AI assistant (\"the copilot\") that answers questions about the business workspace you are using. It can summarize performance, explain outstanding invoices and bills, list top products, expense categories, low-stock items and recent payments, and discuss what the recorded figures mean in plain language.", fa: "دستیار هوشمند کسب‌وکار یک دستیار هوشمند دارد که دربارهٔ فضای کاری‌ای که با آن کار می‌کنید پاسخ می‌دهد. می‌تواند عملکرد را خلاصه کند، فاکتورهای باز و صورت‌حساب‌های پرداخت‌نشده را توضیح دهد، محصولات پرفروش، دسته‌های هزینه، اقلام کم‌موجود و پرداخت‌های اخیر را فهرست کند و معنی ارقام ثبت‌شده را به زبان ساده توضیح دهد." },
        { en: "The copilot is strictly read-only. It cannot create, change or delete any of your records, and it will tell you so if asked. Its usage counts against your plan's AI limits, and every request is metered by the service.", fa: "دستیار کاملاً فقط‌خواندنی است. نمی‌تواند رکوردی بسازد، تغییر دهد یا حذف کند و اگر بپرسید همین را می‌گوید. مصرف آن در برابر سقف هوش مصنوعی پلن شما شمرده می‌شود و هر درخواست توسط سرویس اندازه‌گیری می‌شود." },
      ],
    },
    {
      id: "data-sent-to-ai",
      heading: { en: "Data Sent to AI", fa: "داده‌هایی که به هوش مصنوعی ارسال می‌شود" },
      paragraphs: [
        { en: "When you ask a question, the service assembles a business snapshot on the server and sends it with your question and the recent conversation context. The snapshot contains relevant business information for a time window — not all of your business data:", fa: "وقتی پرسش می‌پرسید، سرویس روی سرور یک تصویر لحظه‌ای از کسب‌وکار می‌سازد و آن را همراه پرسش شما و بافت اخیر گفت‌وگو ارسال می‌کند. این تصویر «اطلاعات مرتبط کسب‌وکار» را برای یک بازهٔ زمانی دارد — نه همهٔ داده‌های کسب‌وکار شما را:" },
        { en: "All monetary figures are computed by the service and formatted as display strings before the model sees them. The model is instructed to use only figures that appear in the snapshot and to refuse anything else rather than invent it.", fa: "همهٔ ارقام مالی توسط سرویس محاسبه و پیش از دیدن مدل به‌صورت رشتهٔ نمایشی قالب‌بندی می‌شوند. به مدل دستور داده می‌شود فقط از ارقام موجود در تصویر استفاده کند و هر چیز دیگری را به‌جای ساختن، رد کند." },
        { en: "Never sent to the AI provider: passwords and password hashes, session tokens and authentication secrets, payment credentials and provider API keys, internal platform cost data, and other tenants' data. The snapshot is built from an explicit list of fields — the copilot context builder cannot accidentally include whole database objects.", fa: "هرگز به ارائه‌دهندهٔ هوش مصنوعی ارسال نمی‌شود: رمزهای عبور و هش آن‌ها، توکن‌های نشست و اسرار احراز هویت، اعتبارنامه‌های پرداخت و کلیدهای API ارائه‌دهندگان، داده‌های داخلی هزینهٔ پلتفرم، و داده‌های اجاره‌نشین‌های دیگر. تصویر از فهرست مشخصی از فیلدها ساخته می‌شود — سازندهٔ بافت دستیار نمی‌تواند تصادفاً شیء کامل پایگاه داده را وارد کند." },
      ],
      bullets: [
        { en: "business name, currency and timezone;", fa: "نام کسب‌وکار، واحد پول و منطقهٔ زمانی؛" },
        { en: "pre-computed key figures for the selected window: revenue, sales count, average sale, cash collected, expenses, cash paid out, net cash flow, collection rate and expense ratio;", fa: "شاخص‌های کلیدیِ از پیش محاسبه‌شدهٔ بازهٔ انتخابی: درآمد، تعداد فروش، میانگین فروش، وجه جمع‌آوری‌شده، هزینه‌ها، وجوه پرداخت‌شده، جریان نقدی خالص، نرخ وصول و نسبت هزینه؛" },
        { en: "a daily timeline of invoiced, collected, expensed and paid-out amounts;", fa: "جدول زمانی روزانهٔ فاکتور، وصول، هزینه و پرداخت؛" },
        { en: "top products by revenue, and expenses grouped by category;", fa: "محصولات پرفروش بر اساس درآمد و هزینه‌های گروه‌بندی‌شده بر اساس دسته؛" },
        { en: "outstanding balances: customers who owe you (open invoices with names and due amounts), suppliers you owe (open bills), and the oldest entries in each;", fa: "مانده‌های باز: مشتریانی که به شما بدهکارند (فاکتورهای باز با نام و مبلغ باقی‌مانده)، تأمین‌کنندگانی که به آن‌ها بدهکارید (صورت‌حساب‌های باز) و قدیمی‌ترین موارد هر گروه؛" },
        { en: "inventory value, active product count and low-stock items with quantities;", fa: "ارزش موجودی، تعداد محصولات فعال و اقلام کم‌موجود با تعداد؛" },
        { en: "recent payments with amount, method, date and any note you wrote;", fa: "پرداخت‌های اخیر با مبلغ، روش، تاریخ و یادداشتی که نوشته‌اید؛" },
        { en: "your question and the recent messages of the same conversation.", fa: "پرسش شما و پیام‌های اخیر همان گفت‌وگو." },
      ],
    },
    {
      id: "purpose",
      heading: { en: "Purpose", fa: "هدف" },
      paragraphs: [
        { en: "Your AI conversations are not used to train other customers' answers, and the service does not run advertising on AI content.", fa: "گفت‌وگوهای هوش مصنوعی شما برای آموزش پاسخ‌های مشتریان دیگر استفاده نمی‌شود و سرویس روی محتوای هوش مصنوعی تبلیغات اجرا نمی‌کند." },
      ],
      bullets: [
        { en: "AI response generation and assistant functionality;", fa: "تولید پاسخ هوش مصنوعی و کارکرد دستیار؛" },
        { en: "business analysis and summarization of your recorded data;", fa: "تحلیل کسب‌وکار و خلاصه‌سازی داده‌های ثبت‌شدهٔ شما؛" },
        { en: "usage measurement (counting AI requests and messages against your plan);", fa: "اندازه‌گیری مصرف (شمارش درخواست‌ها و پیام‌ها در برابر سقف پلن)؛" },
        { en: "service reliability (detecting failures and keeping answers grounded).", fa: "قابلیت اطمینان سرویس (شناسایی خطا و مستند ماندن پاسخ‌ها)." },
      ],
    },
    {
      id: "storage",
      heading: { en: "Storage", fa: "ذخیره‌سازی" },
      paragraphs: [
        { en: "Conversations are stored as part of the application's functionality: each business keeps its copilot conversations, and every message is tied to the member who wrote it. Failed requests are not stored. Conversation titles, pinning and renames are stored with the conversation.", fa: "گفت‌وگوها به‌عنوان بخشی از کارکرد برنامه ذخیره می‌شوند: هر کسب‌وکار گفت‌وگوهای دستیار خودش را دارد و هر پیام به عضوی که نوشته گره خورده است. درخواست‌های ناموفق ذخیره نمی‌شوند. عنوان گفت‌وگو، سنجاق‌شدن و تغییر نام همراه خود گفت‌وگو ذخیره می‌شود." },
        { en: "In addition to conversations, the service stores per-request usage metadata (provider/model identifiers and token counts as reported by the provider) for metering. This metadata never contains the content of your prompts or responses.", fa: "علاوه بر گفت‌وگوها، سرویس فرادادهٔ مصرف هر درخواست (شناسهٔ ارائه‌دهنده/مدل و تعداد توکنِ گزارش‌شده توسط ارائه‌دهنده) را برای اندازه‌گیری ذخیره می‌کند. این فراداده هرگز شامل محتوای پرسش‌ها و پاسخ‌های شما نیست." },
      ],
    },
    {
      id: "provider-processing",
      heading: { en: "Provider Processing", fa: "پردازش سمت ارائه‌دهنده" },
      paragraphs: [
        { en: "AI requests leave the platform: some AI requests may be processed by third-party AI service providers configured by the platform. The service does not claim that \"AI data never leaves the platform\" — it does.", fa: "درخواست‌های هوش مصنوعی از پلتفرم خارج می‌شوند: بخشی از درخواست‌ها ممکن است توسط ارائه‌دهندگان خدمات هوش مصنوعی شخص ثالثِ پیکربندی‌شده در پلتفرم پردازش شود. سرویس ادعا نمی‌کند که «دادهٔ هوش مصنوعی هرگز پلتفرم را ترک نمی‌کند» — می‌کند." },
        { en: "The provider processes the request to generate the response. Provider retention and processing terms are governed by the applicable provider documentation and configuration; the service does not claim specific provider retention behavior it has not verified. The service keeps the AI integration provider-agnostic, so it does not publish a specific model name on this page — the model is only recorded internally when the provider genuinely reports one.", fa: "ارائه‌دهنده درخواست را برای تولید پاسخ پردازش می‌کند. نگه‌داری و پردازش سمت ارائه‌دهنده تابع مستندات و پیکربندی همان ارائه‌دهنده است؛ سرویس رفتار نگه‌داری ارائه‌دهنده‌ای را که راستی‌آزمایی نکرده ادعا نمی‌کند. یکپارچه‌سازی هوش مصنوعی عمداً مستقل از ارائه‌دهنده نگه‌داری می‌شود، به همین دلیل این صفحه نام مدل مشخصی منتشر نمی‌کند — مدل فقط وقتی در درون ثبت می‌شود که ارائه‌دهنده واقعاً آن را گزارش کرده باشد." },
      ],
    },
    {
      id: "limitations",
      heading: { en: "Limitations", fa: "محدودیت‌ها" },
      bullets: [
        { en: "AI-generated output may be inaccurate or incomplete.", fa: "خروجی هوش مصنوعی ممکن است نادرست یا ناقص باشد." },
        { en: "Answers are grounded in the snapshot described above; figures outside that window or outside the recorded data are refused, not estimated.", fa: "پاسخ‌ها بر اساس همان تصویر توضیح‌داده‌شده مستندند؛ ارقام بیرون از آن بازه یا بیرون از داده‌های ثبت‌شده رد می‌شوند، نه تخمین زده می‌شوند." },
        { en: "AI assistance is informational. It is not accounting, tax, legal or financial advice, and important decisions should be independently reviewed.", fa: "کمک هوش مصنوعی اطلاع‌رسانانه است. مشاورهٔ حسابداری، مالیاتی، حقوقی یا مالی نیست و تصمیم‌های مهم باید مستقلاً بازبینی شوند." },
        { en: "The service does not guarantee human review of AI output.", fa: "سرویس بازبینی انسانی خروجی هوش مصنوعی را تضمین نمی‌کند." },
        { en: "AI availability depends on the configured provider; when the provider is unavailable, asking a question returns a clear error instead of a silent failure.", fa: "دسترس‌پذیری هوش مصنوعی به ارائه‌دهندهٔ پیکربندی‌شده وابسته است؛ وقتی ارائه‌دهنده در دسترس نباشد، پرسیدن پرسش خطای روشن برمی‌گرداند نه شکستِ خاموش." },
      ],
    },
    {
      id: "user-controls",
      heading: { en: "User Controls", fa: "کنترل‌های شما" },
      paragraphs: [
        { en: "These are the controls that exist today. The service does not advertise controls that are not implemented.", fa: "این‌ها کنترل‌های موجود امروز هستند. سرویس کنترل‌هایی که پیاده‌سازی نشده‌اند را تبلیغ نمی‌کند." },
      ],
      bullets: [
        { en: "Delete any copilot conversation from the conversation history in the product.", fa: "حذف هر گفت‌وگوی دستیار از تاریخچهٔ گفت‌وگو در محصول." },
        { en: "Deleting a business workspace (owner-only) deletes that business's conversations.", fa: "حذف فضای کاری کسب‌وکار (فقط مالک) گفت‌وگوهای آن کسب‌وکار را حذف می‌کند." },
        { en: "Deleting your account deletes the conversations tied to your user.", fa: "حذف حساب شما، گفت‌وگوهای مرتبط با کاربر شما را حذف می‌کند." },
        { en: "Metering metadata is visible to you only as usage counts in your plan's limits.", fa: "فرادادهٔ اندازه‌گیری فقط به‌شمار مصرف در سقف‌های پلن برای شما دیده می‌شود." },
      ],
    },
    {
      id: "contact",
      heading: { en: "Contact", fa: "اطلاعات تماس" },
      paragraphs: [
        { en: "Questions about AI data use can be sent through the privacy contact shown in the Contact section of the Privacy Policy (/privacy) — when that contact is configured. Where it is not configured, the pages display that fact honestly.", fa: "پرسش‌ها دربارهٔ استفاده از داده در هوش مصنوعی را می‌توان از طریق «تماس حریم خصوصی» بخش «اطلاعات تماس» در سیاست حریم خصوصی (/privacy) ارسال کرد — وقتی آن تماس پیکربندی شده باشد. هر جا پیکربندی نشده باشد، صفحات همان واقعیت را صادقانه نشان می‌دهند." },
      ],
    },
  ],
};
