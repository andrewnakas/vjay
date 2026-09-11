# VJay — handoff

Written 2026-09-05 for a fresh session picking this up cold. `README.md` covers
how to *use* the app; this covers what a developer needs to know to *extend* it,
and what is still missing for the show on **2026-09-06**.

## Shipping

Two GitHub Actions workflows, both in `.github/workflows/`:

- **`pages.yml`** publishes the app to <https://andrewnakas.github.io/vjay/> on
  every push to `main`. The app is static by design, so it uploads the repo as
  it stands, minus `desktop/`, `build/`, `.github/` and `package.json`. Pages is
  HTTPS, which is a secure context, so camera, screen share and WebMIDI all work
  there exactly as they do on localhost.
- **`release.yml`** builds the desktop app for macOS, Windows and Linux when a
  `v*` tag is pushed, and attaches the installers to the matching release. It
  creates the release as a **draft** first and only publishes it once all three
  platforms have uploaded, so nobody downloads a half-populated release.

**`desktop/main.js`** is the Electron shell. It serves the app to itself over
`127.0.0.1` on an OS-assigned port rather than `file://` — ES modules are
blocked by CORS on `file://`, and `getUserMedia` / `getDisplayMedia` / WebMIDI
all need a secure context, which localhost is and `file://` is not. That also
means the packaged app runs the same way `./serve.sh` does, which is worth more
than saving a port. It grants media and MIDI permission for its own origin,
routes `window.open('…','vjay-output')` to a real BrowserWindow, and answers
`setDisplayMediaRequestHandler` with a whole screen — preferring the display the
app is *not* on. Never a window: a window that goes behind another one stops
being repainted and its capture freezes, which is the failure the Inputs panel
exists to explain.

Nothing is code-signed; there are no certificates behind this. macOS calls that
"damaged" (`xattr -cr`) and Windows shows SmartScreen. The README says so.

Two packaging traps, both hit on the first release:

- **electron-builder will not build a `.deb` without a maintainer email.** The
  Linux job failed while macOS and Windows sailed through. It is set in
  `build.linux.maintainer`, deliberately as a GitHub noreply address rather than
  a personal one in a public file.
- **Both Windows targets are `.exe`**, so a single `artifactName` template made
  the installer and the portable build collide on one filename in `dist/` and
  one silently overwrote the other. `nsis` and `portable` now carry their own
  names. Any two targets sharing an extension need this.

To check a packaged Linux build on a machine without FUSE — which Ubuntu 22.04+
is, since it dropped `libfuse2` — use `--appimage-extract` and run
`squashfs-root/vjay --no-sandbox`. Not `squashfs-root/AppRun`, which needs
`$APPDIR` set, and `--no-sandbox` because extracting as a normal user strips the
setuid bit from `chrome-sandbox`. A renderer child process appearing is the
evidence a window was actually created; the app also answers on its own loopback
port, which is the quickest proof the packaged asar is intact.

**Not in the repo, by the user's decision:** `media/photos/` and
`shows/*.json` — the album and the setlist from the original show are personal.
`.gitignore` keeps them out and the app treats both as optional.

## The job

A live set, next day. The projection target is a **corner of a room** — two
yellow walls meeting at ~90°, with **paintings hanging on them**. The user
wants:

1. Audio-reactive visuals mapped onto the two wall planes.
2. Calmer "chill" comps running **inside the picture frames** as separate,
   smaller mapped regions.
3. **4–5 views per song, ~30 songs** — 120–150 states recalled live in order.

Both blockers — **surface mapping** and a **setlist/cue system** — were built
on 2026-09-05 and are described below, along with a show-day checklist.

## Architecture as it stands

Zero build. Plain ES modules, WebGL2, Web Audio. `./serve.sh` → port 8080.
~7,300 lines across `js/`.

```
                 ┌─ layer: source → transform+colour+matte → layer FX chain ─┐
audio features ─▶│  layer: ...                                               ├─▶ composite
   (feature bus) └─ layer: ...                                               ┘       │
                                                                                     ▼
                                                            master FX chain ──▶ output pass ──▶ canvas
                                                                                     ▲
                                                              [ MAPPING GOES HERE ]  ┘
```

**Two buses carry everything:**

