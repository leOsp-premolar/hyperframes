// @vitest-environment happy-dom

/**
 * The voice form offers the providers the server has set up, loads the voices of the one the
 * choice resolves to, sends what the user chose and shows the server's answer as it is.
 */
import React, { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  buttonWithText,
  cleanupMounted,
  mountHost,
  typeInto as type,
} from "./ui/mountHost.testHelpers";
import { VoiceForm } from "./VoiceForm";

const fetchMock = vi.fn<typeof fetch>();

const PROVIDERS = {
  auto: "openai",
  providers: [
    {
      id: "elevenlabs",
      label: "ElevenLabs",
      local: false,
      configured: false,
      setupHint: "Set ELEVENLABS_API_KEY (elevenlabs.io → Profile → API keys).",
      defaultVoice: "21m00Tcm4TlvDq8ikWAM",
      defaultModel: "eleven_multilingual_v2",
      models: ["eleven_multilingual_v2"],
      styleModels: [],
      nativeWords: true,
      maxCharacters: 10000,
    },
    {
      id: "openai",
      label: "OpenAI",
      local: false,
      configured: true,
      defaultVoice: "coral",
      defaultModel: "gpt-4o-mini-tts",
      models: ["gpt-4o-mini-tts"],
      styleModels: ["gpt-4o-mini-tts"],
      nativeWords: false,
      maxCharacters: 4096,
    },
    {
      id: "kokoro",
      label: "Kokoro (local)",
      local: true,
      configured: true,
      defaultVoice: "af_heart",
      defaultModel: "kokoro-v1.0",
      models: ["kokoro-v1.0"],
      styleModels: [],
      nativeWords: false,
      maxCharacters: 20000,
    },
  ],
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let voiceAnswer: () => Response;

beforeEach(() => {
  fetchMock.mockReset();
  voiceAnswer = () =>
    json(200, {
      path: "assets/voice/hola.wav",
      provider: "openai",
      voice: "shimmer",
      model: "gpt-4o-mini-tts",
      durationSeconds: 1.6,
      speed: 0.9,
      styleApplied: true,
    });
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === "/api/voice/providers") return json(200, PROVIDERS);
    if (url === "/api/voice/providers/openai/voices") {
      return json(200, {
        voices: [
          { id: "coral", name: "Coral", description: "warm, friendly" },
          { id: "shimmer", name: "Shimmer", description: "light, gentle" },
        ],
      });
    }
    if (url === "/api/voice/providers/kokoro/voices") {
      return json(200, { voices: [{ id: "ef_dora", name: "Dora" }] });
    }
    if (url === "/api/projects/demo/voice") return voiceAnswer();
    return json(404, { error: "not found" });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanupMounted();
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount() {
  const onDone = vi.fn();
  const host = mountHost(<VoiceForm projectId="demo" onDone={onDone} />);
  await settle();
  return { host, onDone };
}

function submitButton(host: HTMLElement) {
  return buttonWithText(host, "Generate voice");
}

async function submit(host: HTMLElement) {
  await act(async () => {
    submitButton(host).click();
  });
  await settle();
}

function voicePost() {
  const call = fetchMock.mock.calls.find(([url]) => String(url) === "/api/projects/demo/voice");
  return call ? JSON.parse(String(call[1]?.body)) : null;
}

function options(host: HTMLElement, selector: string) {
  return [...host.querySelectorAll<HTMLOptionElement>(`${selector} option`)].map((o) => ({
    value: o.value,
    text: o.textContent,
    disabled: o.disabled,
  }));
}

it("offers only the providers that are set up, and says how to set up the others", async () => {
  const { host } = await mount();
  expect(options(host, "#voice-provider")).toEqual([
    { value: "auto", text: "Best available (OpenAI)", disabled: false },
    { value: "openai", text: "OpenAI", disabled: false },
    { value: "kokoro", text: "Kokoro (local)", disabled: false },
  ]);
  expect(host.textContent).toContain("ElevenLabs: Set ELEVENLABS_API_KEY");
});

it("lists the voices of the provider the choice resolves to", async () => {
  const { host } = await mount();
  expect(options(host, "#voice-voice").map((o) => o.value)).toEqual(["", "coral", "shimmer"]);
  type(host, "#voice-provider", "kokoro");
  await settle();
  expect(options(host, "#voice-voice").map((o) => o.value)).toEqual(["", "ef_dora"]);
});

it("asks how to say it only of a provider that follows directions", async () => {
  const { host } = await mount();
  expect(host.querySelector("#voice-style")).not.toBeNull();
  type(host, "#voice-provider", "kokoro");
  await settle();
  expect(host.querySelector("#voice-style")).toBeNull();
});

it("cannot be sent without text", async () => {
  const { host } = await mount();
  expect(submitButton(host).disabled).toBe(true);
  type(host, "#voice-text", "   ");
  expect(submitButton(host).disabled).toBe(true);
});

it("sends the text, voice and delivery, then hands back the saved asset", async () => {
  const { host, onDone } = await mount();
  type(host, "#voice-text", "Hola, pequeña semilla.");
  type(host, "#voice-voice", "shimmer");
  type(host, "#voice-style", "tierna y amigable");
  type(host, "#voice-speed", "0.9");
  type(host, "#voice-language", "es");
  await submit(host);
  expect(voicePost()).toEqual({
    text: "Hola, pequeña semilla.",
    provider: "auto",
    voice: "shimmer",
    speed: 0.9,
    style: "tierna y amigable",
    language: "es",
  });
  expect(onDone).toHaveBeenCalledWith({
    ok: true,
    path: "assets/voice/hola.wav",
    provider: "openai",
    voice: "shimmer",
    durationSeconds: 1.6,
  });
});

it("leaves the voice to the provider's default when none is picked", async () => {
  const { host } = await mount();
  type(host, "#voice-text", "Hola");
  await submit(host);
  expect(voicePost()).toEqual({ text: "Hola", provider: "auto", speed: 1 });
});

it("shows the server's reason and stays open when the provider refuses", async () => {
  voiceAnswer = () =>
    json(502, { error: "OpenAI answered 401: Incorrect API key provided", code: "auth_failed" });
  const { host, onDone } = await mount();
  type(host, "#voice-text", "Hola");
  await submit(host);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Incorrect API key");
  expect(onDone).not.toHaveBeenCalled();
  expect(submitButton(host).disabled).toBe(false);
});
