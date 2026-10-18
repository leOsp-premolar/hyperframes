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
| S3    | `studio/s3-missing-media`  | Active  | Missing media detection and replacement                                  |
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
