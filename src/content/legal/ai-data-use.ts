import type { LegalDocument } from "./types";

/**
 * AI Data Use — Prompt 27 (§35).
 *
 * Public page explaining the AI subsystem honestly: what is sent to the
 * provider (exactly the Copilot snapshot DTO — snapshot.ts is the source of
 * truth), what is never sent (§11/§12), where conversations are stored
 * (ChatSession/ChatMessage — they ARE persisted, §246), neutral provider
 * language (§9/§44/§113/§114: no fabricated model names), and real user
 * controls only (§39/§153: conversation deletion exists; there is no
 * separate "AI history" setting).
 */

export const aiDataUseDoc: LegalDocument = {
  type: "ai-data-use",
  version: "2026-09-v1",
  effectiveDate: null,
  lastUpdated: "2026-09-27",
  legalReviewRequired: true,
  locales: {
    en: {
      title: "AI Data Use",
      description:
        "What the AI copilot does, exactly which business data it may process, what is stored, what is sent to third-party providers, and what you control.",
      sections: [
        {
          id: "ai-features",
          title: "AI Features",
          blocks: [
            {
              kind: "p",
              text: "AI Business Copilot includes an AI assistant (\"the copilot\") that answers questions about the business workspace you are using. It can summarize performance, explain outstanding invoices and bills, list top products, expense categories, low-stock items and recent payments, and discuss what the recorded figures mean in plain language.",
            },
            {
              kind: "p",
              text: "The copilot is strictly read-only. It cannot create, change or delete any of your records, and it will tell you so if asked. Its usage counts against your plan's AI limits, and every request is metered by the service.",
            },
          ],
        },
        {
          id: "data-sent-to-ai",
          title: "Data Sent to AI",
          blocks: [
            {
              kind: "p",
              text: "When you ask a question, the service assembles a business snapshot on the server and sends it with your question and the recent conversation context. The snapshot contains relevant business information for a time window — not all of your business data:",
            },
            {
              kind: "bullets",
              items: [
                "business name, currency and timezone;",
                "pre-computed key figures for the selected window: revenue, sales count, average sale, cash collected, expenses, cash paid out, net cash flow, collection rate and expense ratio;",
                "a daily timeline of invoiced, collected, expensed and paid-out amounts;",
                "top products by revenue, and expenses grouped by category;",
                "outstanding balances: customers who owe you (open invoices with names and due amounts), suppliers you owe (open bills), and the oldest entries in each;",
                "inventory value, active product count and low-stock items with quantities;",
                "recent payments with amount, method, date and any note you wrote;",
                "your question and the recent messages of the same conversation.",
            ],
            },
            {
              kind: "p",
              text: "All monetary figures are computed by the service and formatted as display strings before the model sees them. The model is instructed to use only figures that appear in the snapshot and to refuse anything else rather than invent it.",
            },
            {
              kind: "p",
              text: "Never sent to the AI provider: passwords and password hashes, session tokens and authentication secrets, payment credentials and provider API keys, internal platform cost data, and other tenants' data. The snapshot is built from an explicit list of fields — the copilot context builder cannot accidentally include whole database objects.",
            },
          ],
        },
        {
          id: "purpose",
          title: "Purpose",
          blocks: [
            {
              kind: "bullets",
              items: [
                "AI response generation and assistant functionality;",
                "business analysis and summarization of your recorded data;",
                "usage measurement (counting AI requests and messages against your plan);",
                "service reliability (detecting failures and keeping answers grounded).",
              ],
            },
            {
              kind: "p",
              text: "Your AI conversations are not used to train other customers' answers, and the service does not run advertising on AI content.",
            },
          ],
        },
        {
          id: "storage",
          title: "Storage",
          blocks: [
            {
              kind: "p",
              text: "Conversations are stored as part of the application's functionality: each business keeps its copilot conversations, and every message is tied to the member who wrote it. Failed requests are not stored. Conversation titles, pinning and renames are stored with the conversation.",
            },
            {
              kind: "p",
              text: "In addition to conversations, the service stores per-request usage metadata (provider/model identifiers and token counts as reported by the provider) for metering. This metadata never contains the content of your prompts or responses.",
            },
          ],
        },
        {
          id: "provider-processing",
          title: "Provider Processing",
          blocks: [
            {
              kind: "p",
              text: "AI requests leave the platform: some AI requests may be processed by third-party AI service providers configured by the platform. The service does not claim that \"AI data never leaves the platform\" — it does.",
            },
            {
              kind: "p",
              text: "The provider processes the request to generate the response. Provider retention and processing terms are governed by the applicable provider documentation and configuration; the service does not claim specific provider retention behavior it has not verified. The service keeps the AI integration provider-agnostic, so it does not publish a specific model name on this page — the model is only recorded internally when the provider genuinely reports one.",
            },
          ],
        },
        {
          id: "limitations",
          title: "Limitations",
          blocks: [
            {
              kind: "bullets",
              items: [
                "AI-generated output may be inaccurate or incomplete.",
                "Answers are grounded in the snapshot described above; figures outside that window or outside the recorded data are refused, not estimated.",
                "AI assistance is informational. It is not accounting, tax, legal or financial advice, and important decisions should be independently reviewed.",
                "The service does not guarantee human review of AI output.",
                "AI availability depends on the configured provider; when the provider is unavailable, asking a question returns a clear error instead of a silent failure.",
              ],
            },
          ],
        },
        {
          id: "user-controls",
          title: "User Controls",
          blocks: [
            {
              kind: "bullets",
              items: [
                "Delete any copilot conversation from the conversation history in the product.",
                "Deleting a business workspace (owner-only) deletes that business's conversations.",
                "Deleting your account deletes the conversations tied to your user.",
                "Metering metadata is visible to you only as usage counts in your plan's limits.",
              ],
            },
            {
              kind: "p",
              text: "These are the controls that exist today. The service does not advertise controls that are not implemented.",
            },
          ],
        },
        {
          id: "contact",
          title: "Contact",
          blocks: [
            {
              kind: "p",
              text: "Questions about AI data use can be sent through the privacy contact shown in the Contact section of the Privacy Policy (/privacy) — when that contact is configured. Where it is not configured, the pages display that fact honestly.",
            },
          ],
        },
      ],
    },
    fa: {
      title: "استفاده از داده در هوش مصنوعی",
      description:
        "دستیار هوشمند چه می‌کند، دقیقاً کدام داده‌های کسب‌وکار ممکن است پردازش شود، چه چیزی ذخیره می‌شود، چه چیزی به ارائه‌دهندگان شخص ثالث می‌رود و چه کنترل‌هایی دارید.",
      sections: [
        {
          id: "ai-features",
          title: "قابلیت‌های هوش مصنوعی",
          blocks: [
            {
              kind: "p",
              text: "دستیار هوشمند کسب‌وکار یک دستیار هوشمند دارد که دربارهٔ فضای کاری‌ای که با آن کار می‌کنید پاسخ می‌دهد. می‌تواند عملکرد را خلاصه کند، فاکتورهای باز و صورت‌حساب‌های پرداخت‌نشده را توضیح دهد، محصولات پرفروش، دسته‌های هزینه، اقلام کم‌موجود و پرداخت‌های اخیر را فهرست کند و معنی ارقام ثبت‌شده را به زبان ساده توضیح دهد.",
            },
            {
              kind: "p",
              text: "دستیار کاملاً فقط‌خواندنی است. نمی‌تواند رکوردی بسازد، تغییر دهد یا حذف کند و اگر بپرسید همین را می‌گوید. مصرف آن در برابر سقف هوش مصنوعی پلن شما شمرده می‌شود و هر درخواست توسط سرویس اندازه‌گیری می‌شود.",
            },
          ],
        },
        {
          id: "data-sent-to-ai",
          title: "داده‌هایی که به هوش مصنوعی ارسال می‌شود",
          blocks: [
            {
              kind: "p",
              text: "وقتی پرسش می‌پرسید، سرویس روی سرور یک تصویر لحظه‌ای از کسب‌وکار می‌سازد و آن را همراه پرسش شما و بافت اخیر گفت‌وگو ارسال می‌کند. این تصویر «اطلاعات مرتبط کسب‌وکار» را برای یک بازهٔ زمانی دارد — نه همهٔ داده‌های کسب‌وکار شما را:",
            },
            {
              kind: "bullets",
              items: [
                "نام کسب‌وکار، واحد پول و منطقهٔ زمانی؛",
                "شاخص‌های کلیدیِ از پیش محاسبه‌شدهٔ بازهٔ انتخابی: درآمد، تعداد فروش، میانگین فروش، وجه جمع‌آوری‌شده، هزینه‌ها، وجوه پرداخت‌شده، جریان نقدی خالص، نرخ وصول و نسبت هزینه؛",
                "جدول زمانی روزانهٔ فاکتور، وصول، هزینه و پرداخت؛",
                "محصولات پرفروش بر اساس درآمد و هزینه‌های گروه‌بندی‌شده بر اساس دسته؛",
                "مانده‌های باز: مشتریانی که به شما بدهکارند (فاکتورهای باز با نام و مبلغ باقی‌مانده)، تأمین‌کنندگانی که به آن‌ها بدهکارید (صورت‌حساب‌های باز) و قدیمی‌ترین موارد هر گروه؛",
                "ارزش موجودی، تعداد محصولات فعال و اقلام کم‌موجود با تعداد؛",
                "پرداخت‌های اخیر با مبلغ، روش، تاریخ و یادداشتی که نوشته‌اید؛",
                "پرسش شما و پیام‌های اخیر همان گفت‌وگو.",
              ],
            },
            {
              kind: "p",
              text: "همهٔ ارقام مالی توسط سرویس محاسبه و پیش از دیدن مدل به‌صورت رشتهٔ نمایشی قالب‌بندی می‌شوند. به مدل دستور داده می‌شود فقط از ارقام موجود در تصویر استفاده کند و هر چیز دیگری را به‌جای ساختن، رد کند.",
            },
            {
              kind: "p",
              text: "هرگز به ارائه‌دهندهٔ هوش مصنوعی ارسال نمی‌شود: رمزهای عبور و هش آن‌ها، توکن‌های نشست و اسرار احراز هویت، اعتبارنامه‌های پرداخت و کلیدهای API ارائه‌دهندگان، داده‌های داخلی هزینهٔ پلتفرم، و داده‌های اجاره‌نشین‌های دیگر. تصویر از فهرست مشخصی از فیلدها ساخته می‌شود — سازندهٔ بافت دستیار نمی‌تواند تصادفاً شیء کامل پایگاه داده را وارد کند.",
            },
          ],
        },
        {
          id: "purpose",
          title: "هدف",
          blocks: [
            {
              kind: "bullets",
              items: [
                "تولید پاسخ هوش مصنوعی و کارکرد دستیار؛",
                "تحلیل کسب‌وکار و خلاصه‌سازی داده‌های ثبت‌شدهٔ شما؛",
                "اندازه‌گیری مصرف (شمارش درخواست‌ها و پیام‌ها در برابر سقف پلن)؛",
                "قابلیت اطمینان سرویس (شناسایی خطا و مستند ماندن پاسخ‌ها).",
              ],
            },
            {
              kind: "p",
              text: "گفت‌وگوهای هوش مصنوعی شما برای آموزش پاسخ‌های مشتریان دیگر استفاده نمی‌شود و سرویس روی محتوای هوش مصنوعی تبلیغات اجرا نمی‌کند.",
            },
          ],
        },
        {
          id: "storage",
          title: "ذخیره‌سازی",
          blocks: [
            {
              kind: "p",
              text: "گفت‌وگوها به‌عنوان بخشی از کارکرد برنامه ذخیره می‌شوند: هر کسب‌وکار گفت‌وگوهای دستیار خودش را دارد و هر پیام به عضوی که نوشته گره خورده است. درخواست‌های ناموفق ذخیره نمی‌شوند. عنوان گفت‌وگو، سنجاق‌شدن و تغییر نام همراه خود گفت‌وگو ذخیره می‌شود.",
            },
            {
              kind: "p",
              text: "علاوه بر گفت‌وگوها، سرویس فرادادهٔ مصرف هر درخواست (شناسهٔ ارائه‌دهنده/مدل و تعداد توکنِ گزارش‌شده توسط ارائه‌دهنده) را برای اندازه‌گیری ذخیره می‌کند. این فراداده هرگز شامل محتوای پرسش‌ها و پاسخ‌های شما نیست.",
            },
          ],
        },
        {
          id: "provider-processing",
          title: "پردازش سمت ارائه‌دهنده",
          blocks: [
            {
              kind: "p",
              text: "درخواست‌های هوش مصنوعی از پلتفرم خارج می‌شوند: بخشی از درخواست‌ها ممکن است توسط ارائه‌دهندگان خدمات هوش مصنوعی شخص ثالثِ پیکربندی‌شده در پلتفرم پردازش شود. سرویس ادعا نمی‌کند که «دادهٔ هوش مصنوعی هرگز پلتفرم را ترک نمی‌کند» — می‌کند.",
            },
            {
              kind: "p",
              text: "ارائه‌دهنده درخواست را برای تولید پاسخ پردازش می‌کند. نگه‌داری و پردازش سمت ارائه‌دهنده تابع مستندات و پیکربندی همان ارائه‌دهنده است؛ سرویس رفتار نگه‌داری ارائه‌دهنده‌ای را که راستی‌آزمایی نکرده ادعا نمی‌کند. یکپارچه‌سازی هوش مصنوعی عمداً مستقل از ارائه‌دهنده نگه‌داری می‌شود، به همین دلیل این صفحه نام مدل مشخصی منتشر نمی‌کند — مدل فقط وقتی در درون ثبت می‌شود که ارائه‌دهنده واقعاً آن را گزارش کرده باشد.",
            },
          ],
        },
        {
          id: "limitations",
          title: "محدودیت‌ها",
          blocks: [
            {
              kind: "bullets",
              items: [
                "خروجی هوش مصنوعی ممکن است نادرست یا ناقص باشد.",
                "پاسخ‌ها بر اساس همان تصویر توضیح‌داده‌شده مستندند؛ ارقام بیرون از آن بازه یا بیرون از داده‌های ثبت‌شده رد می‌شوند، نه تخمین زده می‌شوند.",
                "کمک هوش مصنوعی اطلاع‌رسانانه است. مشاورهٔ حسابداری، مالیاتی، حقوقی یا مالی نیست و تصمیم‌های مهم باید مستقلاً بازبینی شوند.",
                "سرویس بازبینی انسانی خروجی هوش مصنوعی را تضمین نمی‌کند.",
                "دسترس‌پذیری هوش مصنوعی به ارائه‌دهندهٔ پیکربندی‌شده وابسته است؛ وقتی ارائه‌دهنده در دسترس نباشد، پرسیدن پرسش خطای روشن برمی‌گرداند نه شکستِ خاموش.",
              ],
            },
          ],
        },
        {
          id: "user-controls",
          title: "کنترل‌های شما",
          blocks: [
            {
              kind: "bullets",
              items: [
                "حذف هر گفت‌وگوی دستیار از تاریخچهٔ گفت‌وگو در محصول.",
                "حذف فضای کاری کسب‌وکار (فقط مالک) گفت‌وگوهای آن کسب‌وکار را حذف می‌کند.",
                "حذف حساب شما، گفت‌وگوهای مرتبط با کاربر شما را حذف می‌کند.",
                "فرادادهٔ اندازه‌گیری فقط به‌شمار مصرف در سقف‌های پلن برای شما دیده می‌شود.",
              ],
            },
            {
              kind: "p",
              text: "این‌ها کنترل‌های موجود امروز هستند. سرویس کنترل‌هایی که پیاده‌سازی نشده‌اند را تبلیغ نمی‌کند.",
            },
          ],
        },
        {
          id: "contact",
          title: "اطلاعات تماس",
          blocks: [
            {
              kind: "p",
              text: "پرسش‌ها دربارهٔ استفاده از داده در هوش مصنوعی را می‌توان از طریق «تماس حریم خصوصی» بخش «اطلاعات تماس» در سیاست حریم خصوصی (/privacy) ارسال کرد — وقتی آن تماس پیکربندی شده باشد. هر جا پیکربندی نشده باشد، صفحات همان واقعیت را صادقانه نشان می‌دهند.",
            },
          ],
        },
      ],
    },
  },
};
