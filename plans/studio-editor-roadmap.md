# Studio as a standalone video editor: roadmap

Work to make Studio a complete editor (create a project, import media, edit on a timeline,
export) without the CLI. Each stage is its own branch, stacked only where a stage reuses the
previous one's tests.

## Stages

| Stage | Branch                     | State   | Scope                                                                    |
| ----- | -------------------------- | ------- | ------------------------------------------------------------------------ |
| S0    | `studio/s0-e2e-workflow`   | Done    | Browser gate: import, place, split, trim, undo/redo, reload, export      |
| S4    | `studio/s4-create-project` | Done    | New project from the header or the empty start screen; `POST /projects`  |
| S2    | `studio/s2-media-metadata` | Done    | Media metadata on asset cards; upload validation                         |
| S3    | `studio/s3-missing-media`  | Review  | Missing media detection and replacement                                  |
| S1    |                            | Planned | Export the in/out range; audio-only export; GIF and PNG sequence options |
| S5    |                            | Planned | Slip and roll editing                                                    |
| S6    |                            | Planned | Track lock and solo                                                      |
| S7    |                            | Planned | Browser verification of keyframes and playback                           |

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
