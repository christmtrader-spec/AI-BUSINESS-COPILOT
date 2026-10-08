/**
 * Prompt 42 (§243) — i18n key inserter for en.ts + fa.ts.
 * Inserts the goodsReceipts namespace + nav/search/portability keys.
 * Idempotent: skips insertions whose anchor result is already present.
 */
import { readFileSync, writeFileSync } from "node:fs";

const EN = "src/i18n/messages/en.ts";
const FA = "src/i18n/messages/fa.ts";

function insertAfter(content, anchor, addition) {
  if (content.includes(addition.trim().split("\n")[0])) return content; // idempotent
  const idx = content.indexOf(anchor);
  if (idx === -1) throw new Error(`anchor not found: ${anchor.slice(0, 60)}`);
  return content.slice(0, idx + anchor.length) + addition + content.slice(idx + anchor.length);
}

const EN_NAV = `    purchaseOrders: "Purchase Orders",\n`;
const EN_NAV_ADD = `    goodsReceipts: "Goods Receipts",\n`;

const FA_NAV = `    purchaseOrders: "سفارش‌های خرید",\n`;
const FA_NAV_ADD = `    goodsReceipts: "رسیدهای انبار",\n`;

const EN_GROUP = `      PURCHASE_ORDER: "Purchase Orders",\n`;
const EN_GROUP_ADD = `      GOODS_RECEIPT: "Goods Receipts",\n`;
const FA_GROUP = `      PURCHASE_ORDER: "سفارش‌های خرید",\n`;
const FA_GROUP_ADD = `      GOODS_RECEIPT: "رسیدهای انبار",\n`;

const EN_STATUS = `      CONFIRMED: "Confirmed",\n`;
const EN_STATUS_ADD = `      POSTED: "Posted",\n`;
const FA_STATUS = `      CONFIRMED: "تأییدشده",\n`;
const FA_STATUS_ADD = `      POSTED: "ثبت‌شده",\n`;

const EN_DATASETS = `      purchaseOrderLines: "Purchase order lines",\n`;
const EN_DATASETS_ADD = `      inventoryGoodsReceipts: "Goods receipts",\n      inventoryGoodsReceiptLines: "Goods receipt lines",\n`;
const FA_DATASETS = `      purchaseOrderLines: "ردیف‌های سفارش خرید",\n`;
const FA_DATASETS_ADD = `      inventoryGoodsReceipts: "رسیدهای انبار",\n      inventoryGoodsReceiptLines: "خطاهای رسید انبار",\n`;

