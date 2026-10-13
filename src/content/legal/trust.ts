/**
 * Trust page content — Prompt 27 §135-§141.
 *
 * HIGH-LEVEL factual information only:
 * - states ONLY controls that are actually implemented (verified in code:
 *   server-side authorization pipeline, tenant isolation, bcrypt password
 *   hashing, zod input validation, rate limiting, append-only audit log,
 *   CSV formula-injection guard, server-enforced entitlements);
 * - NO "certified security", no audit claim, no backup claim, no uptime
 *   percentage, no "100% secure", no "hallucination-free" (§139/§140/§141);
 * - reveals no database topology, secrets, internal IDs or attack-sensitive
 *   details (§136).
 */

import type { LegalDocumentContent } from "./types";

export const trustContent: LegalDocumentContent = {
  key: "trust",
  title: { en: "Trust", fa: "اعتماد و شفافیت" },
  intro: [
    {
      en: "This page describes, at a high level, how AI Business Copilot approaches security and privacy. It lists only practices that are actually implemented in the product, and it is honest about what has not been done — the product has not been independently audited and holds no security certification.",
      fa: "این صفحه در سطح کلی توضیح می‌دهد که «دستیار هوشمند کسب‌وکار» چگونه به امنیت و حریم خصوصی نگاه می‌کند. فقط روش‌هایی فهرست می‌شوند که واقعاً در محصول پیاده‌سازی شده‌اند و صادقانه گفته می‌شود چه چیزهایی هنوز انجام نشده است — این محصول به‌صورت مستقل ممیزی نشده و هیچ گواهی امنیتی ندارد.",
    },
  ],
  sections: [
    {
      id: "isolation",
      heading: { en: "Business data stays in its own workspace", fa: "داده‌های هر کسب‌وکار در فضای خودش می‌ماند" },
      paragraphs: [
        {
          en: "Every business is a separate workspace. The server checks, on every request, who you are and which business you are working in, and serves records only from that workspace. Accessing another business's data is blocked on the server — not merely hidden in the interface.",
          fa: "هر کسب‌وکار یک فضای کاری جداگانه است. سرور در هر درخواست بررسی می‌کند که شما چه کسی هستید و در کدام کسب‌وکار کار می‌کنید، و رکوردها را فقط از همان فضای کاری ارائه می‌دهد. دسترسی به دادهٔ کسب‌وکار دیگر در سمت سرور مسدود است — نه صرفاً در رابط کاربری پنهان.",
        },
      ],
    },
    {
      id: "controls",
      heading: { en: "Security practices in the product", fa: "روش‌های امنیتی در محصول" },
      paragraphs: [
        {
          en: "The product implements the following technical controls:",
          fa: "محصول کنترل‌های فنی زیر را پیاده‌سازی کرده است:",
        },
      ],
      bullets: [
        {
          en: "server-side authorization on every request, with role-based access control per business member;",
          fa: "مجوزدهی سمت سرور در هر درخواست، با کنترل دسترسی مبتنی بر نقش برای هر عضو کسب‌وکار؛",
        },
        {
          en: "passwords stored as hashes, never in readable form;",
          fa: "ذخیرهٔ گذرواژه‌ها به‌صورت هش، هرگز به‌شکل خوانا؛",
        },
        {
          en: "input validation on the server for every write operation;",
          fa: "اعتبارسنجی ورودی در سمت سرور برای هر عملیات نوشتن؛",
        },
        {
          en: "rate limiting on sensitive operations such as sign-in, exports and destructive actions;",
          fa: "محدودسازی نرخ روی عملیات حساس مانند ورود، خروجی گرفتن و عملیات مخرب؛",
        },
        {
          en: "an append-only audit log for sensitive actions, visible to authorized roles;",
          fa: "یک دفتر حسابرسی فقط‌افزودنی برای اقدامات حساس، قابل مشاهده برای نقش‌های مجاز؛",
        },
        {
          en: "protections on exported CSV files against formula-injection;",
          fa: "محافظت فایل‌های CSV خروجی در برابر تزریق فرمول؛",
        },
        {
          en: "plan limits and entitlements enforced on the server.",
          fa: "اعمال محدودیت‌ها و مجوزهای طرح در سمت سرور.",
        },
      ],
    },
    {
      id: "privacy-principles",
      heading: { en: "Privacy principles", fa: "اصول حریم خصوصی" },
      paragraphs: [
        {
          en: "The product collects what it needs to provide the service, stores business data in the workspace it belongs to, and gives you real controls: edit your data, export it where supported, delete your conversations, and delete your account or business. The Privacy Policy and the AI Data Use page describe actual behavior rather than aspirations.",
          fa: "محصول آنچه را برای ارائهٔ خدمات لازم است جمع‌آوری می‌کند، داده‌های کسب‌وکار را در فضای کاری خودش نگه می‌دارد و کنترل‌های واقعی به شما می‌دهد: ویرایش داده‌ها، خروجی گرفتن در موارد پشتیبانی‌شده، حذف گفتگوها و حذف حساب یا کسب‌وکار. «سیاست حفظ حریم خصوصی» و صفحهٔ «استفاده از داده در هوش مصنوعی» رفتار واقعی را توصیف می‌کنند، نه آرزوها را.",
        },
      ],
    },
    {
      id: "ai-limits",
      heading: { en: "AI limitations", fa: "محدودیت‌های هوش مصنوعی" },
      paragraphs: [
        {
          en: "The AI copilot computes answers from your recorded business data and shows where its numbers come from. AI-generated explanations may still contain errors and deserve review — business metrics are calculated from recorded application data, while AI explanations of those metrics are assistance, not authority.",
          fa: "دستیار هوشمند پاسخ‌ها را از داده‌های ثبت‌شدهٔ کسب‌وکارتان محاسبه می‌کند و منبع اعداد را نشان می‌دهد. با این حال ممکن است توضیحات تولیدشده توسط هوش مصنوعی خطا داشته باشند و ارزش بازبینی دارند — سنجه‌های کسب‌وکاری از داده‌های ثبت‌شدهٔ برنامه محاسبه می‌شوند، در حالی که توضیحات هوش مصنوعی دربارهٔ آن‌ها کمک است، نه مرجع.",
        },
      ],
    },
    {
      id: "your-copies",
      heading: { en: "Your own copies of your data", fa: "نسخهٔ خودتان از داده‌هایتان" },
      paragraphs: [
        {
          en: "Business owners and admins can download a complete export of their business data from the product, and CSV exports are available for supported lists and reports. Keeping your own copies of important data is a good practice for any business tool.",
          fa: "مالکان و مدیران کسب‌وکار می‌توانند خروجی کامل داده‌های کسب‌وکار خود را از داخل محصول دانلود کنند و خروجی CSV برای فهرست‌ها و گزارش‌های پشتیبانی‌شده در دسترس است. نگه داشتن نسخهٔ خودتان از داده‌های مهم برای هر ابزار کسب‌وکاری روش خوبی است.",
        },
      ],
    },
    {
      id: "honesty",
      heading: { en: "What we are not claiming", fa: "آنچه ادعا نمی‌کنیم" },
      paragraphs: [
        {
          en: "The product has not been independently audited and does not hold a security certification. No service can promise perfect security, and this page does not. The practices above describe what is implemented today; as the product grows, this page is updated to stay accurate.",
          fa: "این محصول به‌صورت مستقل ممیزی نشده و گواهی امنیتی ندارد. هیچ سرویسی نمی‌تواند امنیت کامل را وعده دهد و این صفحه هم نمی‌دهد. روش‌های بالا توصیف پیاده‌سازی امروز است؛ با رشد محصول، این صفحه برای حفظ درستی به‌روزرسانی می‌شود.",
        },
      ],
    },
    {
      id: "contact",
      heading: { en: "Contact", fa: "تماس با ما" },
      paragraphs: [],
    },
  ],
};
