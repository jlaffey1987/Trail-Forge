import Anthropic from "@anthropic-ai/sdk";

const baseURL = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
const apiKey = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
const missingEnvMessage =
  "Anthropic AI integration env is missing. Set AI_INTEGRATIONS_ANTHROPIC_BASE_URL and AI_INTEGRATIONS_ANTHROPIC_API_KEY.";

export const anthropic: Anthropic =
  baseURL && apiKey
    ? new Anthropic({ apiKey, baseURL })
    : new Proxy({} as Anthropic, {
        get() {
          throw new Error(missingEnvMessage);
        },
      });
