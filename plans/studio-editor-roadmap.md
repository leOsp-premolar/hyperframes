# Studio as a standalone video editor: roadmap

Work to make Studio a complete editor (create a project, import media, edit on a timeline,
export) without the CLI. Each stage is its own branch, stacked only where a stage reuses the
previous one's tests.

## Stages

| Stage | Branch                         | State  | Scope                                                                    |
| ----- | ------------------------------ | ------ | ------------------------------------------------------------------------ |
| S0    | `studio/s0-e2e-workflow`       | Done   | Browser gate: import, place, split, trim, undo/redo, reload, export      |
| S4    | `studio/s4-create-project`     | Done   | New project from the header or the empty start screen; `POST /projects`  |
| S2    | `studio/s2-media-metadata`     | Done   | Media metadata on asset cards; upload validation                         |
| S3    | `studio/s3-missing-media`      | Done   | Missing media detection and replacement                                  |
| S1    | `studio/s1-export-options`     | Done   | Export the in/out range; audio-only export; GIF and PNG sequence options |
| S5    | `studio/s5-slip-roll`          | Done   | Slip and roll editing                                                    |
| S6    | `studio/s6-track-lock-solo`    | Done   | Track lock and solo                                                      |
| S7    | `studio/s7-keyframes-playback` | Done   | Browser verification of keyframes and playback                           |
| S8    | `studio/s8-voice-api`          | Review | Voice API: ElevenLabs and OpenAI voices in the CLI, the API and Studio   |

## Known limitations to plan for

Recorded when S4 was approved.

- **First-project start screen is only manually browser-tested.** The form it shows has unit
  tests, but the gate cannot reach that screen without emptying `data/projects`, which on a
  developer machine holds their own projects. A gate needs a dev server started on a temporary
  projects folder.
- **Project display names are folder names.** A project named "Mi Vídeo" shows as `mi-video`.
  Keeping the typed name needs somewhere to store it (for example `hyperframes.json`) and the
  project list to read it.
- **No project browser.** Studio can create projects but not list them to switch; switching
  is by URL, or "Open it" when a name is taken.
- **The development Studio shares one render list across projects.** The Vite adapter's
  `rendersDir` is `data/renders` for every project, so each project's Renders panel lists the
  others' renders. The CLI's single-project server already keeps renders per project.

Recorded when S2 was approved.

- **Video and audio validation does not decode the whole file.** An upload must have the stream
  its extension promises (a video stream for `.mp4`), and a damaged image is caught because
  FFmpeg reports it without a size, but a file that is readable and corrupt in the middle (a
  glitch halfway through a clip) is accepted. Catching it needs a full decode on upload.
- **AVIF validation depends on the FFmpeg decoder.** Where FFmpeg cannot decode AVIF, an AVIF
  upload is accepted as unchecked rather than refused.
- **Media facts are fetched again in each new session.** The client probes each file once per
  session; the server keeps no probe cache, so a new session probes every file again.
- **The development Studio still shares its render list across projects** (see above).

Recorded with S3, for review.

