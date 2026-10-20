import type { TimelineElement } from "../store/playerStore";
import {
  resolveTimelineMinDuration,
  resolveTimelinePlaybackRate,
  type TimelineGroupResizeChange,
  type TimelineGroupResizeMember,
  type TimelineGroupResizeSession,
} from "./timelineGroupEditing";
import { TRACK_GAP_EPSILON_S } from "./timelineGaps";
import { trimPreviewTime } from "./timelineClipDragPreview";

/**
 * Slip and roll, the two NLE edits that keep a sequence's length:
 *
 * - SLIP slides a clip's source under its fixed window: start and duration stay, the media
 *   in-point (`playbackStart`) moves. Dragging right reveals earlier source, as the picture
 *   follows the pointer.
 * - ROLL moves the edit point between two touching clips on one track: the left clip ends later
 *   and the right one starts later by the same amount, its in-point advancing to match, so
 *   nothing after the pair moves.
 *
 * Both resolve to the group-resize session the trim gesture already previews and commits, so a
 * slip or roll is one optimistic update, one persisted batch and one undo entry.
 */

const keyOf = (element: TimelineElement) => element.key ?? element.id;

// Saved times are centiseconds; media offsets keep milliseconds.
const roundTime = (value: number) => Math.round(value * 100) / 100;
const roundMedia = (value: number) => Math.round(value * 1000) / 1000;

/** Clips whose content comes from a source that can slide under them. */
function hasSlidingSource(element: TimelineElement): boolean {
  return element.kind === "video" || element.kind === "audio" || element.kind === "composition";
}

export function canSlip(element: TimelineElement): boolean {
  return hasSlidingSource(element) && !element.timelineLocked;
}

function member(element: TimelineElement): TimelineGroupResizeMember {
  return {
    element,
    key: keyOf(element),
    start: element.start,
    duration: element.duration,
    playbackStart: element.playbackStart,
    playbackRate: element.playbackRate,
  };
}

function session(
  label: string,
  grabbed: TimelineElement,
  members: TimelineElement[],
  changes: TimelineGroupResizeChange[],
): TimelineGroupResizeSession {
  return {
    label,
    grabbedKey: keyOf(grabbed),
    edge: "end",
    members: members.map(member),
    changes,
    hasChanged: changes.some((change, index) => {
      const before = members[index];
      return (
        before !== undefined &&
        (change.start !== before.start ||
          change.duration !== before.duration ||
          change.playbackStart !== before.playbackStart)
      );
    }),
  };
}

/** The timeline seconds a clip can slip by: left until its source ends, right until it starts. */
function slipDeltaBounds(element: TimelineElement): { min: number; max: number } {
  const rate = resolveTimelinePlaybackRate(element.playbackRate);
  const inPoint = element.playbackStart ?? 0;
  // Dragging right by d lowers the in-point by d × rate, down to the start of the source.
  const max = inPoint / rate;
  if (element.sourceDuration === undefined) return { min: Number.NEGATIVE_INFINITY, max };
  const lastInPoint = Math.max(inPoint, element.sourceDuration - element.duration * rate);
  return { min: -(lastInPoint - inPoint) / rate, max };
}

/** Linked partners (a video and its audio) slip together so they stay in sync. */
export function slipMembers(
  element: TimelineElement,
  elements: readonly TimelineElement[],
): TimelineElement[] {
  if (!element.link) return [element];
  const partners = elements.filter(
    (other) => other !== element && other.link === element.link && canSlip(other),
  );
  return [element, ...partners];
}

/** A slip of `members` by `delta` timeline seconds, clamped so every source stays in range. */
export function resolveSlip(
  grabbed: TimelineElement,
  members: TimelineElement[],
  delta: number,
): TimelineGroupResizeSession {
  const bounds = members.map(slipDeltaBounds);
  const min = Math.max(...bounds.map((b) => b.min));
  const max = Math.min(...bounds.map((b) => b.max));
  const clamped = Math.min(max, Math.max(min, delta));
  const changes = members.map((element) => {
    const rate = resolveTimelinePlaybackRate(element.playbackRate);
    const inPoint = element.playbackStart ?? 0;
    return {
      element,
      key: keyOf(element),
      start: element.start,
      duration: element.duration,
      playbackStart: Math.max(0, roundMedia(inPoint - clamped * rate)),
    };
  });
  return session(members.length > 1 ? "Slip linked clips" : "Slip clip", grabbed, members, changes);
}

/**
 * The clip a roll on `edge` of `element` moves with: the one on the same track that touches it
 * there. Linked clips have none, since rolling one half of a linked pair would pull it out of
 * sync with the other.
 */
export function findRollPartner(
  element: TimelineElement,
  edge: "start" | "end",
  elements: readonly TimelineElement[],
): TimelineElement | null {
  if (element.link || element.timelineLocked) return null;
  const at = edge === "end" ? element.start + element.duration : element.start;
  const partner = elements.find((other) => {
    if (other === element || other.track !== element.track) return false;
    const touch = edge === "end" ? other.start : other.start + other.duration;
    return Math.abs(touch - at) < TRACK_GAP_EPSILON_S;
  });
  return partner && !partner.link && !partner.timelineLocked ? partner : null;
}