- **Feature bus** (`js/audio/features.js` → `main.js:frame`) — a flat object of
  normalized 0..1 signals published every frame: five bands, `level`, `flux`,
  `centroid`, `kick`/`snare`/`hat` transients, `beatPhase`/`barPhase`/
  `phrasePhase`/`beatPulse`, `bpm`, plus `spectrum[64]` and `waveform[64]`
  arrays. Shaders receive these as uniforms (`uBass`, `uBeatPulse`, …).
- **Param registry** (`js/params.js`) — *every* control is declared here. The UI
  panels, modulation matrix, preset serialiser and MIDI learn are all generated
  from those declarations. **This is the single most important thing to
  understand**: adding a parameter anywhere gets you a slider, a modulation
  target, preset persistence and MIDI mapping for free. Never add an ad-hoc
  control that bypasses it.

**Layers** (`js/layers.js`) — up to 8, bottom-first. Each has a source, a free
transform, blend mode, optional **matte source** (a second feed used as a mask),
and its **own effect chain**. Per-layer effect params register lazily as
`L<id>.fx.<effect>.<param>`, so they are first-class registry entries.

**Sources** (`js/sources/sources.js`) — 10 generators, 9 elements (alpha
overlays: ring, meter, scope, dots, sweep, blob, frame, sparks, gradient),
4 camera slots, screen capture, dropped media.

**Effects** (`js/shaders/effects.js`) — 25, each one object with `params` + a
GLSL body. `OUTPUT(c)` handles wet/dry and preserves alpha. Flags `needsFlow` /
`needsBackground` cause the renderer to compute optical flow or a background
estimate for that chain only.

**Optical flow** — single-scale Lucas-Kanade at quarter res, refined
incrementally (each frame warps the previous by the previous estimate).
Powers Flow Smear / Trails / Ink / Displace.

## Landmines — read before editing shaders

Each of these cost real debugging time in the last session:

- **`js/shaders/common.js:header()` puts `LIB` before `extra`.** Helper
  functions in a pass's prelude can use `TAU`, `luma`, `palette`. Reversing it
  breaks every shader at once.
- **A backtick inside a GLSL comment** silently terminates the JS template
  literal. Symptom is a bizarre `SyntaxError` in `renderer.js`.
- **`layout` is a reserved GLSL keyword** — it cannot be a local variable name.
- **Effects must preserve alpha.** Layers composite by alpha; an effect that
  writes `1.0` turns every overlay into an opaque rectangle. Use `OUTPUT()`.
- **Optical flow units:** the LK solve returns *texels*, flow is stored in *uv*.
  The `delta *= uFlowTexel` conversion is load-bearing — without it the
  estimator oscillates to its clamp and the field is pure noise.
- **Zero flow encodes as 0.5**, not 0. Clearing a flow buffer to black means
  "full speed left".

## Freezes: what is downstream of one rAF

The preview, the projector pop-out, the recorder **and every video source's
texture upload** all hang off one `requestAnimationFrame` in one window. Any
main-thread stall freezes all of them together, and a frozen capture is silent —
the last frame just stays on the wall. Four things fixed after the first show:

- `Setlist.stats()` used to `JSON.stringify` the whole show to report its size,
  and `ShowUI.rebuild()` called it on every cue, song and look click. A 90-song
  set is 775 KB. The size is now whatever `save()` last measured.
- `App.frame()` is wrapped. `_effectShader` **caches its failures**: a GLSL error
  in a lazily compiled effect used to re-throw every frame, and since the
  `projCanvas` copy is the last thing in the frame, the projector and the
  recorder froze for good while the UI kept taking clicks.
- `projCanvas` is no longer `desynchronized` — it is never in the DOM, so the
  low-latency path bought nothing and `captureStream` reads it.
- `Output.stopRecording` stops its capture sink. Each REC cycle used to leave
  another live reader attached to the canvas for the rest of the session.

`VideoSource` now keeps its `<video>` **in the document** (a detached media
element is fair game for suspension and never resumes on its own), re-plays on
`pause`, and classifies a frameless-but-live feed via `checkStall()` into
`paused` / `ended` / `muted` / `surface`. Only the last is not the app's fault:
it means the captured window has stopped redrawing, and the Inputs panel says
so rather than leaving the user to blame the renderer.