const EN_NAMESPACE = `
  goodsReceipts: {
    title: "Goods Receipts",
    listSubtitle: "Physical goods received against confirmed purchase orders — inventory evidence, not money.",
    createAction: "Record goods receipt",
    createTitle: "Record goods receipt",
    createDesc: "Prepare a receiving document against a confirmed purchase order. Stock changes only when it is posted.",
    searchLabel: "Search",
    searchPlaceholder: "Reference, purchase order or product…",
    status: "Status",
    statusAll: "All statuses",
    fromDate: "From (created)",
    toDate: "To (created)",
    loadFailed: "Goods receipts could not be loaded.",
    noReceipts: "No goods receipts yet",
    noReceiptsDesc: "Record your first receiving document against a confirmed purchase order.",
    reference: "Reference",
    referenceOptional: "Reference (optional)",
    referencePlaceholder: "e.g. GR-2026-001",
    referenceHint: "Leave blank and the server generates a unique reference automatically.",
    notes: "Notes",
    notesPlaceholder: "Delivery condition, packaging, driver…",
    purchaseOrder: "Purchase order",
    poSearch: "Confirmed purchase orders available for receiving",
    noOrdersFound: "No confirmed purchase orders with remaining quantities.",
    selected: "Selected",
    invalidOrder: "Purchase order not found.",
    invalidDate: "Please use a valid calendar date.",
    duplicateReference: "A goods receipt with this reference already exists.",
    createdToast: "Goods receipt {reference} created.",
    updatedToast: "Goods receipt updated.",
    lines: "Lines",
    linesTitle: "Products received on this document",
    noLines: "No products on this receipt yet.",
    addLine: "Add purchase order line",
    addLineAction: "Add to receipt",
    addLineTitle: "Select a purchase order line",
    addLineSearch: "Lines with remaining quantity on this order",
    noLinesFound: "No purchase order lines with remaining quantity.",
    product: "Product",
    sku: "SKU",
    unit: "Unit",
    ordered: "Ordered",
    received: "Received",
    receivedQty: "Received quantity",
    remaining: "Remaining",
    orderedTotal: "Ordered",
    receivedTotal: "Received",
    remainingTotal: "Remaining",
    totalReceived: "Total received",
    invalidQty: "Quantity must be a whole number between 1 and 1,000,000.",
    duplicateLine: "This purchase order line is already on the receipt.",
    lineLimit: "Goods receipt line limit reached.",
    lineAddedToast: "Product added to the receipt.",
    lineUpdatedToast: "Line updated.",
    lineRemovedToast: "Product removed from the receipt.",
    editLine: "Edit line",
    editLineTitle: "Edit received quantity",
    saveLine: "Save line",
    removeLine: "Remove line",
    removeLineTitle: "Remove product",
    removeLineDesc: "Remove {product} from this draft receipt?",
    removeAction: "Remove",
    readOnlyNote: "This receipt is read-only — physical stock already moved when it was posted.",
    inventoryNote: "Posting this receipt increases current inventory. It does not create any financial record.",
    postAction: "Post receipt",
    postTitle: "Post this receipt?",
    postDesc: "Received quantities are added to current inventory now.",
    postConfirm: "Post receipt",
    postToast: "Goods receipt posted — inventory updated.",
    postWarning: "Posting this receipt will increase current inventory. It cannot be edited or cancelled after posting.",
    postEmpty: "Add at least one line before posting.",
    cancelAction: "Cancel receipt",
    cancelTitle: "Cancel this receipt?",
    cancelDesc: "The draft is cancelled permanently. Nothing was posted, so inventory is unchanged.",
    cancelConfirm: "Cancel receipt",
    cancelToast: "Goods receipt cancelled.",
    cancelTerminalWarning: "Cancellation is terminal. This draft never changed inventory, so there is nothing to reverse.",
    staleRemaining: "The remaining quantity changed. Review the receipt before posting.",
    exceedsRemaining: "That would receive more than the remaining quantity on this line.",
    poNotReceivable: "Goods can be received only against a confirmed purchase order.",
    productNotFound: "A product on this receipt no longer exists.",
    stockOverflow: "Receiving this quantity would exceed the stock storage limit.",
    immutable: "This receipt can no longer be changed.",
    invalidTransition: "This status change is not allowed.",
    notFoundTitle: "Goods receipt not found",
    notFoundDesc: "It may belong to another business or no longer exist.",
    backToList: "Back to goods receipts",
    openPurchaseOrder: "Open purchase order",
    postedAtLabel: "Posted",
    cancelledAtLabel: "Cancelled",
    createdAtLabel: "Created",
    createdBy: "Created by",
    receivingSummary: "Receiving",
    recordReceipt: "Record Goods Receipt",
    fullyReceivedLabel: "Fully received",
    partiallyReceivedLabel: "{received} of {ordered} received",
    receivingBlockedClosed: "This order is closed — receiving is no longer possible.",
    closeWarning: "Closing prevents further goods receipt. Unreceived quantities remain unreceived. No financial payable is created.",
    recentReceipts: "Recent goods receipts",
    noRecentReceipts: "No goods receipts against this order yet.",
    productHistory: "Recent goods receipts",
    noProductHistory: "No goods receipts mention this product yet.",
    supplierHistory: "Recent goods receipts",
    noSupplierHistory: "No goods receipts mention this supplier yet.",
    poCancelledWithReceipts: "This purchase order has posted goods receipts and can no longer be cancelled.",
    exportAction: "Export CSV",
    exportToast: "CSV exported.",
    exportFailed: "Export failed — please try again.",
    exportRateLimited: "Too many exports. Please wait a moment.",
    exportForbidden: "Your plan does not include CSV export.",
    copyLink: "Copy link",
    status_DRAFT: "Draft",
    status_POSTED: "Posted",
    status_CANCELLED: "Cancelled",
    csvReference: "reference",
    csvStatus: "status",
    csvPurchaseOrderReference: "purchase_order_reference",
    csvSupplier: "supplier",
    csvProduct: "product",
    csvSku: "sku",
    csvUnit: "unit",
    csvReceivedQty: "received_qty",
    csvPostedAt: "posted_at",
    detailSubtitle: "Receiving document for {supplier}",
  },
`;

