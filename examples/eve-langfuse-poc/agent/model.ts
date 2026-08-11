import { createAzure } from "@ai-sdk/azure";
import type { LanguageModel } from "ai";

/**
 * Azure OpenAI, configured from the environment.
 *
 * The endpoint already ends in `/openai/v1`, which is Azure's OpenAI-compatible
 * v1 surface, so it is passed straight through as `baseURL` rather than being
 * rebuilt from a resource name. `@ai-sdk/azure` defaults `apiVersion` to "v1",
 * which matches.
 *
 * Throws when any variable is missing so `resolveModel` can fall back.
 */
function getAzureChatModel(): LanguageModel {
  const apiKey = process.env.AZURE_AI_CHATBOT_API_KEY;
  const baseURL = process.env.AZURE_AI_CHATBOT_OPENAI_ENDPOINT;
  const deployment = process.env.AZURE_AI_CHATBOT_DEPLOYMENT_NAME;

  if (!apiKey || !baseURL || !deployment) {
    throw new Error("Azure OpenAI environment variables are not fully set");
  }

  // `@ai-sdk/azure` appends `/v1` itself for any *.openai.azure.com host, so a
  // baseURL that already ends in /v1 produces `/openai/v1/v1/chat/completions`
  // and a 404 that reads as "wrong deployment name". Verified against
  // @ai-sdk/azure 4.0.37 (dist/index.js, the `${baseUrlPrefix}/v1${path}`
  // branch). Accept the endpoint in either form and normalise it.
  const azure = createAzure({
    apiKey,
    baseURL: baseURL.replace(/\/+$/, "").replace(/\/v1$/, ""),
  });

  // For Azure the model id is the DEPLOYMENT name, not the upstream model name.
  return azure(deployment);
}

/**
 * Azure when it is configured, otherwise a Vercel AI Gateway model id.
 *
 * The fallback keeps the agent runnable for anyone who has a Gateway key but no
 * Azure resource — useful because this PoC exists to be run by other people,
 * and a hard Azure dependency would block them at the first turn.
 */
export function resolveModel(): LanguageModel {
  try {
    return getAzureChatModel();
  } catch {
    return "openai/gpt-4.1";
  }
}