How a replacement keeps a clip: Studio scans every HTML file in the project for `<video>`,
`<img>`, `<audio>` and `<source>` elements whose local `src` is missing, unreadable or a folder.
"Replace…" (banner, the clip's Missing badge, or "Replace media…" in the clip menu) uploads a
file of the same kind (video, image or audio) after the S2 validation. A file with the missing
file's extension is written under the missing name, so no composition changes. Otherwise it is
saved beside it as `<name>.<new extension>` (numbered if taken) and only the file name in the
references changes. Clip ids, timing, trims, track, transforms, volume and every other attribute
stay as they were. Nothing is ever overwritten; every composition change is written as one
(backed up first, rolled back on failure) and the new file is removed again if anything fails.

Cases where a replacement cannot keep everything:

- **A silent video for a clip that has sound.** Export extracts the sound of a video marked
  `data-has-audio="true"` and fails when the file has none, so the replacement sets those clips
  to `data-has-audio="false"` (what Studio writes for a silent drop) and says so.
- **A shorter file than the clip uses.** The clip keeps its length and source offset; Studio
  warns, and the end of the clip has no new picture or sound. Export still completes.
- **A different size or aspect ratio.** The clip's box and transforms are kept, so the picture is
  framed by the element's own CSS. Studio cannot warn: the old file's size is unknown.
- **Another extension, or an unreadable file or folder at the path.** The new file takes a new
  name and the references are rewritten. A reference the rewrite cannot recognise (a path built
  in a script, for example) is caught afterwards and the whole replacement is undone; the user
  can then supply a file with the original type and name.
- **Another kind of media.** An image cannot replace a video, nor audio an image; the element
  type decides what the renderer expects.

Other limits:

- **Only media elements in HTML are scanned.** CSS `url()` backgrounds, fonts, script-built
  sources and remote URLs are not reported.
- **Replacement always adds a copy.** There is no "relink to a file already in the project or
  elsewhere on disk"; the browser cannot hand Studio a file path.
- **Replacement is not on the undo stack.** Like a rename it is a file operation; undoing an
  earlier edit can bring back the old file name, which the banner then reports again.
- **Export still fails while a video is missing** (the renderer's `VIDEO_SOURCE_UNRENDERABLE`);
  Studio does not block the Export button or explain it there.
- **Detection refreshes after Studio's own file actions and when the window regains focus,** not
  the instant a file is deleted elsewhere.
- **A damaged file that is present can still log an error.** Timeline filmstrips and probes now
  check that a video answers before Mediabunny opens it, because its `Input.dispose()` leaves an
  unhandled rejection behind on a failed open; a file that answers but cannot be decoded still
  does. The check costs one one-byte request per video the first time it is drawn.

Recorded with S1, for review.

How an export option is made: the Renders panel offers MP4, MOV, WebM, GIF, PNG sequence (a
zip) and audio as WAV, MP3 or M4A, over the whole timeline or the in/out range marked with I and
O. The producer renders up to the out point (its new `endSeconds` option); when the range starts
later, or the export is audio or frames, the server finishes the file before the job reports
complete: it cuts the head, keeps only the sound, or zips the frames. A range's first frame is
the frame the timeline shows at the in point (checked byte for byte against a whole-timeline PNG
export). The header's Export now uses the settings last chosen in the panel, over the whole
timeline.

Limits:

- **A range still renders from the start of the composition.** The producer stops at the out
  point but renders the frames before the in point, which are then cut. Rendering only the range
  needs a start offset in every capture path of the producer.
- **Cutting the head re-encodes the video.** Near-lossless settings keep the codec, pixel format
  and alpha (H.264 CRF 12, HEVC CRF 14, VP9 CRF 18, ProRes at its own profile), but it is a second
  encode. A range starting at 0 and a whole-timeline export are not re-encoded.
- **Audio exports render the picture too,** at draft quality, because the mix is made inside the
  render; an audio-only path in the producer would skip the capture.
- **GIF** has no sound and is capped at 30 fps (the producer's limit; the panel offers 24 or 30).
- **PNG sequences are zipped without ZIP64**: at most 65,535 frames (about 36 minutes at 30 fps)
  and 4 GiB.
- **Only the I/O points set a range,** not a Shift-drag range selection on the ruler.
- **The header's Export always exports the whole timeline,** with the panel's format.
- **The CLI's `hyperframes preview` server** got the same adapter changes but only the development
  Studio was tested in the browser.
- **A producer test fails in this container with or without S1**:
  `audioPadTrim.integration.test.ts` measures 4.3 dB against a 3 dB true-peak ceiling. The S0 and
  S3 browser tests' ffprobe calls now end their options with `--`, as the repository's ffprobe
  contract test requires; they did not before.
- **Fixed in passing for S3:** the check that keeps Mediabunny away from missing videos now also
  refuses an HTML page answering for one (the development server's fallback for a path it does
  not have). That case let the S3 browser test fail now and then with the same unhandled error.

Recorded with S5, for review.

How slip and roll work: two new timeline tools, in the tool menu and on Y (slip) and U (roll),
each key again or Escape returning to Select. Slip: drag a video, audio or composition clip and
its source slides under it; start and length stay, only the in-point (`data-media-start`)
changes, within the source when its length is known. Linked partners slip together. Roll: drag
the edge where two clips on one track touch; the left clip ends and the right one starts at the
new cut, the right clip's in-point following, so the pair's length and everything after it stay.
Both reuse the trim gesture's preview, commit and rollback, and save as one undo entry named
"Slip clip" or "Roll edit". The roll saves the right clip's in-point as the file's own value
moved by the shift, not a value held in the timeline.

Fixed in passing (upstream): a re-read timeline whose only change was a clip's in-point was
thrown away, so after undoing an in-point change the timeline kept the old value and the next
edit could write it back. The in-point now counts as a change.

Limits:

- **No two-up monitor while slipping.** The preview cannot show the new in-point until it is
  saved, so it holds still during a slip (a roll shows the frame at the cut).
- **A slip started within a moment of an undo** can start from the in-point before the undo,
  until the timeline has re-read the file (a fraction of a second); a roll does not depend on it.
- **Roll leaves linked clips alone,** since rolling one half of a linked video and audio pair
  would pull it out of sync; unlink first, or trim both.
- **Roll needs touching clips on one track**; an edge with a gap or on another track does not
  roll. Each clip keeps at least 0.1s.
- **No snapping while slipping or rolling.**
- **A source of unknown length bounds a slip at its start only.** Until the media probe reports
  how long a source is, a slip can slide past its end, leaving the tail of the clip without
  picture or sound.
- **Images, text and shapes do not slip;** they have no source to slide.

Recorded with S6, for review.

How lock and solo work: each track header has a padlock and, on tracks with sound, an S button.
The padlock saves `data-timeline-locked` on every clip of the track as one undo entry ("Lock
track N"); a track shows as locked when all its clips carry it. A locked track refuses every
timeline edit of its clips with one message ("This track is locked. Unlock it to edit its
clips."): move, trim, slip, roll, split, delete, freeze frame, link, effects and drops onto the
track, and a clip dragged onto it from another track goes back to its own. Hiding and muting
the track stay allowed. Solo is for listening: while any track is soloed, every clip with sound
on other tracks is silent in the preview through a mark (`data-hf-solo-silenced`) that only the
preview runtime reads; it never reaches the file or the export, and it ends when the project
changes.

The timeline now counts the lock as a change when it re-reads the file, so undoing a lock
updates the padlock; before, a change to the lock alone was ignored.

Limits:

- **Solo is not saved,** on purpose: it ends with the session or the project, and the export
  always has every track. A saved solo would need its own attribute and an export rule.
- **Solo silences sound, not picture.** Tracks without sound show no S button.
- **The preview applies solo while playing.** A paused preview has nothing to hear, so the
  silence is set on the next played frame, not the moment the button is pressed.
- **The lock lives on the clips, not on the track.** A clip that reaches a locked track other
  than by a timeline move or drop (the code view, an agent, a paste) arrives unlocked, and the
  track then shows as unlocked until it is locked again.
- **Only the timeline is covered.** Edits from the canvas, the inspector and the code view were
  not tested against the lock.

Recorded with S7, for review.

What the browser test covers (`test:keyframes-playback`, one red box): "Add keyframe at playhead"
keys its position at 0s; at 2s, with auto-key on (the default), a canvas drag keys it 200px to
the right. The file then holds one `keyframes` tween (0% and 100% over 2s) and the timeline two
diamonds, at 0s and 2s. Seeking shows the box between the keys at 1s and held at the last one
after it. Playing runs at real time (measured 1.00x) and at 2x (2.00x), the box never moving
backwards; Pause holds the time and the picture still; loop playback starts again at 0; the
arrow key steps one frame (1/30s) and moves the box. Undo removes the second key, redo restores
it, a reload reads both back, and the export draws the box at the same pixel as the preview at
0s, 1s and 3s.

Found and fixed:

- **The playhead sat between frames after a ruler click or a pause.** The preview shows the
  frame a seek lands on (the runtime rounds it down to its frame grid), but Studio kept the time
  under the pointer (1.514s with 1.5s on screen), and after a pause the time playback stopped at
  (1.568s). A keyframe or a split made there landed between frames, and the toolbar did not
  recognise a key added at the playhead as being at the playhead. Studio now keeps the frame the
  preview shows, and a pause settles on that frame.
- **A video that could not be opened left an unhandled error behind.** Mediabunny's
  `Input.dispose()` chains onto the failed open without a catch; Studio now disposes an input
  only once it has opened (Mediabunny frees an unopened one when it is collected). The S3 browser
  test failed now and then on this after a replacement.

Limits:

- **Only position keyframes are driven through the UI,** by a canvas drag. Opacity in the
  inspector writes CSS, not keyframes, and the test did not reach the inspector's X and Y fields
  for this element; other properties, eases and the keyframe menu are not exercised.
- **Playback rate is measured over about a second,** with 20% tolerance, in a headless browser;
  dropped frames under load are not measured.
- **Frame stepping and frame snapping use 30 fps,** the fixture's rate; a 24 or 60 fps
  composition is not covered.
- **Why one of two simultaneous reads of the replaced video in the S3 test failed** is not known;
  the failure is now handled and the other read draws the filmstrip.
- **The fixture loads GSAP from its own folder,** since the container's browser cannot reach
  the CDN the other fixtures use.

### S8: voice API

Recorded with S8, for review.

Kokoro's local voices sound synthetic. S8 adds one voice engine with three ways in:

- `synthesizeSpeech`, `describeVoiceProviders` and `listVoices` from `@hyperframes/cli/api`;
- `hyperframes tts --provider elevenlabs|openai|auto`, with `--model`, `--style` and
  `--words`. Plain `tts` still runs Kokoro exactly as before;
- Studio's **Assets → Generate voice**, on `GET /api/voice/providers`,
  `GET /api/voice/providers/:id/voices` and `POST /api/projects/:id/voice`.

Providers:

- **ElevenLabs** uses `eleven_multilingual_v2` by default, with timed speech
  (`/with-timestamps`), so word timings come from the provider itself.
- **OpenAI** uses `gpt-4o-mini-tts`, which follows a plain-words `style` ("tender, unhurried").
- **Kokoro** is the local fallback. With a signal it now runs off the event loop, so Studio keeps
  answering while it speaks.

How speech is written:

- Keys are read from `ELEVENLABS_API_KEY` and `OPENAI_API_KEY` in the environment Studio or the CLI
  starts in. They are never returned or logged.
- Speech is written as 44.1 kHz mono `.wav` or `.mp3`, renamed into place whole.
- A speed the provider cannot do natively is applied with ffmpeg's `atempo`, and word timings
  are scaled to match.
- Studio never replaces a file: the same words again become `-2`, `-3`.

What the browser test covers (`test:voice-api`, against an ElevenLabs stand-in the
test serves itself):

- Studio lists the providers and the stand-in's voices.
- A line in a chosen voice at 0.9× is sent with that speed and comes back as 44.1 kHz mono WAV of
  the spoken length.
- The same words at 0.6× become a second file stretched to 1/0.6 of that length, with no native
  speed sent.
- A 429 is shown as ElevenLabs worded it, and nothing is written.
- The first take drags onto the timeline as an `<audio>` clip.
- No page errors.

Limits:

- **No real provider was called.** This container cannot reach api.elevenlabs.io or
  api.openai.com, and there is no key here. Request and response shapes follow the providers'
  published APIs and are covered by stand-ins and unit tests, so the first run with a real key
  should still be checked by ear.
- **OpenAI and Kokoro have no word timings of their own;** `words` transcribes the result
  locally, which needs the whisper or Parakeet runtime.
- **Studio waits for the whole line** (up to 120 s) with no progress or cancel button. Closing the
  dialog does not stop a request in flight.
- **HeyGen and Gemini voices** remain in the media-use skill scripts and are not part of this
  engine yet. The unmerged `feat/openai-whisper-tts` branch adds OpenAI to those scripts
  separately.
- **Long scripts are not split:** a line over a provider's limit (ElevenLabs 10,000 characters,
  OpenAI 4,096) is refused with the limit named.
