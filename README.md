# Apple Music Lyrics for foobar2000

A synchronized lyrics panel script for foobar2000 powered by `foo_jscript_panel3` with Direct2D and DirectWrite rendering.

## Features

- **Lyric Synchronization**:
  - Syllable-by-syllable smooth sweeps for Enhanced LRC (`<mm:ss.xx>` word timestamps).
  - Line-by-line highlight and auto-scroll for standard LRC (`[mm:ss.xx]` line timestamps).
  - Manual scrolling for unsynchronized plain text lyrics.
- **Backing Vocal Alignment**: Standalone parenthetical lines such as `(chorus)` or `（backing）` automatically align to the right side of the panel, following Apple Music conventions.
- **Bilingual & Romanized Lyrics**: Lines with matching timestamps (e.g. Japanese lyrics followed by romanized or translated text) are paired together as sub-lines under the primary line.
- **Motion & Scrolling**: Damped spring physics provide smooth scrolling and active-word expansion without layout jitter.
- **Background Modes**:
  - **Blurred Album Art**: Reads embedded cover artwork directly from FLAC, MP3, and M4A tags, or searches external folder images (`front.*`, `cover.*`, `%album%.*`, etc.).
  - **Animated Gradient Mesh**: Generates ambient animated color blobs sampled from the track's color palette.
- **Typography & Layout Controls**:
  - Configurable line spacing, font scaling (85% to 130%), and font selection via context menu.
  - Automatic font fallback (`SF Pro Rounded` -> `SF Pro` -> `Inter` -> `Segoe UI` -> `Arial`).
- **Resource Efficient**: Runs at 60 fps during active transitions, steps down to 100 ms polling when static, and halts timers completely when stopped or paused.

## Requirements

- **foobar2000**: v2.x (32-bit or 64-bit) or v1.6+
- **Component**: [`foo_jscript_panel3`](https://github.com/marc2003/foo_jscript_panel3) v3.4 or later

## Installation

1. Install `foo_jscript_panel3` in foobar2000 (*File > Preferences > Components*).
2. Add a **JScript Panel 3** to your foobar2000 layout (Layout Editing Mode in Default UI or Columns UI).
3. Hold `Shift` and right-click inside the panel, then choose **Configure...**.
4. In the script editor, paste the contents of [`main.js`](main.js) (or import the file).
5. Click **Apply** or **OK**.

## Controls

| Action | Control |
|---|---|
| Seek track | Left-click on any timestamped lyric line |
| Manual scroll | Mouse wheel or drag up/down (auto-scroll resumes after 3 seconds) |
| Switch background | Press `B` or select mode from the right-click menu |
| Customize typography | Right-click panel > choose Line Spacing, Text Size, or Font |
| Panel configuration | Hold `Shift` + right-click panel > **Configure...** |

## Lyric Resolution Priority

When a track starts playing, lyrics are searched in the following order:
1. Sidecar `.lrc` file in the track's folder (`track_name.lrc`).
2. Centralized lyrics folder (`%profile%\lyrics\%artist% - %title%.lrc`).
3. Embedded metadata tags (`%lyrics%`, `%unsynced lyrics%`, `%unsyncedlyrics%`).

## Development & Testing

Run the headless smoke test suite using Node.js:

```bash
node test/smoke.test.js
```

Validate ES5 syntax compliance (required by Windows JScript9):

```bash
npx --no-install acorn --ecma5 --silent main.js
```

## License

MIT