## Verification

`selftest.html` is the safety net — **keep it green**. 89 checks: every shader
compiles (effects compile lazily, so a broken disabled effect is otherwise
invisible until enabled mid-set), every source renders through the full chain,
per-layer chains stay isolated, optical flow tracks a known translation, depth
keying actually keys, and the audio/tempo chain hits known ground truth against
a synthetic 124 BPM loop, the picture-drag tracks the pointer through a keystone
without moving the quad, and a frozen feed is classified into the right cause.

```bash
./serve.sh &
/opt/google/chrome/chrome --headless=new --disable-gpu \
  --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader \
  --autoplay-policy=no-user-gesture-required --virtual-time-budget=90000 \
  --dump-dom http://127.0.0.1:8080/selftest.html
```

Require the `RESULT:` line in the output. Grepping only for `FAIL` reports
success on a run that never finished — that happened.

Drive a **local** headless Chrome against the dev server — a remote browser
cannot reach this machine's localhost. `--use-fake-ui-for-media-stream` grants
camera access without a prompt, and `--screenshot=out.png <url>` grabs the UI.

**`browsercheck.html` is the second net**, and the one that matters for anything
touching boot, the DOM or pointer geometry. It loads the real app in an iframe
and drives it by hand — clicks the panel headings, drags corner handles and
pictures with synthetic `PointerEvent`s, presses keys — then reports a `RESULT:`
line the same way. Its header carries the command. Keep the iframe small: it
renders under SwiftShader, and the virtual-time budget is spent on frames.

**Pixel checks must `pump()`, not sleep.** Headless Chrome under a virtual-time
budget does not promise a rAF tick after a state change, so a check that slept
and then read the canvas was testing the scheduler. `pump()` calls `app.frame()`
directly - the same entry the rAF loop uses - so the dispatch under test is the
real one and the result is deterministic.

It has already earned its place twice. It caught `draw(false)` skipping
`_resize()`, which is the only place `dpr` is set: every handle size and font
became `NaN`, canvas silently ignored them, and the quad outlines - which scale
by canvas size, not dpr - still drew. The picture looked almost right and not one
corner handle existed. The first version of the check counted lit pixels over the
whole overlay and passed on the outlines alone; it now measures the fill of a box
*at* a corner, which is the thing being claimed.

It also caught a stale `getBoundingClientRect()` in the *test*:
the overlay moves 113px down the moment a plane is comped, because the view bar
grows a row of buttons. The app re-measures on every event and was right; any
test that caches that rect is measuring its own staleness. Same family as the
105px overlay offset that made corners ungrabbable at the first show.

## What was built for the show (2026-09-05)

All three now exist and are covered by `selftest.html`.

### 1. Projection mapping — `js/mapping.js`, output pass in `js/renderer.js`

The renderer ends in up to **eight bus composites** rather than one frame. Each
layer has a `group` param; `Main` (bus 0) is the one the master chain runs on,
`A`–`G` are raw composites for planes that want their own content.

A **plane** (`map.sN` in the registry, "surface" in the code) is a quad on the
projector showing one bus: four corner points in normalized output space, plus a
crop, soft edge, colour trim, and a **variation** block. `Mapping.homography(i)`
solves the unit-square→quad projective map (Heckbert), inverts it, and normalizes
the sign so `w > 0` inside the quad; the output pass inverse-warps `vUv` through
that `mat3` and discards outside `0..1`. One draw per plane, blending off, in
index order.

Things worth knowing before changing it:

- **Sign normalization is load-bearing.** Without it a strong keystone grows a
  mirrored ghost past the projective horizon.
- **`fit` decides what the crop does when a plane moves.** `FIT_WINDOW` sets the
  crop to the plane's bounding box in output space, so the comp behaves like one
  picture behind the wall and planes are holes in front of it. `FIT_WHOLE` is the
  default for frames: cropping a camera into a small window shows a magnified
  corner of the room rather than a picture of it. `applyFit` runs on every corner
  change, on load, and when the output aspect changes.
- **Corner pairs** link the two crease corners and re-split the crop by the two
  quads' real widths (`recomputeSeam`), so the picture crosses the corner without
  stretching. Paired planes are `FIT_MANUAL` — the seam owns their crop.
