import { ProviderType } from "@/types";

export const PROVIDER_LABELS: Record<ProviderType, string> = {
  groq: "Groq",
  gemini: "Gemini",
  openrouter: "OpenRouter"
};

export const PROVIDER_MODELS: Record<ProviderType, string> = {
  groq: "openai/gpt-oss-120b",
  gemini: "gemini-3.6-flash",
  openrouter: "openai/gpt-oss-120b:free"
};

export function generateTitle(firstMessage: string): string {
  const cleaned = firstMessage.trim();
  if (!cleaned) return "New chat";

  const sentences = cleaned.split(/[.!?]/).filter(s => s.trim().length > 0);
  const firstSentence = sentences[0]?.trim() || cleaned;

  const words = firstSentence.split(/\s+/);
  const maxWords = 8;
  const titleWords = words.slice(0, maxWords);
  let title = titleWords.join(" ");

  if (words.length > maxWords || sentences.length > 1 || firstSentence.length > 60) {
    title += "...";
  }

  return title.charAt(0).toUpperCase() + title.slice(1) || "New chat";
}
