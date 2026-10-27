import 'dotenv/config';
import OpenAI from 'openai';
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: 15000 });
try {
  const model = await client.models.retrieve(process.env.OPENAI_MODEL || 'gpt-5.4-mini');
  console.info(JSON.stringify({ ok: true, model: model.id }));
} catch (error) {
  console.info(
    JSON.stringify({
      ok: false,
      status: error.status ?? null,
      code: error.code ?? 'NETWORK_ERROR',
    }),
  );
  process.exitCode = 1;
}