- **`empty` decides what a plane does when its bus is empty**: show the main comp
  (default, and what makes eight planes usable at all), go black (a painting you
  want to keep light off), or show nothing.
- **Variation is sampling, not layers.** Hue, zoom, pan, rotation, mirror and
  drift are uniforms in the output pass, so eight planes on one comp cost exactly
  one comp. Mirrored-repeat sampling means pushing past the edge folds back
  rather than smearing a clamped edge.
- **Planes are excluded from cues** — `Presets.capture()` drops `map.*` and the
  camera framing groups (`cam`, `cam2`, …). Both are facts about the rig.
- **`params.dropGroup()`** is used by `LayerStack.clear()`; without it a deleted
  layer's values ride along in every later snapshot.
- **The preview and the projector are different frames.** `#gl` holds the mapped
  output, which is copied to `app.projCanvas` (what the pop-out and the recorder
  read) *before* the preview is allowed to diverge into an isolate view or a
  zoomed-out alignment view. `letterboxRect` is shared by the renderer and the
  pointer code so they can never disagree by a frame.
- **`MapEditor` has two tools and three live states**, all on the one shared
  overlay (`js/ui/map-edit.js`). `tool` is `'corners'` or `'picture'`.
  `cornersLive` is true whenever the **Setup tab** is open — corners no longer
  need a mode armed, because needing one was the complaint. `enabled` adds
  dragging a whole quad by its middle, which is the destructive gesture and so
  keeps its key. `blocksPointer` is what `CanvasEditor` defers to: passive
  corners are *not* blocking, so a drag that misses a handle still reaches the
  layer editor, and both sets of handles are drawn (`draw(false)` composites the
  corner handles over the layer ones instead of clearing them).
- **The Picture tool writes `vPan`/`vZoom`, never the crop.** `setCorner` calls
  `applyFit`, which rewrites the crop for every fit mode but Manual, so a pan
  stored there is undone by the next corner nudge. `_panDelta` negates, mirrors,
  rotates and divides by zoom exactly as `OUT_FRAG` does, and the pointer is
  re-measured in the plane's own space each move (`_planeLocalFor`) rather than
  tracked as a screen delta — under a keystone those are different amounts of
  picture at the near and far edge. **Lock guards geometry, not the picture.**
- **`renderer.planePreviewVaried`** makes the isolate view show a plane's own
  pan and zoom, and is set only while the Picture tool is up. The rest of the
  time that view stays flat, because layer handles are measured against it.
- **Pins** (`renderer.pins`) draw a source into a bus after the cue's layers,
  either replacing or overlaying. They are deliberately outside cue state.

### 2. Setlist / cues — `js/setlist.js`

Songs → cues, built on `Presets`. Two changes there:

- `capture({ compact })` stores only what differs from each param's default.
- `applyState` **diff-applies the stack**: if the serialised layer list is
  unchanged it keeps the Layer objects and their aux buffers, so trails survive
  a cue change within a song. Anything absent from a compact cue is reset to its
  default, so a compact state is still a complete one.

Advance is manual by choice (`PageDown`, `,`/`.`, MIDI footswitch actions in
`midi.js`). Position is saved and `?show=1` resumes it.

### 3. Photos — `js/sources/sources.js`, `tools/import-photos.py`

`PhotoSource` is ONE source with an `index` param, not one source per picture.
A cue snapshots the whole layer stack, so 34 photo sources would ride along in
every saved cue and fill the source picker; an index is a number, which is also
what lets `songPhoto()` give each song its own. Two decks (`photo`, `photo2`)
because the index is a single parameter, so two frames showing different
pictures needs two of them.

Images load on demand and are cached, and a photo that has not arrived renders
as nothing rather than as a black rectangle. `media/photos.json` is the
manifest; `loadPhotos()` also narrows each deck's index range to the album that
actually exists. `tools/import-photos.py` rebuilds both from a folder — it
applies EXIF rotation (phones store it rather than rotating pixels, so without
it a third of any album is sideways) and routes HEIC through ffmpeg.

### 4. Song feels — `js/show-templates.js`