const FA_NAMESPACE = `
  goodsReceipts: {
    title: "رسیدهای انبار",
    listSubtitle: "دریافت فیزیکی کالا نسبت به سفارش‌های خرید تأییدشده — سند انباری، نه مالی.",
    createAction: "ثبت رسید انبار",
    createTitle: "ثبت رسید انبار",
    createDesc: "سند دریافت نسبت به یک سفارش خرید تأییدشده آماده کنید. موجودی فقط هنگام ثبت نهایی تغییر می‌کند.",
    searchLabel: "جستجو",
    searchPlaceholder: "شماره رسید، سفارش خرید یا کالا…",
    status: "وضعیت",
    statusAll: "همه وضعیت‌ها",
    fromDate: "از (تاریخ ایجاد)",
    toDate: "تا (تاریخ ایجاد)",
    loadFailed: "بارگذاری رسیدهای انبار ممکن نشد.",
    noReceipts: "هنوز رسیدی ثبت نشده است",
    noReceiptsDesc: "نخستین سند دریافت را نسبت به یک سفارش خرید تأییدشده ثبت کنید.",
    reference: "شماره رسید",
    referenceOptional: "شماره رسید (اختیاری)",
    referencePlaceholder: "مثلاً GR-2026-001",
    referenceHint: "خالی بگذارید تا سیستم به‌صورت خودکار یک شماره یکتا بسازد.",
    notes: "یادداشت",
    notesPlaceholder: "وضعیت مرسوله، بسته‌بندی، راننده…",
    purchaseOrder: "سفارش خرید",
    poSearch: "سفارش‌های خرید تأییدشدهٔ آمادهٔ دریافت",
    noOrdersFound: "سفارش خرید تأییدشده‌ای با مقدار باقی‌مانده وجود ندارد.",
    selected: "انتخاب‌شده",
    invalidOrder: "سفارش خرید پیدا نشد.",
    invalidDate: "تاریخ تقویمی معتبر وارد کنید.",
    duplicateReference: "رسیدی با این شماره از قبل وجود دارد.",
    createdToast: "رسید انبار {reference} ایجاد شد.",
    updatedToast: "رسید انبار به‌روزرسانی شد.",
    lines: "خطوط",
    linesTitle: "کالاهای دریافت‌شده در این سند",
    noLines: "هنوز کالایی در این رسید ثبت نشده است.",
    addLine: "افزودن خط سفارش خرید",
    addLineAction: "افزودن به رسید",
    addLineTitle: "انتخاب خط سفارش خرید",
    addLineSearch: "خطوط با مقدار باقی‌مانده در این سفارش",
    noLinesFound: "خط سفارشی با مقدار باقی‌مانده وجود ندارد.",
    product: "کالا",
    sku: "کد کالا",
    unit: "واحد",
    ordered: "سفارش‌داده‌شده",
    received: "دریافت‌شده",
    receivedQty: "مقدار دریافت‌شده",
    remaining: "باقی‌مانده",
    orderedTotal: "سفارش‌داده‌شده",
    receivedTotal: "دریافت‌شده",
    remainingTotal: "باقی‌مانده",
    totalReceived: "مجموع دریافت",
    invalidQty: "مقدار باید عدد صحیح بین ۱ تا ۱٬۰۰۰٬۰۰۰ باشد.",
    duplicateLine: "این خط از سفارش خرید از قبل در رسید ثبت شده است.",
    lineLimit: "به سقف خطوط رسید انبار رسیدید.",
    lineAddedToast: "کالا به رسید اضافه شد.",
    lineUpdatedToast: "خط به‌روزرسانی شد.",
    lineRemovedToast: "کالا از رسید حذف شد.",
    editLine: "ویرایش خط",
    editLineTitle: "ویرایش مقدار دریافت‌شده",
    saveLine: "ذخیره خط",
    removeLine: "حذف خط",
    removeLineTitle: "حذف کالا",
    removeLineDesc: "«{product}» از این پیش‌نویس رسید حذف شود؟",
    removeAction: "حذف",
    readOnlyNote: "این رسید فقط خواندنی است — موجودی فیزیکی هنگام ثبت نهایی جابه‌جا شده است.",
    inventoryNote: "ثبت نهایی این رسید موجودی انبار را افزایش می‌دهد و هیچ سند مالی ایجاد نمی‌کند.",
    postAction: "ثبت نهایی رسید",
    postTitle: "این رسید ثبت نهایی شود؟",
    postDesc: "مقادیر دریافت‌شده همین حالا به موجودی انبار اضافه می‌شوند.",
    postConfirm: "ثبت نهایی",
    postToast: "رسید انبار ثبت شد — موجودی به‌روزرسانی شد.",
    postWarning: "با ثبت نهایی این رسید، موجودی انبار افزایش می‌یابد. پس از آن امکان ویرایش یا لغو وجود نخواهد داشت.",
    postEmpty: "پیش از ثبت نهایی، دست‌کم یک خط اضافه کنید.",
    cancelAction: "لغو رسید",
    cancelTitle: "این رسید لغو شود؟",
    cancelDesc: "این پیش‌نویس برای همیشه لغو می‌شود. چیزی ثبت نشده، پس موجودی تغییری نمی‌کند.",
    cancelConfirm: "لغو رسید",
    cancelToast: "رسید انبار لغو شد.",
    cancelTerminalWarning: "لغو برگشت‌ناپذیر است. این پیش‌نویس هرگز موجودی را تغییر نداده، پس چیزی برای بازگرداندن وجود ندارد.",
    staleRemaining: "مقدار باقی‌مانده تغییر کرده است. پیش از ثبت نهایی، رسید را بازبینی کنید.",
    exceedsRemaining: "این مقدار از باقی‌ماندهٔ این خط بیشتر است.",
    poNotReceivable: "دریافت کالا فقط نسبت به سفارش خرید تأییدشده امکان‌پذیر است.",
    productNotFound: "یکی از کالاهای این رسید دیگر وجود ندارد.",
    stockOverflow: "این مقدار از سقف مجاز موجودی انبار عبور می‌کند.",
    immutable: "این رسید دیگر قابل تغییر نیست.",
    invalidTransition: "این تغییر وضعیت مجاز نیست.",
    notFoundTitle: "رسید انبار پیدا نشد",
    notFoundDesc: "ممکن است متعلق به کسب‌وکار دیگری باشد یا دیگر وجود نداشته باشد.",
    backToList: "بازگشت به رسیدهای انبار",
    openPurchaseOrder: "مشاهده سفارش خرید",
    postedAtLabel: "تاریخ ثبت",
    cancelledAtLabel: "تاریخ لغو",
    createdAtLabel: "تاریخ ایجاد",
    createdBy: "ایجادکننده",
    receivingSummary: "وضعیت دریافت",
    recordReceipt: "ثبت رسید انبار",
    fullyReceivedLabel: "دریافت کامل شد",
    partiallyReceivedLabel: "{received} از {ordered} دریافت شده",
    receivingBlockedClosed: "این سفارش بسته شده — دریافت کالا دیگر امکان‌پذیر نیست.",
    closeWarning: "با بستن سفارش، دریافت کالا متوقف می‌شود. مقادیر دریافت‌نشده دریافت‌نشده باقی می‌مانند و هیچ سند مالی ایجاد نمی‌شود.",
    recentReceipts: "رسیدهای اخیر",
    noRecentReceipts: "هنوز رسیدی نسبت به این سفارش ثبت نشده است.",
    productHistory: "رسیدهای اخیر",
    noProductHistory: "هنوز رسیدی برای این کالا ثبت نشده است.",
    supplierHistory: "رسیدهای اخیر",
    noSupplierHistory: "هنوز رسیدی برای این تأمین‌کننده ثبت نشده است.",
    poCancelledWithReceipts: "این سفارش خرید رسید ثبت‌شده دارد و دیگر قابل لغو نیست.",
    exportAction: "دریافت CSV",
    exportToast: "فایل CSV آماده شد.",
    exportFailed: "دریافت فایل ناموفق بود — دوباره تلاش کنید.",
    exportRateLimited: "تعداد درخواست‌ها زیاد است. کمی صبر کنید.",
    exportForbidden: "طرح شما شامل دریافت CSV نیست.",
    copyLink: "کپی پیوند",
    status_DRAFT: "پیش‌نویس",
    status_POSTED: "ثبت‌شده",
    status_CANCELLED: "لغوشده",
    csvReference: "reference",
    csvStatus: "status",
    csvPurchaseOrderReference: "purchase_order_reference",
    csvSupplier: "supplier",
    csvProduct: "product",
    csvSku: "sku",
    csvUnit: "unit",
    csvReceivedQty: "received_qty",
    csvPostedAt: "posted_at",
    detailSubtitle: "سند دریافت برای {supplier}",
  },
`;

