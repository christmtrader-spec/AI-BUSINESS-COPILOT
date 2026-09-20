import en, { type Messages } from "./en";
import fa from "./fa";

export const MESSAGES: Record<string, Messages> = { en, fa };

export function messagesFor(locale: string): Messages {
  return MESSAGES[locale] ?? en;
}

export type { Messages };
