import { VoiceError, type ProviderContext, type VoiceProviderId } from "./types.js";

const MAX_DETAIL = 300;

/**
 * The reason a provider gave for refusing a request, from the JSON shapes ElevenLabs
 * (`detail` as text, `{message}` or a validation list) and OpenAI (`error.message`) send.
 */
export function providerErrorDetail(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body.trim().slice(0, MAX_DETAIL);
  }
  return firstMessage(parsed).trim().slice(0, MAX_DETAIL);
}

function firstMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(firstMessage).find(Boolean) ?? "";
  if (!value || typeof value !== "object") return "";
  for (const key of ["message", "msg", "detail", "error"]) {
    if (key in value) {
      const found = firstMessage((value as Record<string, unknown>)[key]);
      if (found) return found;
    }
  }
  return "";
}

function errorCode(status: number): "auth_failed" | "rate_limited" | "provider_failed" {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 429) return "rate_limited";
  return "provider_failed";
}

/**
 * fetch for a provider call: a refusal becomes a VoiceError carrying the provider's own reason
 * (never the request, which holds the key), and a stop on `ctx.signal` stays an abort for the
 * caller, who knows whether it was a cancel or a timeout.
 */
export async function providerFetch(
  provider: VoiceProviderId,
  label: string,
  url: string,
  init: RequestInit,
  ctx: ProviderContext,
): Promise<Response> {
  let response: Response;
  try {
    response = await ctx.fetch(url, { ...init, signal: ctx.signal });
  } catch (err) {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    const why = err instanceof Error ? err.message : String(err);
    throw new VoiceError("provider_failed", `${label} could not be reached: ${why}`, {
      provider,
      cause: err,
    });
  }
  if (response.ok) return response;
  const detail = providerErrorDetail(await response.text().catch(() => ""));
  throw new VoiceError(
    errorCode(response.status),
    `${label} answered ${response.status}${detail ? `: ${detail}` : ""}`,
    { provider, status: response.status },
  );
}

/** The value of a required key, or a not_configured error naming the variable to set. */
export function requireKey(
  provider: VoiceProviderId,
  label: string,
  variable: string,
  ctx: ProviderContext,
): string {
  const key = ctx.env[variable]?.trim();
  if (!key) {
    throw new VoiceError("not_configured", `${label} needs ${variable} in the environment.`, {
      provider,
    });
  }
  return key;
}

/** `https://host/path/` and `https://host/path` give the same joined URLs. */
export function baseUrl(configured: string | undefined, fallback: string): string {
  return (configured?.trim() || fallback).replace(/\/+$/, "");
}
