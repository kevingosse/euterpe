# Mascots

Euterpe's body on your screen is a mascot. Clawd, the terracotta box, is the default and is drawn in code. Clawd is Claude Code's mascot, so it only comes with a mind on Claude: with OpenAI and others (`euterpe.provider`), the default is Inky. Every other mascot is a **pack**: one small JSON file with pixel rows and a few numbers. This guide describes the format for anyone who draws one: you, an agent you ask, or Euterpe itself during a session.

Four packs come with the extension, and they're complete examples: [`boo.json`](../mascots/boo.json) (a ghost that floats), [`mochi.json`](../mascots/mochi.json) (a cat with legs and a tail), [`inky.json`](../mascots/inky.json) (an ink drop) and [`clippy.json`](../mascots/clippy.json) (a paperclip with eyebrows, and no arms, legs or mouth). They sit in the `mascots` folder next to this guide's folder.

## Wearing and sharing

- **Euterpe: Choose Mascot** lists every mascot (all but Clawd, off Claude). During a session the body changes at once: the old one walks off and the new one walks in.
- Your own packs live in the `mascots` folder of Euterpe's home (`~/.euterpe/mascots/`, or wherever `euterpe.homeDir` points), one `<name>.json` each. A pack of yours with the same name as a bundled one replaces it.
- **Euterpe: Preview Mascot** draws a pack's model sheet.
- To share a mascot, send the `.json`. **Euterpe: Install Mascot…** checks a pack, shows its model sheet, and asks before copying it into your folder.
- Or ask Euterpe during a session ("can you make me a mascot?", or pick *Make One with Euterpe…* in Choose Mascot). It draws the pack, looks at it, and offers it to you when you're both happy.

A pack is data, never code, so it can't run anything. The only text Euterpe reads from a pack is its `body`, a one-line description of what it looks like. Install shows you that line, word for word, before you agree.

## What the engine does, and what a pack does

The engine animates every body the same way:

- breathing, blinking, glancing around, following your typing with its eyes;
- 23 moods, each with a face, a colour tint and an idle motion;
- gestures (wave, clap, cheer, shrug, facepalm, spin…);
- walking on and off, dangling when dragged, squash and stretch;
- the little marks by the head: `!`, `?`, hearts, zzz, a lightbulb.

A pack provides only the drawing and where things go on it:

- the body, as rows of pixels, in a front view and optionally side and back views;
- where the eyes, mouth and cheeks sit (the engine draws the face);
- optionally, arms and legs, which the engine draws and moves;
- optionally, eyebrows, which the engine shapes with the mood.

Every part gets a one-pixel dark outline automatically, so don't draw one yourself.

## The format

```json
{
  "format": 1,
  "name": "Boo",
  "description": "A small, friendly ghost who floats beside your text instead of walking.",
  "body": "a small, pale lavender ghost with a scalloped hem and little arm nubs; you float instead of walking",
  "colors": { "B": "#E6E2F2", "L": "#F5F3FB", "H": "#FFFFFF", "M": "#C8C1DC", "D": "#A79EC2" },
  "float": 3,
  "arms": { "y": 11, "length": 4, "thickness": 3, "front": [[0, -1], [23, 1]], "side": [[10, 0]] },
  "views": {
    "front": { "rows": ["…"], "eyes": [[7.5, 9], [16.5, 9]], "mouth": [12, 14], "blush": [[5, 12], [19, 12]] },
    "side": { "rows": ["…"], "eyes": [[15.5, 9]], "mouth": [16, 14], "blush": [[13.5, 12]] },
    "back": { "rows": ["…"] }
  }
}
```