let en = readFileSync(EN, "utf8");
let fa = readFileSync(FA, "utf8");

en = insertAfter(en, EN_NAV, EN_NAV_ADD);
fa = insertAfter(fa, FA_NAV, FA_NAV_ADD);
en = insertAfter(en, EN_GROUP, EN_GROUP_ADD);
fa = insertAfter(fa, FA_GROUP, FA_GROUP_ADD);
en = insertAfter(en, EN_STATUS, EN_STATUS_ADD);
fa = insertAfter(fa, FA_STATUS, FA_STATUS_ADD);
en = insertAfter(en, EN_DATASETS, EN_DATASETS_ADD);
fa = insertAfter(fa, FA_DATASETS, FA_DATASETS_ADD);

// Namespace after the purchaseOrders block (anchor: its final lines).
const EN_PO_END = `    total: "Total",\n    detailSubtitle: "Procurement document for {supplier}",\n  },\n`;
const FA_PO_END = `    total: "مجموع",\n    detailSubtitle: "سند خرید برای {supplier}",\n  },\n`;
if (!en.includes("goodsReceipts: {")) en = insertAfter(en, EN_PO_END, EN_NAMESPACE);
if (!fa.includes("goodsReceipts: {")) fa = insertAfter(fa, FA_PO_END, FA_NAMESPACE);

writeFileSync(EN, en);
writeFileSync(FA, fa);
console.log("i18n keys inserted OK");
