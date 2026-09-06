import test from "node:test";
import assert from "node:assert/strict";
import * as player from "../dist/index.js";

/**
 * The video player's arithmetic.
 *
 * The cases are the ones a player gets wrong in front of people: a clock that changes width
 * mid-playback and shoves the controls along, a buffer bar that reports a range nobody is
 * watching, and a space bar that pauses the video while somebody is typing a comment.
 */

test("the clock is sized by the longest time it will have to show", () => {
    assert.equal(player.formatTime(0), "0:00");
    assert.equal(player.formatTime(9), "0:09");
    assert.equal(player.formatTime(75), "1:15");
    assert.equal(player.formatTime(3671), "1:01:11");
    // A video over an hour prints hours from the first second, or the label goes from 4
    // characters to 7 as it plays and every control after it moves.
    assert.equal(player.formatTime(9, 3700), "0:00:09");
    assert.equal(player.formatTime(600, 3700), "0:10:00");
});

test("a time nobody has yet is zero rather than NaN", () => {
    assert.equal(player.formatTime(Number.NaN), "0:00");
    assert.equal(player.formatTime(-5), "0:00");
    assert.equal(player.progress(10, Number.NaN), 0);
    assert.equal(player.progress(10, 0), 0);
    assert.equal(player.progress(5, 10), 0.5);
    assert.equal(player.progress(50, 10), 1);
});

test("a press on the rail is where it landed, and never outside it", () => {
    const box = { left: 100, width: 200 };
    assert.equal(player.fractionAt(box, 150), 0.25);
    assert.equal(player.fractionAt(box, 50), 0);
    assert.equal(player.fractionAt(box, 999), 1);
    assert.equal(player.fractionAt({ left: 0, width: 0 }, 10), 0);
});

test("the buffer shown is the range being watched, not the biggest one", () => {
    const ranges = {
        length: 2,
        start: (at) => [0, 60][at],
        end: (at) => [10, 120][at]
    };
    // Playing at 5s: what is loaded ahead is that range's end, not the 120s one further on.
    assert.equal(player.bufferedAhead(ranges, 5, 120), 10 / 120);
    assert.equal(player.bufferedAhead(ranges, 70, 120), 1);
    // Seeked into a hole: nothing around the playhead is loaded, and the bar says so.
    assert.equal(player.bufferedAhead(ranges, 30, 120), 0);
    assert.equal(player.bufferedAhead(null, 5, 120), 0);
});

test("the speed list steps and wraps", () => {
    assert.equal(player.nextSpeed(1), 1.25);
    assert.equal(player.nextSpeed(2), player.SPEEDS[0]);
    assert.equal(player.nextSpeed(1, -1), 0.75);
    // A rate nobody offered still steps from normal rather than answering undefined.
    assert.equal(player.nextSpeed(3.5), 1.25);
});

test("the shortcuts are the ones every player has", () => {
    assert.deepEqual(player.commandFor(" "), { type: "toggle" });
    assert.deepEqual(player.commandFor("k"), { type: "toggle" });
    assert.deepEqual(player.commandFor("ArrowRight"), { type: "seek", by: 5 });
    assert.deepEqual(player.commandFor("l"), { type: "seek", by: 10 });
    assert.deepEqual(player.commandFor("7"), { type: "seekTo", fraction: 0.7 });
    assert.deepEqual(player.commandFor("m"), { type: "mute" });
    assert.deepEqual(player.commandFor("f"), { type: "fullscreen" });
    assert.equal(player.commandFor("Tab"), null);
    assert.equal(player.commandFor("q"), null);
});

test("a key pressed inside a field belongs to the field", () => {
    assert.equal(player.isTypingTarget({ tagName: "INPUT" }), true);
    assert.equal(player.isTypingTarget({ tagName: "TEXTAREA" }), true);
    assert.equal(player.isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
    assert.equal(player.isTypingTarget({ tagName: "DIV" }), false);
    assert.equal(player.isTypingTarget(null), false);
});

/** A `textTracks` stand-in: array-like, with a mode that can be written the way the real one is. */
function trackList(...tracks) {
    const list = tracks.map((track) => ({ kind: "subtitles", label: "", language: "", mode: "disabled", ...track }));
    return Object.assign(list, { length: list.length });
}

test("the language list is the subtitles, not everything the element carries", () => {
    const list = trackList(
        { kind: "metadata", label: "Chapters" },
        { kind: "subtitles", label: "English", language: "en" },
        { kind: "captions", label: "", language: "es" }
    );
    const found = player.captionTracks(list);

    // Chapters draw nothing over the picture: offering them is a language row that does nothing.
    assert.deepEqual(found.map((track) => track.label), ["English", "es"]);
    // The index is the one in the ELEMENT's list, because that is what turns the track on.
    assert.deepEqual(found.map((track) => track.index), [1, 2]);
    assert.deepEqual(player.captionTracks(null), []);
});

test("what is showing is read off the element, not remembered", () => {
    // A `default` track is showing before anything was pressed. A player that assumed "off"
    // took two presses to turn it off.
    const list = trackList({ label: "English", mode: "showing" }, { label: "Spanish" });
    assert.equal(player.activeCaption(list), 0);
    assert.equal(player.activeCaption(trackList({ label: "English" })), -1);
    assert.equal(player.activeCaption(null), -1);
});

test("choosing a language turns the others off, and -1 turns them all off", () => {
    const list = trackList({ label: "English", mode: "showing" }, { label: "Spanish" });

    player.showCaption(list, 1);
    // "disabled" rather than "hidden": a hidden track still fires its cues, so a page
    // listening for its own transcript would keep receiving a language nobody asked for.
    assert.deepEqual(list.map((track) => track.mode), ["disabled", "showing"]);

    player.showCaption(list, -1);
    assert.deepEqual(list.map((track) => track.mode), ["disabled", "disabled"]);
});

test("casting is offered where the browser has it, and never where the page said no", () => {
    assert.equal(player.supportsRemote(null), false);
    assert.equal(player.supportsRemote({}), false);
    assert.equal(player.supportsRemote({ remote: { prompt() {} } }), true);
    // Safari's picker predates the standard and is still the only one it has on iOS.
    assert.equal(player.supportsRemote({ webkitShowPlaybackTargetPicker() {} }), true);
    // A page that asked for the control to be gone does not get one drawn over its video.
    assert.equal(player.supportsRemote({ remote: { prompt() {} }, disableRemotePlayback: true }), false);
});