| Field | | |
|---|---|---|
| `format` | optional | `1`. |
| `name` | required | Up to 40 characters, shown in the chooser. |
| `description` | optional | Up to 200 characters, for the chooser. |
| `body` | optional | Up to 280 characters: how Euterpe hears its body described, as in "your body is a small pixel creature in the corner: *a small, pale lavender ghost…*". Say what matters for acting, like "you float" or "you have a tail". |
| `colors` | required | The palette. See below. |
| `outline` | optional | The outline colour, `"#RRGGBB"`, or `false` for none. The default is a dark ink. |
| `float` | optional | `true`, or a hover height from 0 to 8 pixels. The body hovers above its shadow and bobs gently. Usually for mascots without legs. |
| `arms` | optional | See [Arms](#arms). |
| `legs` | optional | See [Legs](#legs). |
| `brows` | optional | See [Brows](#brows). |
| `views` | required | `front`, and optionally `side` and `back`. See [Views](#views). |

### Colours

Each character in a row is one pixel:

| Character | Colour |
|---|---|
| `.` or space | transparent |
| `B` | the body's main colour (required in `colors`) |
| `L` | lit: the rim along the top and the left edge |
| `H` | highlight: a glint or two, near the top left |
| `M` | shade: the right edge and the underside |
| `D` | deep shade: the very bottom, the legs |
| `F` | limbs behind the body (a far leg); darker than `D` if you leave it out |
| `0`–`9` | your own colours, defined in `colors` (`"1": "#EE9A94"`) |
| `i` `c` `b` `r` `R` `d` `y` `Y` `k` `K` `v` `g` `G` | fixed colours: ink, cream, blush, rose, red, dark red, ochre, yellow, sky, dark sky, violet, grey, dark grey |

Only `B` has to be in `colors`; the other shades are made from it if they're missing. Moods tint the body's shades (`B` `L` `H` `M` `D` `F`): love turns them pink, sadness blue, pride gold, worry pale. Your own colours and the fixed ones are never tinted, which suits things that shouldn't blush, like inner ears or a nose.

### Views

- **`front`** is required. Its eyes should look out at the writer.
- **`side`** is optional, and faces **right**; the engine mirrors it to face left. It's used for walking on and off, and for turns. Without it the mascot slides in facing front.
- **`back`** is optional, and has no face. Turns and the spin use it; without it the front stands in.

Each view has `rows`, a list of strings of the same length, top to bottom. The limits are 48 pixels wide and 40 rows tall, and 46 tall with the legs. For scale, Clawd's body is 30 × 18 with 7-pixel legs. Mascots between 20 and 32 pixels wide, and 16 to 26 tall, sit well beside a writer.

The body stands on the ground under the middle of its rows, with the legs hanging below. A view can move that point with `"ground": [x, y]`.

### The face

Face positions are points measured from the rows' top-left corner, where each feature is centred. `7.5` is the middle of column 7, and `12` is the line between columns 11 and 12. On a body 24 pixels wide the middle is `12`: a mouth at `12` is centred, and eyes at `7.5` and `16.5` are the same distance from the middle.

- **`eyes`**: `[[x, y], [x, y]]`; a side view has one and a back view none. The engine draws them. The resting eye is 3 wide and 6 tall, covering rows `y − 3` to `y + 2`, and moods swap in others: wide, happy arcs, hearts, sparkles, sunglasses across both eyes. Leave plain body around the eyes, about 5 pixels between them, and 3 or more to the body's edge.
- **`mouth`**: `[x, y]`, about 5 rows below the eyes. There's no mouth at rest; moods and speech draw ones up to 6 wide and 6 tall. Leave it out for a mascot without one; with [brows](#brows), it talks with those instead.
- **`blush`**: `[[x, y], [x, y]]`, the cheeks, a 4-pixel line each, 2 or 3 rows below the eyes and to the outside.

The face is drawn in dark ink. On a dark body, give the face a light patch to sit on, or pick a body colour that ink shows against.

### Arms

```json
"arms": { "y": 13, "length": 4, "thickness": 3, "front": [[1, -1], [22, 1]], "side": [[17, 0]], "back": [[1, -1], [22, 1]] }
```

- `y` is the shoulders' row.
- `length` runs from 2 to 12 and `thickness` from 1 to 4 (the default is 3).
- Each arm is `[x, direction]`. `x` is the shoulder's column, on the body's edge. The direction is `-1` for the arm on the left of the picture, `1` for the right, and `0` in a side view (reaching forward).

Arms are drawn as rounded bars in the body's colours, behind it; a gesture can bring one in front. They carry most gestures: wave, clap, cheer, shrug, facepalm. A mascot without arms still acts, with its whole body. Short arms (3 to 5) read as the nubs of a small creature; long ones look like a person's.

### Legs

```json
"legs": { "width": 3, "height": 4, "front": [[3, 0], [8, 0], [13, 0], [18, 0]], "side": [[5, 1], [9, 0], [14, 1], [17, 0]] }
```

- `width` runs from 1 to 6 and `height` from 1 to 10.
- Each leg is `[x, far]`, where `x` is its leftmost column. Set `far` to `1` for a leg behind the body, drawn darker; in a side view, every other leg is far.
- Legs hang below the rows, walk, and swing when dragged.

### Brows

```json
"brows": { "above": 10, "width": 5, "color": "#5A5068" }
```

- The engine draws a brow over each eye and moves it with the mood: raised in surprise, knitted in worry, lowered in anger, one up in curiosity. A mascot without a mouth talks with its brows.
- `above` is how far above each eye's centre a brow sits, from 3 to 16 (the default is 6). `width` runs from 3 to 9 (the default is 5).
- `color` is their fill, a soft ink by default. They get an outline like every part, so pick a fill that still shows on a dark editor.
- `"brows": true` takes every default.
- Brows can sit on the body, or float over the background above the eyes, as Clippy's do. Leave a few rows for them to rise into.

## Drawing it well

- **Silhouette first.** At 20 to 30 pixels, what reads is the outline: ears, a tip, a hem, a tail. Get the shape right in `B` before shading.
- **One light, top left.** Put `L` along the top and the left edge, one to three `H` pixels near the top left, `M` down the right edge and along the underside, and `D` on the bottom row. The bundled packs follow this.
- **Keep the face area plain `B`.** The engine draws eyes, mouths and blushes over it, and a pattern underneath muddies them.
- **Don't draw the eyes or the mouth** in the rows; they're the engine's, and they change with every mood.
- **Symmetric front, centred features.** Build the front view symmetric, and put the face on its middle line (see [The face](#the-face)).
- **Check both backgrounds.** Writers use dark and light editors; the model sheet shows both.

## For agents

1. Agree with the writer on the idea: a creature, a palette, a personality. Keep it small and simple.
2. Write the pack. Start from a bundled one (in the `mascots` folder next to this guide's folder) if it's close.
3. **Look at it.** Euterpe has `preview_mascot`, and anyone else can use **Euterpe: Preview Mascot**. The model sheet shows:
   - every view;
   - a dozen moods;
   - gestures caught mid-way;
   - walking, being dragged, squash and stretch;
   - all of it on a dark background and a light one.

   If the pack doesn't hold up, you get the list of problems instead, each with where it is. Fix them all, then look again.
4. Check that:
   - the face reads in every mood (eyes on plain body, not touching the edge);
   - the side view faces right;
   - the arms start at the body's edge and aren't too long;
   - the legs sit under the body;
   - the tints look right: love (pink), proud (gold) and sad (blue).
5. Euterpe offers it with `offer_mascot`. Otherwise, save it to the mascots folder and tell the writer to choose it.
