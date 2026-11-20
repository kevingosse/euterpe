// Shared message shapes between the mind, the extension, and the overlay.
// The overlay (plain JS) mirrors EXPRESSIONS/ACTIONS in overlay/renderer/clawd/acting.js;
// keep the two lists in sync.

/** Where an edit Euterpe proposed stands (see proposals.ts). */
export type ProposalState = "pending" | "accepted" | "rejected" | "dismissed" | "stale" | "superseded" | "withdrawn";

/** What Euterpe replies with, every turn. */
export interface MindResponse {
    expression: Expression;
    say: string | null;
    notes: number;
    /** Optional one-shot gesture, played once on top of the expression. */
    action: Action | null;
}

/**
 * Moods. Each one is a face, a colour and its own idle motion on the avatar.
 * Energetic ones (laugh, excited, surprised, idea...) settle by themselves
 * after a few seconds — nobody laughs for ten minutes — and every mood but
 * sleepy relaxes into neutral half a minute after the mind last expressed it
 * (see overlay/renderer/clawd/director.js).
 */
export const EXPRESSIONS = [
    "neutral",    // calm, present
    "reading",    // reading along attentively, eyes following the lines
    "happy",      // pleased, warm
    "laugh",      // laughing out loud (settles to happy)
    "excited",    // thrilled, bouncing (settles to happy)
    "love",       // adoring — a sentence Euterpe loves (settles to happy)
    "proud",      // proud of the writer
    "smug",       // teasing, self-satisfied
    "mischief",   // plotting a tease
    "playful",    // cheeky, tongue out
    "wink",       // knowing wink
    "thinking",   // pondering, looking up
    "curious",    // interested, head tilt
    "idea",       // lightbulb moment (settles to happy)
    "confused",   // puzzled
    "surprised",  // taken aback (settles to curious)
    "concerned",  // worried
    "sad",        // sad, a little rain cloud
    "shy",        // bashful, blushing
    "sleepy",     // drowsy, zzz
    "bored",      // bored, sighing
    "determined", // let's do this
    "cool",       // sunglasses — nailed it
] as const;
export type Expression = (typeof EXPRESSIONS)[number];

/** One-shot gestures (about 1–3 s), played once, then back to the expression. */
export const ACTIONS = [
    "wave",      // hello / goodbye
    "nod",       // yes, agreed, noted
    "headshake", // no, not quite
    "jump",      // a joyful hop
    "bounce",    // a couple of happy little bounces
    "clap",      // applause
    "cheer",     // arms up, celebration
    "shrug",     // who knows / your call
    "facepalm",  // affectionate exasperation
    "peek",      // leans in to look closer at the text
    "stretch",   // a big stretch (long session)
    "yawn",      // a yawn
    "spin",      // a celebratory spin
    "dance",     // a little dance (finished a draft!)
    "startle",   // a jolt of surprise
] as const;
export type Action = (typeof ACTIONS)[number];

export function isExpression(x: unknown): x is Expression {
    return typeof x === "string" && (EXPRESSIONS as readonly string[]).includes(x);
}

export function isAction(x: unknown): x is Action {
    return typeof x === "string" && (ACTIONS as readonly string[]).includes(x);
}

/** Extension -> overlay */
export type ToOverlay =
    /** A mind turn completed. */
    | { type: "mind"; expression: Expression; say: string | null; notes: number; action: Action | null }
    /** A chat turn is in flight ("thinking") or done ("idle"). Perception turns never show thinking. */
    | { type: "status"; state: "thinking" | "idle" }
    /** Echo of what the writer said (overlay chat, "Talk to Euterpe" box, debug console), for the chat log. */
    | { type: "user-echo"; text: string }
    /** Raw writer activity, for body reflexes (gaze follows typing, waking from a doze). Throttled. */
    | { type: "activity"; typing: boolean }
    /** The mind failed a turn or restarted; shown in the chat log, avatar looks dizzy. */
    | { type: "error"; text: string }
    /** An edit Euterpe proposed opened for review (pending) or ended; the chat shows it with Accept/Reject. */
    | { type: "proposal"; id: string; file: string; state: ProposalState }
    /** A new body: a mascot pack (see mascots.ts), or null for Clawd. The old one walks off, the new one in. */
    | { type: "mascot"; id: string; pack: object | null }
    /** Session over: play the exit animation, then quit. The extension kills the process if it lingers. */
    | { type: "shutdown" };

/** Overlay -> extension */
export type FromOverlay =
    /** The writer typed a message. */
    | { type: "chat"; text: string }
    /** The writer clicked the notes badge: deliver the held notes. */
    | { type: "notes" }
    /** The writer asked to end the session from the overlay (context menu). */
    | { type: "close" }
    /** The writer clicked a button on a proposed edit in the chat. */
    | { type: "proposal"; id: string; decision: "accept" | "reject" | "show" };
