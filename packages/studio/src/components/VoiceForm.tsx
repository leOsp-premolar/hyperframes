import { useEffect, useState, type FormEvent } from "react";
import { Button, FormField as Field, cn, fieldBase, fieldText } from "./ui";
import {
  fetchVoiceProviders,
  fetchVoices,
  requestVoice,
  type Loaded,
  type VoiceOutcome,
} from "../utils/voiceApi";

const AUTO = "auto";

export type VoiceDone = Extract<VoiceOutcome, { ok: true }>;

interface VoiceFormProps {
  projectId: string;
  /** The speech is in the project; refresh its assets and close. */
  onDone: (outcome: VoiceDone) => void;
  onCancel?: () => void;
}

/** What `load` answers, loaded again when `key` changes; an answer for an older key is dropped. */
function useLoaded<T>(load: (() => Promise<Loaded<T>>) | null, key: string) {
  const [state, setState] = useState<{ value: T | null; error: string | null }>({
    value: null,
    error: null,
  });
  useEffect(() => {
    setState({ value: null, error: null });
    if (!load) return;
    let live = true;
    void load().then((loaded) => {
      if (live)
        setState(
          loaded.ok ? { value: loaded.value, error: null } : { value: null, error: loaded.error },
        );
    });
    return () => {
      live = false;
    };
    // `key` names what `load` fetches; a new closure for the same key is the same request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

/** The provider list once, then the voices of whichever provider the choice resolves to. */
function useVoiceChoices(provider: string) {
  const { value: providers, error: providersError } = useLoaded(fetchVoiceProviders, "providers");
  const resolvedId = provider === AUTO ? providers?.auto : provider;
  const resolved = providers?.providers.find((p) => p.id === resolvedId);
  const ready = resolved?.configured === true;
  const voicesFor = ready && resolvedId ? resolvedId : "";
  const { value: voices, error: voicesError } = useLoaded(
    voicesFor ? () => fetchVoices(voicesFor) : null,
    voicesFor,
  );
  return { providers, providersError, resolved, voices: voices ?? [], voicesError };
}

/**
 * Text, voice and delivery for one spoken line. The server owns the rules (lengths, speeds,
 * keys) and its message is shown as it is.
 */
// fallow-ignore-next-line complexity
export function VoiceForm({ projectId, onDone, onCancel }: VoiceFormProps) {
  const [text, setText] = useState("");
  const [provider, setProvider] = useState(AUTO);
  const [voice, setVoice] = useState("");
  const [style, setStyle] = useState("");
  const [speed, setSpeed] = useState("1");
  const [language, setLanguage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { providers, providersError, resolved, voices, voicesError } = useVoiceChoices(provider);

  useEffect(() => setVoice(""), [resolved?.id]);

  const takesStyle = (resolved?.styleModels.length ?? 0) > 0;
  const missing = providers?.providers.filter((p) => !p.configured) ?? [];
  const limit = resolved?.maxCharacters ?? 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    const outcome = await requestVoice(projectId, {
      text,
      provider,
      speed: Number(speed),
      ...(voice ? { voice } : {}),
      ...(takesStyle && style.trim() ? { style: style.trim() } : {}),
      ...(language.trim() ? { language: language.trim() } : {}),
    });
    setSubmitting(false);
    if (outcome.ok) onDone(outcome);
    else setError(outcome.error);
  };

  return (
    <form className="flex flex-col gap-3" onSubmit={submit} noValidate aria-label="Generate voice">
      <Field label="Text to speak" htmlFor="voice-text">
        <div className={cn(fieldBase, "h-auto py-1.5")} aria-invalid={error ? true : undefined}>
          <textarea
            id="voice-text"
            className={cn(fieldText, "min-h-24 resize-y")}
            value={text}
            rows={4}
            placeholder="With the first light of morning, a tiny seed woke up."
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        {limit > 0 && (
          <span
            className={cn(
              "self-end text-step-10",
              text.length > limit ? "text-danger-ink" : "text-text-4",
            )}
          >
            {text.length} / {limit}
          </span>
        )}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Provider" htmlFor="voice-provider">
          <div className={fieldBase}>
            <select
              id="voice-provider"
              className={cn(fieldText, "cursor-pointer bg-transparent")}
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              <option value={AUTO}>
                Best available
                {providers && resolved && provider === AUTO ? ` (${resolved.label})` : ""}
              </option>
              {/* Only the ready ones: a disabled option would grey the whole field, and the
                  hints below say how to set up the rest. */}
              {providers?.providers
                .filter((p) => p.configured)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
            </select>
          </div>
        </Field>
        <Field label="Voice" htmlFor="voice-voice">
          <div className={fieldBase}>
            <select
              id="voice-voice"
              className={cn(fieldText, "cursor-pointer bg-transparent")}
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
            >
              <option value="">Default voice</option>
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.description ? `${v.name} · ${v.description}` : v.name}
                </option>
              ))}
            </select>
          </div>
        </Field>
      </div>
      {takesStyle && (
        <Field label="How to say it" htmlFor="voice-style">
          <div className={fieldBase}>
            <input
              id="voice-style"
              className={fieldText}
              value={style}
              maxLength={1000}
              placeholder="Warm, tender and friendly; unhurried, with a smile"
              onChange={(e) => setStyle(e.target.value)}
            />
          </div>
        </Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Speed" htmlFor="voice-speed">
          <div className={fieldBase}>
            <input
              id="voice-speed"
              type="number"
              inputMode="decimal"
              className={fieldText}
              value={speed}
              min={0.5}
              max={2}
              step={0.05}
              onChange={(e) => setSpeed(e.target.value)}
            />
          </div>
        </Field>
        <Field label="Language (optional)" htmlFor="voice-language">
          <div className={fieldBase}>
            <input
              id="voice-language"
              className={fieldText}
              value={language}
              maxLength={12}
              placeholder="es, en, fr…"
              autoComplete="off"
              onChange={(e) => setLanguage(e.target.value)}
            />
          </div>
        </Field>
      </div>
      {missing.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-step-10 text-text-4">
          {missing.map((p) => (
            <li key={p.id}>
              {p.label}: {p.setupHint ?? "not set up"}
            </li>
          ))}
        </ul>
      )}
      {(providersError || voicesError || error) && (
        <div role="alert" className="text-step-10 text-danger-ink">
          {error ?? providersError ?? voicesError}
        </div>
      )}
      <div className="flex items-center justify-end gap-2 pt-1">
        {submitting && (
          <span className="mr-auto text-step-10 text-text-4">This can take a few seconds…</span>
        )}
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          type="submit"
          variant="primary"
          loading={submitting}
          disabled={!text.trim() || submitting}
        >
          Generate voice
        </Button>
      </div>
    </form>
  );
}
