# Studio as a standalone video editor: roadmap

Work to make Studio a complete editor (create a project, import media, edit on a timeline,
export) without the CLI. Each stage is its own branch, stacked only where a stage reuses the
previous one's tests.

## Stages

| Stage | Branch                     | State   | Scope                                                                    |
| ----- | -------------------------- | ------- | ------------------------------------------------------------------------ |
| S0    | `studio/s0-e2e-workflow`   | Done    | Browser gate: import, place, split, trim, undo/redo, reload, export      |
| S4    | `studio/s4-create-project` | Done    | New project from the header or the empty start screen; `POST /projects`  |
| S2    | `studio/s2-media-metadata` | Active  | Media metadata on asset cards; upload validation                         |
| S3    |                            | Planned | Missing media detection and replacement                                  |
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
