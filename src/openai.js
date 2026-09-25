import "dotenv/config";
import OpenAI from "openai";

export const EMBEDDING_MODEL = "text-embedding-3-small";

if (!process.env.OPENAI_API_KEY) {
  console.error(
    "ВНИМАНИЕ: OPENAI_API_KEY не задан в .env. Умный поиск и пересчёт эмбеддингов будут падать с ошибкой."
  );
}

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function getEmbedding(text) {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  return response.data[0].embedding;
}
