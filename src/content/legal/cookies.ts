import type { LegalDocument } from "./types";

/**
 * Cookie Policy — Prompt 27 (§45/§46/§47).
 *
 * Created because the application genuinely uses non-essential cookies
 * (a first-party analytics key and a UI preference cookie) — not "because
 * it sounds complete". Only ACTUAL cookies, with their ACTUAL attributes,
 * are documented here (funnel-cookie.ts and NextAuth v4 defaults are the
 * sources). No consent banner is used: there is no third-party tracking
 * to consent to (§46/§48).
 */

export const cookiesDoc: LegalDocument = {
  type: "cookies",
  version: "2026-09-v1",
  effectiveDate: null,
  lastUpdated: "2026-09-27",
  legalReviewRequired: true,
  locales: {
    en: {
      title: "Cookie Policy",
      description:
        "The exact cookies AI Business Copilot sets, what each is for, and how to control them.",
      sections: [
        {
          id: "about-cookies",
          title: "About Cookies",
          blocks: [
            {
              kind: "p",
              text: "Cookies are small values a website stores in your browser. This page lists every cookie the service sets, by name, with its actual purpose. The service does not use third-party tracking cookies, advertising cookies or fingerprinting, so there is no consent banner: nothing here needs a permission dialog to behave honestly.",
            },
          ],
        },
        {
          id: "essential",
          title: "Essential Cookies",
          blocks: [
            {
              kind: "table",
              head: ["Cookie", "Purpose", "Attributes"],
              rows: [
                [
                  "next-auth.session-token",
                  "Keeps you signed in (authentication session).",
                  "Set by the authentication framework; HttpOnly; SameSite=Lax; Path=/; Secure when served over HTTPS.",
                ],
                [
                  "next-auth.csrf-token",
                  "Protects sign-in requests against cross-site request forgery.",
                  "HttpOnly is not set for this token by design; SameSite=Lax; Path=/.",
                ],
                [
                  "next-auth.callback-url",
                  "Remembers where to send you after signing in.",
                  "SameSite=Lax; Path=/.",
                ],
              ],
            },
            {
              kind: "p",
              text: "These cookies are required for the service to function. Blocking them in your browser means you cannot sign in.",
            },
          ],
        },
        {
          id: "preferences",
          title: "Preference Storage",
          blocks: [
            {
              kind: "table",
              head: ["Name", "Purpose", "Attributes"],
              rows: [
                [
                  "sidebar_state",
                  "Remembers whether the navigation sidebar is open or collapsed.",
                  "Set by the app in your browser; expires after 7 days; first-party.",
                ],
                [
                  "abc-preferences (local storage, not a cookie)",
                  "Remembers your language (English/Persian) and active business selection.",
                  "Browser local storage on your device; never sent to the service.",
                ],
              ],
            },
            {
              kind: "p",
              text: "Preference storage is optional; deleting it only resets the interface defaults.",
            },
          ],
        },
        {
          id: "analytics",
          title: "First-Party Analytics",
          blocks: [
            {
              kind: "table",
              head: ["Cookie", "Purpose", "Attributes"],
              rows: [
                [
                  "copilot_funnel",
                  "An anonymous, random key that lets the service measure its own signup and pricing funnel in aggregate (for example, how many pricing visitors create accounts). It is not a fingerprint and is not linked to advertising.",
                  "Set by the server; random UUID issued once; Path=/; expires after 180 days; SameSite=Lax; first-party only.",
                ],
              ],
            },
            {
              kind: "p",
              text: "When you are signed in, funnel events may additionally be associated with your account and business so the service can measure onboarding per business. This is first-party measurement: no external analytics provider receives it.",
            },
          ],
        },
        {
          id: "managing",
          title: "Managing Cookies",
          blocks: [
            {
              kind: "bullets",
              items: [
                "Your browser's settings let you view, delete and block cookies per site.",
                "Deleting the session cookie signs you out; deleting preference values resets the interface.",
                "Blocking the analytics cookie does not limit any feature — it only removes your visit's contribution to aggregate funnel counts.",
              ],
            },
          ],
        },
        {
          id: "changes",
          title: "Changes",
          blocks: [
            {
              kind: "p",
              text: "If the service adds a cookie category, this page is updated with the exact name and purpose before or together with the change. The version at the top of this page changes with material updates.",
            },
          ],
        },
        {
          id: "contact",
          title: "Contact",
          blocks: [
            {
              kind: "p",
              text: "Questions about cookies can be sent through the contacts shown in the Privacy Policy (/privacy), based on the service's live configuration.",
            },
          ],
        },
      ],
    },
    fa: {
      title: "سیاست کوکی",
      description:
        "کوکی‌های دقیقی که دستیار هوشمند کسب‌وکار تنظیم می‌کند، هدف هرکدام و راه کنترل آن‌ها.",
      sections: [
        {
          id: "about-cookies",
          title: "دربارهٔ کوکی‌ها",
          blocks: [
            {
              kind: "p",
              text: "کوکی‌ها مقادیر کوچکی هستند که یک وب‌سایت در مرورگر شما ذخیره می‌کند. این صفحه هر کوکی‌ای که سرویس تنظیم می‌کند را با نام و هدف واقعی‌اش فهرست می‌کند. سرویس از کوکی ردیابی شخص ثالث، کوکی تبلیغاتی یا اثرانگشت‌گیری استفاده نمی‌کند؛ بنابراین بنر رضایت وجود ندارد: هیچ‌جای این صفحه برای صادقانه بودن به گفت‌وگوی اجازه نیاز ندارد.",
            },
          ],
        },
        {
          id: "essential",
          title: "کوکی‌های ضروری",
          blocks: [
            {
              kind: "table",
              head: ["کوکی", "هدف", "ویژگی‌ها"],
              rows: [
                [
                  "next-auth.session-token",
                  "شما را واردنگه می‌دارد (نشست احراز هویت).",
                  "تنظیم‌شده توسط چارچوب احراز هویت؛ HttpOnly؛ SameSite=Lax؛ Path=/؛ در حالت HTTPS ویژگی Secure.",
                ],
                [
                  "next-auth.csrf-token",
                  "از درخواست‌های ورود در برابر جعل درخواست بین‌سایتی محافظت می‌کند.",
                  "این توکن عمداً HttpOnly ندارد؛ SameSite=Lax؛ Path=/.",
                ],
                [
                  "next-auth.callback-url",
                  "به خاطر می‌سپارد پس از ورود به کجا هدایت شوید.",
                  "SameSite=Lax؛ Path=/.",
                ],
              ],
            },
            {
              kind: "p",
              text: "این کوکی‌ها برای کارکرد سرویس ضروری‌اند. مسدود کردن آن‌ها در مرورگر یعنی نمی‌توانید وارد شوید.",
            },
          ],
        },
        {
          id: "preferences",
          title: "ذخیره‌سازی ترجیحات",
          blocks: [
            {
              kind: "table",
              head: ["نام", "هدف", "ویژگی‌ها"],
              rows: [
                [
                  "sidebar_state",
                  "به خاطر می‌سپارد نوار کناری باز است یا جمع‌شده.",
                  "توسط برنامه در مرورگر شما؛ پس از ۷ روز منقضی می‌شود؛ first-party.",
                ],
                [
                  "abc-preferences (حافظهٔ محلی، نه کوکی)",
                  "زبان (انگلیسی/فارسی) و کسب‌وکار فعال شما را نگه می‌دارد.",
                  "حافظهٔ محلی مرورگر روی دستگاه شما؛ هرگز به سرویس ارسال نمی‌شود.",
                ],
              ],
            },
            {
              kind: "p",
              text: "ذخیره‌سازی ترجیحات اختیاری است؛ حذف آن فقط پیش‌فرض‌های رابط را بازنشانی می‌کند.",
            },
          ],
        },
        {
          id: "analytics",
          title: "تحلیل first-party",
          blocks: [
            {
              kind: "table",
              head: ["کوکی", "هدف", "ویژگی‌ها"],
              rows: [
                [
                  "copilot_funnel",
                  "کلید ناشناس و تصادفی‌ای که به سرویس اجازه می‌دهد مسیر ثبت‌نام و قیمت‌گذاری خودش را به‌صورت تجمیعی اندازه بگیرد (مثلاً چند بازدیدکنندهٔ قیمت‌گذاری حساب می‌سازد). اثرانگشت نیست و با تبلیغات پیوند ندارد.",
                  "تنظیم توسط سرور؛ یک بار UUID تصادفی صادر می‌شود؛ Path=/؛ پس از ۱۸۰ روز منقضی می‌شود؛ SameSite=Lax؛ فقط first-party.",
                ],
              ],
            },
            {
              kind: "p",
              text: "وقتی وارد شده باشید، رخدادهای مسیر ممکن است علاوه بر آن با حساب و کسب‌وکار شما هم مرتبط شوند تا سرویس آنبوردینگ را برای هر کسب‌وکار بسنجد. این اندازه‌گیری first-party است: هیچ ارائه‌دهندهٔ تحلیل بیرونی آن را دریافت نمی‌کند.",
            },
          ],
        },
        {
          id: "managing",
          title: "مدیریت کوکی‌ها",
          blocks: [
            {
              kind: "bullets",
              items: [
                "تنظیمات مرورگر شما امکان دیدن، حذف و مسدود کردن کوکی هر سایت را می‌دهد.",
                "حذف کوکی نشست شما را خارج می‌کند؛ حذف مقادیر ترجیحات، رابط را بازنشانی می‌کند.",
                "مسدود کردن کوکی تحلیلی هیچ قابلیتی را محدود نمی‌کند — فقط سهم بازدید شما از شمارش تجمعی مسیر حذف می‌شود.",
              ],
            },
          ],
        },
        {
          id: "changes",
          title: "تغییرات",
          blocks: [
            {
              kind: "p",
              text: "اگر سرویس دستهٔ کوکی تازه‌ای اضافه کند، این صفحه با نام و هدف دقیق، هم‌زمان یا پیش از تغییر به‌روزرسانی می‌شود. با تغییرات مهم، نسخهٔ بالای این صفحه تغییر می‌کند.",
            },
          ],
        },
        {
          id: "contact",
          title: "اطلاعات تماس",
          blocks: [
            {
              kind: "p",
              text: "پرسش‌ها دربارهٔ کوکی‌ها را می‌توان از طریق تماس‌های نشان‌داده‌شده در سیاست حریم خصوصی (/privacy) و بر اساس پیکربندی زندهٔ سرویس ارسال کرد.",
            },
          ],
        },
      ],
    },
  },
};