Fifteen templates × variants, five cues each, generated in about a second.
`buildFeel()` resets first — a feel that inherited the previous stack silently
ran into the eight-layer cap.

**Element sources are shared.** `el:solid` is one instance: a feel using it on
the wall and in a frame gets the same pixels, differing only by layer transform
and opacity. That constraint shapes several feels.

Two self-tests exist because both problems were real and invisible otherwise:
every frame comp, and every wall **with no camera or screen attached**, is
rendered and its mean luma measured against a floor. Ten frame comps and six
walls failed the first time they ran.

### 5. Auto projection mapping — `js/calibrate.js`

Structured light. `run()` projects black, white and four blobs at known
projector uv (via `renderer.calibration`, which bypasses the mapping stage
entirely), takes each blob's centroid in the camera, and solves the projector→
camera homography from those four correspondences. The lit-minus-unlit
difference is the projector's footprint *and* the surface reflectance, so an
Otsu split over it separates wall from picture; connected components on the dark
class become surfaces via the inverted homography.

Three bugs here were only visible because the self-test simulates a camera
rather than mocking the maths — build the simulated-camera fixture first if you
extend this:

- `brightestCentroid(d2)` was called without width/height, so the centroid loop
  never ran and every blob "vanished".
- The camera→projector step applied a y-flip that the homography already
  carried, putting every detected frame upside down.
- The lit-area threshold (28% of peak) excluded the paintings themselves, so the
  search for dark regions inside the lit area could never find any.

It refuses rather than guesses: coverage below 4% of the camera view, or four
blobs spanning under 2% of it, both abort without touching the surfaces. A false
positive would silently move the mapping off the wall mid-setup.

## Show-day checklist

1. **Setup › Send to projector.** Sets the aspect and the native pixel size, and
   opens the output window on the second display. Click that window once for
   fullscreen.
2. **Build the planes.** `+ Corner` for the two walls, `+ Frame` per painting, or
   `◎ Scan for frames` to place the frames from a camera. Then `G` twice for
   **white panels** and drag the corners onto the real thing — they are live as
   soon as the Setup tab is open, no key first. `M` adds sliding a whole quad by
   its middle. `−` zooms the preview out to reach corners that sit past the
   projector's edge.
3. **Lock them.** *Lock all planes* in Align, once they are right. Nothing will
   move after that — except the picture inside them, which is the point: `D`
   then drag inside a plane to place what it shows, Alt+wheel to zoom it.
4. **Cameras.** Check the C922 is in slot `CAM` (the ★ moves it) — the **Inputs**
   panel at the top of the left column. If it is mounted upside down on the
   projector, hit **⟳ 180°** in the framing panel. If a feed freezes, Inputs
   names the cause; for screen capture prefer a tab or the whole screen over a
   single window, which stops redrawing once it goes behind something.
5. **Trim for the room.** The wall is yellow and eats blue. Use warm tones and
   luminance contrast, and for a dim lamp reach for **Invert** and **Black lift**
   before Brightness — inverting a dark comp is the biggest win available.
6. **The show.** `⟳ Re-cue all songs` if the set predates a template change, then
   walk it once with `PageDown`. Set one plane to bus B or C for the camera comps.
7. **Audio.** A mixer feed if there is one, else the Logitech mic. Tap and Lock if
   the tempo drifts on brushed drums.
8. **Check FPS** at the real output resolution. Drop Resolution to 75% if the
   flow-based camera looks cost too much.
9. **Panic keys**: `Esc` all FX off · `` ` `` blackout (hold) · `Shift+M` unmapped
   full frame · `Shift+P` drop every pin · `X` clear feedback · `H` show/hide the
   UI (there is a corner button back in if it is hidden). A plane whose picture
   has wandered: `D`, then double-click it.

## Not done / deliberately parked

- **Kinect v1 depth**: app-side support is complete and tested (per-layer matte,
  Depth Warp, Depth Slice, `tools/kinect-pump.c` bridge, compiles clean under
  `-Wall -Wextra`). But `v4l2loopback-dkms freenect libfreenect-dev` were never
  installed — that needs a sudo password. Irrelevant to the show unless the user
  brings the Kinect.
- Autopilot exists but is untested against a real set; it randomises the least
  visible layer on bar/phrase boundaries.
