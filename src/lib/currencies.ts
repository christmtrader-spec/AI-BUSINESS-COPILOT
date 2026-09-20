/**
 * Currency catalog — Constitution A04.
 * MVP: one primary currency per business. The catalog keeps code,
 * symbol and default decimal precision so the DB never hard-codes one.
 */

export type Currency = {
  code: string;
  symbol: string;
  name: string;
  precision: number;
};

export const CURRENCIES: readonly Currency[] = [
  { code: "USD", symbol: "$", name: "US Dollar", precision: 2 },
  { code: "EUR", symbol: "€", name: "Euro", precision: 2 },
  { code: "GBP", symbol: "£", name: "British Pound", precision: 2 },
  { code: "IRR", symbol: "﷼", name: "Iranian Rial", precision: 0 },
  { code: "AED", symbol: "د.إ", name: "UAE Dirham", precision: 2 },
  { code: "SAR", symbol: "﷼", name: "Saudi Riyal", precision: 2 },
  { code: "TRY", symbol: "₺", name: "Turkish Lira", precision: 2 },
  { code: "AFN", symbol: "؋", name: "Afghan Afghani", precision: 2 },
  { code: "PKR", symbol: "₨", name: "Pakistani Rupee", precision: 2 },
  { code: "INR", symbol: "₹", name: "Indian Rupee", precision: 2 },
  { code: "CNY", symbol: "¥", name: "Chinese Yuan", precision: 2 },
  { code: "JPY", symbol: "¥", name: "Japanese Yen", precision: 0 },
  { code: "KRW", symbol: "₩", name: "South Korean Won", precision: 0 },
  { code: "CAD", symbol: "$", name: "Canadian Dollar", precision: 2 },
  { code: "AUD", symbol: "$", name: "Australian Dollar", precision: 2 },
  { code: "NZD", symbol: "$", name: "New Zealand Dollar", precision: 2 },
  { code: "CHF", symbol: "Fr", name: "Swiss Franc", precision: 2 },
  { code: "SEK", symbol: "kr", name: "Swedish Krona", precision: 2 },
  { code: "NOK", symbol: "kr", name: "Norwegian Krone", precision: 2 },
  { code: "DKK", symbol: "kr", name: "Danish Krone", precision: 2 },
  { code: "PLN", symbol: "zł", name: "Polish Zloty", precision: 2 },
  { code: "CZK", symbol: "Kč", name: "Czech Koruna", precision: 2 },
  { code: "HUF", symbol: "Ft", name: "Hungarian Forint", precision: 2 },
  { code: "RON", symbol: "lei", name: "Romanian Leu", precision: 2 },
  { code: "RUB", symbol: "₽", name: "Russian Ruble", precision: 2 },
  { code: "UAH", symbol: "₴", name: "Ukrainian Hryvnia", precision: 2 },
  { code: "BRL", symbol: "R$", name: "Brazilian Real", precision: 2 },
  { code: "MXN", symbol: "$", name: "Mexican Peso", precision: 2 },
  { code: "ARS", symbol: "$", name: "Argentine Peso", precision: 2 },
  { code: "CLP", symbol: "$", name: "Chilean Peso", precision: 0 },
  { code: "COP", symbol: "$", name: "Colombian Peso", precision: 2 },
  { code: "ZAR", symbol: "R", name: "South African Rand", precision: 2 },
  { code: "NGN", symbol: "₦", name: "Nigerian Naira", precision: 2 },
  { code: "KES", symbol: "KSh", name: "Kenyan Shilling", precision: 2 },
  { code: "GHS", symbol: "₵", name: "Ghanaian Cedi", precision: 2 },
  { code: "EGP", symbol: "E£", name: "Egyptian Pound", precision: 2 },
  { code: "MAD", symbol: "DH", name: "Moroccan Dirham", precision: 2 },
  { code: "IDR", symbol: "Rp", name: "Indonesian Rupiah", precision: 0 },
  { code: "MYR", symbol: "RM", name: "Malaysian Ringgit", precision: 2 },
  { code: "THB", symbol: "฿", name: "Thai Baht", precision: 2 },
  { code: "VND", symbol: "₫", name: "Vietnamese Dong", precision: 0 },
  { code: "PHP", symbol: "₱", name: "Philippine Peso", precision: 2 },
  { code: "SGD", symbol: "$", name: "Singapore Dollar", precision: 2 },
  { code: "HKD", symbol: "$", name: "Hong Kong Dollar", precision: 2 },
  { code: "TWD", symbol: "NT$", name: "New Taiwan Dollar", precision: 2 },
  { code: "ILS", symbol: "₪", name: "Israeli New Shekel", precision: 2 },
  { code: "JOD", symbol: "د.ا", name: "Jordanian Dinar", precision: 3 },
  { code: "KWD", symbol: "د.ك", name: "Kuwaiti Dinar", precision: 3 },
  { code: "BHD", symbol: ".د.ب", name: "Bahraini Dinar", precision: 3 },
  { code: "OMR", symbol: "﷼", name: "Omani Rial", precision: 3 },
  { code: "QAR", symbol: "ر.ق", name: "Qatari Riyal", precision: 2 },
  { code: "IQD", symbol: "ع.د", name: "Iraqi Dinar", precision: 0 },
  { code: "AZN", symbol: "₼", name: "Azerbaijani Manat", precision: 2 },
  { code: "KZT", symbol: "₸", name: "Kazakhstani Tenge", precision: 2 },
  { code: "UZS", symbol: "so'm", name: "Uzbekistani Som", precision: 0 },
  { code: "GEL", symbol: "₾", name: "Georgian Lari", precision: 2 },
];

export function findCurrency(code: string): Currency | undefined {
  return CURRENCIES.find((c) => c.code === code.toUpperCase());
}

export function currencyOf(code: string): Currency {
  return findCurrency(code) ?? { code: code.toUpperCase(), symbol: code.toUpperCase(), name: code.toUpperCase(), precision: 2 };
}