/** How far the edit point between `left` and `right` can move, in timeline seconds. */
export function rollDeltaBounds(
  left: TimelineElement,
  right: TimelineElement,
): { min: number; max: number } {
  const minDuration = resolveTimelineMinDuration();
  let min = -(left.duration - minDuration);
  let max = right.duration - minDuration;
  if (hasSlidingSource(right)) {
    // The right clip's in-point moves back with the edit point; the source starts at 0.
    const rate = resolveTimelinePlaybackRate(right.playbackRate);
    min = Math.max(min, -(right.playbackStart ?? 0) / rate);
  }
  if (hasSlidingSource(left) && left.sourceDuration !== undefined) {
    const rate = resolveTimelinePlaybackRate(left.playbackRate);
    const remaining = (left.sourceDuration - (left.playbackStart ?? 0)) / rate - left.duration;
    max = Math.min(max, Math.max(0, remaining));
  }
  return { min: Math.min(0, min), max: Math.max(0, max) };
}

/** A roll of the edit point between touching `left` and `right` by `delta` timeline seconds. */
export function resolveRoll(
  grabbed: TimelineElement,
  left: TimelineElement,
  right: TimelineElement,
  delta: number,
): TimelineGroupResizeSession {
  const { min, max } = rollDeltaBounds(left, right);
  const edit = roundTime(left.start + left.duration + Math.min(max, Math.max(min, delta)));
  const moved = edit - right.start;
  const rightRate = resolveTimelinePlaybackRate(right.playbackRate);
  const changes: TimelineGroupResizeChange[] = [
    {
      element: left,
      key: keyOf(left),
      start: left.start,
      duration: roundTime(edit - left.start),
      playbackStart: left.playbackStart,
      // A roll never moves the left clip's in-point, so it is not written at all.
      persistPlaybackStart: false,
    },
    {
      element: right,
      key: keyOf(right),
      start: edit,
      duration: roundTime(right.start + right.duration - edit),
      playbackStart: hasSlidingSource(right)
        ? Math.max(0, roundMedia((right.playbackStart ?? 0) + moved * rightRate))
        : right.playbackStart,
      // Saved as the file's own in-point moved by the start shift.
      persistPlaybackStart: false,
    },
  ];
  return session("Roll edit", grabbed, [left, right], changes);
}

/** The left and right clip of a roll grabbed on `edge` of `element`. */
function rollPair(
  element: TimelineElement,
  edge: "start" | "end",
  partner: TimelineElement,
): { left: TimelineElement; right: TimelineElement } {
  return edge === "end" ? { left: element, right: partner } : { left: partner, right: element };
}

/** What a slip or roll gesture shows for one pointer position: the session and the grabbed clip. */
export interface SlipRollPreview {
  session: TimelineGroupResizeSession;
  originScrollLeft: number;
  previewStart: number;
  previewDuration: number;
  previewPlaybackStart?: number;
  snapTime: null;
  snapType: null;
  groupPreview: TimelineGroupResizeChange[];
}

/**
 * Resolve a slip or roll for the pointer at `clientX`, scroll-compensated like a trim. Null when
 * the gesture has nothing to act on (a roll whose partner is gone).
 */
export function previewSlipRoll(
  resize: {
    mode: "slip" | "roll";
    element: TimelineElement;
    edge: "start" | "end";
    originClientX: number;
    originScrollLeft?: number;
    rollPartnerKey?: string;
  },
  clientX: number,
  context: { scrollLeft: number; pps: number; elements: readonly TimelineElement[] },
): SlipRollPreview | null {
  const originScrollLeft = resize.originScrollLeft ?? context.scrollLeft;
  const delta =
    (clientX - resize.originClientX + context.scrollLeft - originScrollLeft) /
    Math.max(context.pps, 1e-6);
  let result: TimelineGroupResizeSession;
  if (resize.mode === "slip") {
    result = resolveSlip(resize.element, slipMembers(resize.element, context.elements), delta);
  } else {
    const partner = context.elements.find((el) => keyOf(el) === resize.rollPartnerKey);
    if (!partner) return null;
    const { left, right } = rollPair(resize.element, resize.edge, partner);
    result = resolveRoll(resize.element, left, right, delta);
  }
  const grabbed = result.changes.find((change) => change.key === keyOf(resize.element));
  return {
    session: result,
    originScrollLeft,
    previewStart: grabbed?.start ?? resize.element.start,
    previewDuration: grabbed?.duration ?? resize.element.duration,
    previewPlaybackStart: grabbed?.playbackStart,
    snapTime: null,
    snapType: null,
    groupPreview: result.changes,
  };
}

/**
 * Run one pointer position of a slip or roll gesture: hold the session the commit will save,
 * show a roll's cut in the preview (a slip's new frame exists only once saved), and publish the
 * clip preview. Nothing is published when the gesture has nothing to act on.
 */
export function applySlipRollPointer(
  resize: Parameters<typeof previewSlipRoll>[0],
  clientX: number,
  context: { scroll: HTMLElement | null; pps: number; elements: readonly TimelineElement[] },
  effects: {
    setSession: (session: TimelineGroupResizeSession | null) => void;
    showFrame: (time: number) => void;
    publish: (preview: SlipRollPreview) => void;
  },
): void {
  const preview = previewSlipRoll(resize, clientX, {
    scrollLeft: context.scroll?.scrollLeft ?? 0,
    pps: context.pps,
    elements: context.elements,
  });
  effects.setSession(preview?.session ?? null);
  if (!preview) return;
  if (resize.mode === "roll") {
    effects.showFrame(trimPreviewTime(resize.edge, preview.previewStart, preview.previewDuration));
  }
  effects.publish(preview);
}
