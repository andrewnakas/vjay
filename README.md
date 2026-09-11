# VJay

Audio-reactive visual mixer, and a projection mapper. Webcam, screen capture,
generated GLSL or dropped media on two decks, mangled by an effect chain that
the music drives, then corner-pinned onto real walls and picture frames. No
build step and no dependencies — plain ES modules, WebGL2 and Web Audio.

Built for a live acoustic set projected into the corner of a room, and used for
one. It is a performance tool first: nothing moves unless you move it, every
alignment can be locked, and there are panic keys.

**[Try it in the browser →](https://andrewnakas.github.io/vjay/)**
· [Desktop builds](https://github.com/andrewnakas/vjay/releases) for macOS,
Windows and Linux.

The hosted version is the whole app — it runs entirely in your browser and
nothing you point it at leaves your machine. The desktop build exists because a
projector, a webcam and a second display are less fuss outside a browser tab.

## Run it locally

```bash
./serve.sh          # http://localhost:8080  (port 8080, or pass another)
```

`localhost` counts as a secure context, so camera, mic, screen share and WebMIDI
all work over plain http. Chrome is the target.

Click **Start with test audio** to get a synthetic 124 BPM loop and try
everything without granting mic access. `?test=1` skips the splash.

## Audio in

| Source | How |
| --- | --- |
| Mic / line-in | Pick it in **Audio in**, press **Use input** |
| System audio (Linux) | Pick the **🔁 Monitor of …** device — PulseAudio/PipeWire exposes one per output |
| System audio (fallback) | **System audio** button → share a tab or screen with audio ticked |
| Audio file | Drop an mp3/wav anywhere on the window |

If no monitor device is listed, `pactl load-module module-loopback` will create one.

## Looks

The **Looks** panel is the fast way in — each one sets a whole patch: sources,
two or three effects, and a couple of modulation rows. The `Cam ·` looks are
built for the webcam:

- **Cam · Trails** — video feedback; you smear into a tunnel of yourself
- **Cam · Neon** — your outline in neon over black; best on a projector
- **Cam · Motion** — only movement is lit; hold still and you disappear
- **Cam · Smear** — slit-scan, each strip of the image lags in time
- **Cam · Kaleido** — mirrored petals of the camera feed
- **Cam · Flow** — optical-flow motion blur; moving parts smear, still parts stay sharp
- **Cam · Ink** — move and you paint; ink follows the flow, hue set by direction
- **Cam · Liquid** — the image pushes against its own motion and goes elastic
- **Cam · Spectrum** — every line of your outline pushed and lit by its own frequency band

Starting the webcam the first time drops you into Cam · Trails automatically.

## Taming it

Two macros under **Master** scale the whole rig:

- **Reactivity** — multiplies the depth of every modulation row at once
- **Motion speed** — scales the visual clock, so every generator and spin slows

Turn both down for a resting state; push them up for a peak. Looks are
deliberately sparse — a patch with everything on reads as noise and you stop
being able to see the kick land.

## Layers

The mixer is a stack of up to 8 layers, bottom first. Each layer holds one
source, a free transform, a blend mode, and **its own effect chain** that runs
before the layer is composited. A master chain then runs on the result.

```
source → transform + colour → layer FX chain ─┐
source → transform + colour → layer FX chain ─┼→ composite → master FX → screen
source → transform + colour → layer FX chain ─┘
```

Add a layer by clicking a source, or **drag a source card onto the preview** to
place it where you drop it. On the preview:

| Gesture | Action |
| --- | --- |
| Drag inside a layer | Move it |
| Drag a corner handle | Scale (Shift stretches one axis) |
| Drag the grip above | Rotate (Shift snaps to 15°) |
| Wheel / Shift+wheel | Scale / rotate |
| Shift + arrow keys | Nudge the selected layer |
| `[` / `]` | Move it down / up the stack |

`✥ Edit` (or `E`) hides the handles — the projector output never contains them.
The layer list supports drag-to-reorder, and double-clicking a layer renames it.

Layers composite by **alpha**, so overlays work properly: elements are
transparent, and **Key out below** drops the dark part of any source so a camera
or generator sits over a background without a black rectangle.

**Crossfader**: assign a layer to side A or B (keys `A` / `B` / `N`, or the
Crossfader param). The fader then scales those layers' opacity, so it works the
way a deck fader does even though everything is layers.

## Elements

Nine simple audio-reactive overlays with real alpha, meant to be stacked on a
camera or screen capture rather than used as backgrounds:

**Ring** (band-driven, dashable) · **Bar Meter** (spectrum) · **Scope**
(waveform: line, mirror or circle) · **Dot Grid** · **Sweep** (beat/bar synced)
· **Glow Blob** · **Frame** · **Sparks** (fired by kick/snare/hat) ·
**Solid / Gradient**

Each has a *Driven by* or equivalent control so you choose which part of the
audio moves it. **Elements** and **Cam · Overlay** are ready-made stacks.

## Kinect v1 (depth)

A Kinect is **not** a UVC device, so Chrome cannot see it directly. `tools/`
bridges it into ordinary virtual cameras:

```
Kinect → libfreenect → v4l2loopback → /dev/video10,11 → Chrome → VJay layers
```

```bash
sudo apt-get install -y v4l2loopback-dkms freenect libfreenect-dev v4l-utils
./tools/kinect.sh          # colour + depth
./tools/kinect.sh --ir     # IR + depth
```

`kinect.sh` loads v4l2loopback with `exclusive_caps=1` (without it Chrome
ignores the nodes), builds `kinect-pump.c`, and streams **Kinect Colour** on
`/dev/video10` and **Kinect Depth** on `/dev/video11`. Depth is
`FREENECT_DEPTH_REGISTERED`, so it is aligned to the colour camera and a depth
matte lines up with the image it masks. Distance is mapped to 8-bit luma over
`--near`/`--far` millimetres (default 500–4000); a no-reading pixel becomes
white so a near-range key treats it as background.

Two constraints: the colour and IR streams share one camera, so you get one or
the other; and the sensor needs its **12V power adapter** — USB alone enumerates
it but will not stream.

### Depth keying

Every layer has a **matte source**: a second feed used as a mask. Point a
layer's source at Kinect Colour and its matte at Kinect Depth, set **Matte** to
*Depth window*, and **Matte near/far** become a distance gate — a clean cut-out
with no green screen. **Kinect · Depth Key** sets this up.

Two effects read the matte: **Depth Warp** (displaces by distance, so a hand
reaching forward drags the image) and **Depth Slice** (quantises depth into
offset cut-out planes). Both pass through untouched when no matte is assigned.

## Launch parameters

```
?test=1              skip the splash, run the synthetic 124 BPM loop
?look=camPip         start in a named look
?layers=cam,el:meter build a layer stack, bottom first
```

Handy for a projector or kiosk: bookmark the exact state you want to open in.

## Optical flow

Four effects derive per-pixel motion from the image itself rather than sitting
on top of it, so they behave like a filter on the video: **Flow Smear**
(directional motion blur — still areas stay sharp), **Flow Trails** (feedback
dragged along by the motion instead of a fixed zoom), **Flow Ink** (ink dropped
where things move, carried by the flow, hue from direction) and **Flow
Displace** (exaggerates or reverses the motion; negative amounts make the
picture resist you).

Estimation is single-scale Lucas-Kanade at quarter resolution, refined
incrementally: each frame warps the previous frame by the previous estimate
before taking the temporal gradient, which tracks motion larger than the 3×3
window without paying for an image pyramid. Flow is stored in uv units per
frame, which is what advecting a one-frame-old feedback buffer wants.

It only runs while a flow effect is switched on. Tuning lives under **System ›
Optical flow**; turn on **Flow Displace › Show flow field** to see direction as
hue and speed as brightness while you dial it in.

## Modulation

Any audio feature or tempo-synced LFO can drive any parameter. Right-click a
control → **Modulate with…**, or use the Modulation tab. Sources include the
five bands, RMS level, spectral flux and centroid, low/mid/high transients,
beat/bar/phrase ramps, and four LFOs synced to beat divisions.

`kick`, `snare` and `hat` are **band-transient detectors, not instrument
classifiers**. They name what each usually tracks, but on dense material the mid
detector also catches a kick's click. Fine for driving visuals; worth knowing
before patching one to something that must only move on the actual snare.

## Tempo

BPM comes from autocorrelating the onset envelope, with a phase-locked beat
grid that free-runs when confidence drops. **Tap** (or Space) and the BPM field
override detection — use them when the detector loses the plot mid-set.

## Cameras and screen capture

**Inputs** is the first panel in the left column: the `Screen` button, the camera
list, and the framing controls for whichever cameras are running. Every panel in
that column folds away by clicking its heading, and what you fold stays folded
across a reload.

Up to four cameras run at once, in slots `CAM`, `CAM2`… Start each one from
**Inputs › ⟳ Cameras**; the slots are remembered, so a reload brings them back
rather than making you re-aim anything.

**If a feed freezes, Inputs says so and says why** — `frozen 4s` plus one of:
the video element was suspended (restarted for you), the capture has stopped, the
source went quiet, or *the captured window has stopped redrawing*. Only the last
is outside the app: a window that has gone behind another one often stops
drawing, and its capture legitimately freezes with it. Capture a **tab** or the
**whole screen** rather than a single window and it keeps running while you work
in VJay. **↻ Restart** re-picks the surface without disturbing the layer.

Which camera is in slot **CAM** matters: every camera-driven look and song feel
points at it. Press **★** next to another camera to move it into that slot and
swap the previous one out. The usual arrangement is the camera you aim at the
room in `CAM`, and a second one — pointed at the wall — used only for
**Auto-map**, which has its own picker.

## Projection mapping

**Setup** tab. It runs in the order you actually work: Projector, Planes, Align,
Look, Venue.

A **plane** is a quad on the projector — four draggable corners, so a wall the
projector is not square to is corrected by a homography, which is what a
corner-pin is. Each plane shows one **bus**: `Main` plus `A`–`G`. Layers carry a
bus, so a picture frame can show its own comp.

### Building the shapes

| Button | |
| --- | --- |
| `+ Wall` | A full-frame plane on Main |
| `+ Corner` | Two walls meeting at a crease. The inner corners are **linked** — drag one and both move — and the picture is re-split between them by their real widths, so neither side stretches |
| `+ Frame` | A picture frame with its own bus |
| `◎ Scan for frames` | Structured light: projects patterns, watches with a camera, puts a plane on each painting |

Each plane has **Comp follows**, which decides what happens to the picture when
the plane moves:

- **The window** (default for wall planes) — the comp is one big picture hanging
  behind the wall and the plane is a hole cut in front of it. Move the plane and
  it reveals a different part. Several planes then read as one image.
- **Whole comp** (default for frames) — the entire comp fills the plane, nothing
  cropped. What you want for a camera or a picture.
- **The shape** — a centred crop at the plane's own aspect. Never squashed, but
  it does crop.
- **Manual crop** — yours; nothing recomputes it.

### Alignment

**Corners are draggable whenever the Setup tab is open** — there is no mode to
arm first. Layer handles keep working alongside them: a drag that lands on a
corner handle moves the corner, anything else falls through to the layer under
it. Grabbing a handle moves the corner *by* the drag, so a grab that is slightly
off does not shift it before you have started.

| Key | |
| --- | --- |
| *(none)* | **Drag a corner.** Live on the Setup tab. `Tab` next plane, `1`–`4` pick a corner, arrows nudge, Shift+arrows by ten |
| `M` | **Move planes** — also drag a whole quad by its middle, and Alt+arrows to shift it. The destructive one, so it still takes a deliberate press |
| `D` | **Picture** — drag what is *inside* a plane. See below |
| `G` | Off → grid → **white panels**. White is what you align against a real frame across a room |
| `−` / `=` | Zoom the preview out past the projector's edge, to reach corners that sit off it. Pinch also zooms while corner editing; two fingers pan. A dashed amber rectangle marks where the projector actually stops |
| `S` / `Shift+S` | Comp one plane on its own / back to the full output |
| `Shift+M` | **Bypass** — a plain unmapped full frame. The panic key |

**Lock planes when they are done**: the padlock on each plane row, or *Lock all
planes* in Align. A locked plane cannot be dragged or nudged by any route — but
its *picture* can still be moved, which is exactly what you want once the frame
is nailed to the wall.

### Moving the picture inside a plane

`D`, or **✥ Picture** in Align, or the button in the view bar while a plane is
comped. Then **drag inside any plane** and the picture it shows moves with the
pointer; the plane itself does not move at all.

| | |
| --- | --- |
| Drag | Move the picture. Tracks the pointer through the keystone, so it works the same at the near and far edge of a steeply angled wall |
| Alt + wheel | Zoom the picture in that plane |
| Alt + Shift + wheel | Turn it |
| Arrows | Nudge; Shift+arrows by ten. `Tab` moves to the next plane |
| Double-click | Put that plane's picture back to where it started |

This is the same per-plane **variation** the *Vary all planes* macro writes, so
it costs nothing per plane and it works even when eight planes share one comp —
a frame showing the main wall comp gets its own view of it. It is venue
calibration, not performance state: it stays out of cues and lives with the
mapping, so a cue change can never slide a picture out of its frame mid-song.

It works in a plane's own view too, where the preview switches to showing the
plane's real pan and zoom. Layer handles stand down while it is up — they are a
different tool, and handles drawn against a moved picture is the bug that view
exists to remove.

A bare wheel still does nothing, anywhere.

### Comping a plane

Click a plane in the **view bar** above the preview and the preview becomes that
plane's comp, flat and at its own shape, with the layer handles moved into that
space. **The projector keeps showing the full mapped output**, so this is safe
mid-set. Anything you add while comping lands on that plane's bus.

Eight planes cannot each have their own layers, so most show the main comp.
**Variation** is what stops that being eight copies: per-plane hue, zoom, pan,
rotation, mirror and drift, all applied in the output pass at no cost.
*Vary all planes* spreads them around the first plane, which is left as the
reference.

A plane whose bus is empty **falls back to the main comp** by default. Set it to
*Go black* for a painting you want to keep light off, or *Show nothing* to let
the wall show through.

### Pinning a feed

A **pin** forces one feed into one comp and stays there. Pins live outside cue
state deliberately, so the next cue cannot undo one. Pick a source in the view
bar's `📌 pin a feed…`, then switch it between **override** (replaces the comp)
and **over** (sits on top). Every live pin shows as a chip at the top of the view
bar; click a chip to remove it, or press `Shift+P` to drop them all.

### A dim projector

Master and per-plane **Invert** and **Black lift**. Inverting a mostly-dark comp
is the biggest brightness win available — it puts most of the lamp on the wall
instead of most of nothing. *Dim projector* in the Look step lifts and boosts a
plane in one click.

The wall is **yellow, and yellow paint absorbs blue** — blue and violet content
comes back dim and muddy. Lean on warm tones, whites and luminance contrast, and
trim the per-plane gains against the white panels in the room.

Planes are venue calibration, not performance state: they live in their own
storage, are excluded from cues, and export from the Venue step or with the show.
Lock **Output aspect** to the projector's shape first — corner points are
normalized, so changing it later stretches everything. *Send to projector* sets
both the aspect and the native pixel size for you.

### Cameras

Slot `CAM` is the one every camera look and song feel reads. The Logitech C922 is
ranked ahead of a built-in webcam and is promoted into that slot automatically;
the **★** next to a camera moves it there by hand.

Under the camera list, **framing** per camera: Zoom, Pan, Mirror, and **⟳ 180°**
for a camera mounted upside down on top of a projector. These live on the source,
so one correction fixes every comp, pin and look at once — and they are kept out
of cues, so a cue change never re-frames your camera.

### Corner 3D

Six generators hang their geometry on the crease rather than the middle of the
frame, which is what makes a 90° corner read as depth instead of as a fold. They
find the crease through `uSeam`, set from the corner pair's split, so they line
up with the real corner rather than assuming the centre.

| Generator | |
| --- | --- |
| **Corner Corridor** | A tunnel whose vanishing point sits on the crease |
| **Corner Light** | Warm light pouring out of the corner itself — the calm one |
| **Monolith** | Lit slabs floating in front of the corner |
| **Corner Hall** | Floor, ceiling and a far wall in honest perspective. A level floor crossing the crease bends, and the eye reads that bend as depth. The strongest of the six |
| **Vault** | A lit rectangular recess cut into the corner. The wall around the opening stays black, so it reads as a hole rather than a picture |
| **Corner Helix** | A ribbon winding around the axis into the corner, strands passing in front of each other. Occlusion is the depth cue the eye trusts most |

Six feels use them: Hallway, Corner Glow, Standing Stones, Deep Room, Doorway,
Long Room, Alcove and Ribbon.

## Photos

> The album that shipped with the original set was personal and is not in this
> repo. `media/photos/` starts empty, and an empty album is a normal state —
> the Photos decks simply have nothing in them. Point
> `tools/import-photos.py` at any folder to make your own.


Drop an album into `media/photos/` with a `media/photos.json` manifest and it
becomes two **decks**, split by what the pictures actually are. The importer
classifies each one:

- **Cut-outs** — a figure already lifted onto black. The border is dark while
  the middle is not, which is measurable, and it means the picture was made to
  be composited.
- **Scenes** — a photograph of a place.
- **Skipped** — screenshots with app chrome, out-of-focus frames. Judged by eye,
  not by a metric, and marked `skip` in the manifest.

The two get opposite treatments, because they are opposite kinds of material:

| | Where | How |
| --- | --- | --- |
| **Figure** | In the composition, in front of the feel | Luma-keyed so the black drops out, *Contain* so the whole body is always in frame, scaled to 72% so the feel reads as the space they stand in, sat slightly low so they look grounded. Bloom, and a breath on the beat |
| **Scene** | Behind everything | Held well down in brightness — half an album shot on snow comes back near white and will erase the feel — then wrecked by one of four treatments: frequency **bands**, **kaleido**, **liquid** flow, or **sliced** glitch, each on its own audio-reactive axis |

**One song in three** carries a figure, one in three a scene, one in three is
pure generative. A photograph in every song stops being a photograph and becomes
wallpaper.

The whole album preloads at startup, so a cue change shows its picture on the
same frame rather than a beat later. The **Photos** panel in the Sources column
steps and randomises each deck, and a deck can be pinned onto any plane to hold
a picture there regardless of the cue.

`tools/import-photos.py <folder>` rebuilds everything: EXIF rotation (phones
store it rather than rotating pixels, so without it a third of any album is
sideways), resize, HEIC through ffmpeg, classification, and the manifest.

## Saves

`./vjay-save.sh` writes a timestamped snapshot to `../vjay-saves/`. `list` shows
them newest first, `restore` puts one back — and saves the current state first,
because overwriting unsaved work with no way back is how you lose the thing you
were trying to keep.

## Show — songs and cues

**Show** tab. A set is songs, each holding an ordered list of **cues**; a cue is
a whole state plus how many beats to glide into it.

**Generate show** builds a full set from the twenty built-in *feels* — one song
title per line, five cues each (Intro / Verse / Chorus / Bridge / Outro). Thirty
songs is 150 cues and about 200 KB, so it fits in browser storage; export writes
the set and the venue calibration to one file, which is the real backup.

Every song also gets two camera comps: **bus B** is one camera with one of the
ten camera looks (Trails, Neon, Motion, Smear, Kaleido, Spectrum, Flow, Ink,
Liquid, Soft bloom), rotating per song, and **bus C** is both cameras with the
same chain on each, soft-edged as a framed picture. Set a plane to B or C and it
is there all set.

**A cue is a snapshot of a whole layer stack**, so changing the templates does
not reach a show that already exists. `⟳ Re-cue all songs` rebuilds every song's
cues from the current templates, keeping the running order, names and feels —
that is how an existing set picks up new camera comps. `⤨ Reshuffle feels` also
spreads the feels again, which is how songs pick up feels added since the show
was built. Both discard hand edits to cues, so export first.

| Key | |
| --- | --- |
| `→` / `←` | **Next / previous cue.** The two keys you can find without looking, which is the requirement for something pressed between songs in the dark |
| `Ctrl+→` / `Ctrl+←` | Next / previous song |
| `PageDown` / `.` | Next cue — same thing, for a footswitch or a presenter remote |
| `PageUp` / `,` | Previous cue |
| `Ctrl+PageDown` / `Ctrl+PageUp` | Next / previous song |
| `Ctrl+U` | Overwrite the current cue with what is on screen |

While corner editing (`M`) the arrows nudge the selected corner instead, so
aligning a plane never jumps the show. `Alt+←/→` nudges the crossfader, and
`Shift+arrows` nudges the selected layer.

Advancing is manual by design — nothing moves unless you move it. A footswitch
works too: **Footswitch** in the Show tab learns a MIDI pedal for next/previous
cue and next song, so both hands stay on an instrument.

Cues within one song share a layer stack, so moving between them keeps trails
and feedback running rather than snapping to black. Tweak anything live and
press **Update cue** to keep it.

`?show=1` skips the splash and resumes the saved show at the cue it was on — a
bookmark worth having if the browser dies mid-set.

### Feels

Fifteen templates, written for an acoustic set on a projected wall: calm, two or
three moving parts, rotation near zero, driven by `level`, `mid` and `centroid`
rather than by transients. Each also fills the frame group with a brighter,
lower-detail comp, because fine detail is lost on a painting and a dark frame
reads as a fault.

**Campfire · Front Porch · Dust · Ripple · Quilt · River · Stained Glass ·
Lantern · Moss · Tunnel Road · Sunset · Stomp · Neon Portrait · Window ·
Mirror Hall**

Three of them use the webcam or screen capture; they still light the wall on
their own if the camera never comes up. **Try** loads a feel without touching
saved cues; **Rebuild cues** replaces one song's cues from it.

## Output

**Output ⧉** (or `O`) puts a second window on the projector — it finds the
non-primary display on its own where the browser allows it, otherwise drag it
across — and double-clicking it goes fullscreen. It survives a reload of the
main page: a `captureStream` dies with the canvas that made it, so the window
watches for that and pulls a fresh one within half a second instead of freezing
on its last frame. **● REC** records canvas + audio
to webm. Resolution scale and an FPS cap are under the System tab.

Press **?** for the full shortcut list.

## Desktop build

[Releases](https://github.com/andrewnakas/vjay/releases) carry installers for
macOS (`.dmg`, Intel and Apple Silicon), Windows (`.exe`, installer and
portable) and Linux (`.AppImage`, `.deb`).

It is the same web app in a Chromium shell, served to itself over `127.0.0.1`
so the runtime matches `./serve.sh` exactly. What the shell adds:

- **Screen capture takes the whole screen**, and prefers the display the app is
  *not* on — the projector, on a two-display rig. Capturing a single window is
  deliberately not offered: a window that goes behind another one stops being
  repainted and its capture freezes on the last frame.
- **The output pop-out is a real window**, so there is no pop-up blocker
  between you and the projector.
- **Camera, microphone and MIDI are granted once** instead of per session.
- **The render loop keeps running when the window is not focused**, which a
  background browser tab does not.

On **Linux**, prefer the `.deb` on Debian and Ubuntu. The `.AppImage` needs
`libfuse2`, which Ubuntu 22.04 and later no longer ship — without it the
AppImage exits with `dlopen(): error loading libfuse.so.2`. Either
`sudo apt install libfuse2`, or use the `.deb`.

**Neither build is signed.** There is no Apple or Windows certificate behind
this, so both will warn the first time:

- **macOS** — "VJay is damaged and can't be opened" is Gatekeeper, not damage.
  Run `xattr -cr /Applications/VJay.app` once, or right-click the app and choose
  *Open*.
- **Windows** — SmartScreen shows "Windows protected your PC". *More info* →
  *Run anyway*.

Building it yourself needs Node:

```bash
npm install
npm start          # run it
npm run dist       # installers for the current platform, into dist/
```

## Self-test

```bash
./serve.sh &
chrome --headless=new --enable-unsafe-swiftshader --virtual-time-budget=60000 \
  --dump-dom http://localhost:8080/selftest.html
```

Compiles every shader (effects compile lazily, so a GLSL error in a disabled
effect is otherwise invisible until someone switches it on mid-set), renders
every generator through the full chain, runs the real feature/tempo code over an
offline render of the test loop with known ground truth, drags a plane's picture
through a keystone and checks it tracked the pointer without moving the quad,
and checks a frozen feed is blamed on the right thing.

`browsercheck.html` is the other half, and the one that matters for anything
touching boot, the DOM or pointer geometry: it loads the real app in an iframe
and drives it with synthetic clicks, drags and key presses. Its header carries
the command. Both print a `RESULT:` line — require it, since grepping only for
`FAIL` reports success on a run that never finished.

## Layout

```
js/audio/     engine (input switching) · features (bands, flux, transients) · tempo
js/gl/        WebGL2 context, shaders, FBOs, ping-pong
js/shaders/   common GLSL library · generators · effects
js/layers.js  the layer stack; per-layer effect params register lazily
js/sources/   webcam, screen, media files, generator and element sources
js/ui/        auto-generated param panels · analysis meters · DOM wiring
js/params.js  the registry everything else is generated from
js/renderer.js  layers → composite → master FX → screen
js/ui/canvas-edit.js  on-preview drag / scale / rotate handles
tools/        Kinect v1 -> v4l2loopback bridge (kinect-pump.c, kinect.sh)
```

Adding an effect is one entry in `js/shaders/effects.js`: it gets sliders, a
wet/dry mix, modulation targets, preset support and MIDI learn for free, because
all of those are generated from the param declarations.
