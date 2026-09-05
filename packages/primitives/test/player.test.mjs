import test from "node:test";
import assert from "node:assert/strict";
import { formatTime, progress, fractionAt, bufferedAhead, nextSpeed, commandFor, isTypingTarget, SPEEDS } from "../dist/index.js";

/**
 * The video player's arithmetic.
 *
 * The cases are the ones a player gets wrong in front of people: a clock that changes width
 * mid-playback and shoves the controls along, a buffer bar that reports a range nobody is
 * watching, and a space bar that pauses the video while somebody is typing a comment.
 */

test("the clock is sized by the longest time it will have to show", () => {
    assert.equal(formatTime(0), "0:00");
    assert.equal(formatTime(9), "0:09");
    assert.equal(formatTime(75), "1:15");
    assert.equal(formatTime(3671), "1:01:11");
    // A video over an hour prints hours from the first second, or the label goes from 4
    // characters to 7 as it plays and every control after it moves.
    assert.equal(formatTime(9, 3700), "0:00:09");
    assert.equal(formatTime(600, 3700), "0:10:00");
});

test("a time nobody has yet is zero rather than NaN", () => {
    assert.equal(formatTime(Number.NaN), "0:00");
    assert.equal(formatTime(-5), "0:00");
    assert.equal(progress(10, Number.NaN), 0);
    assert.equal(progress(10, 0), 0);
    assert.equal(progress(5, 10), 0.5);
    assert.equal(progress(50, 10), 1);
});

test("a press on the rail is where it landed, and never outside it", () => {
    const box = { left: 100, width: 200 };
    assert.equal(fractionAt(box, 150), 0.25);
    assert.equal(fractionAt(box, 50), 0);
    assert.equal(fractionAt(box, 999), 1);
    assert.equal(fractionAt({ left: 0, width: 0 }, 10), 0);
});

test("the buffer shown is the range being watched, not the biggest one", () => {
    const ranges = {
        length: 2,
        start: (at) => [0, 60][at],
        end: (at) => [10, 120][at]
    };
    // Playing at 5s: what is loaded ahead is that range's end, not the 120s one further on.
    assert.equal(bufferedAhead(ranges, 5, 120), 10 / 120);
    assert.equal(bufferedAhead(ranges, 70, 120), 1);
    // Seeked into a hole: nothing around the playhead is loaded, and the bar says so.
    assert.equal(bufferedAhead(ranges, 30, 120), 0);
    assert.equal(bufferedAhead(null, 5, 120), 0);
});

test("the speed list steps and wraps", () => {
    assert.equal(nextSpeed(1), 1.25);
    assert.equal(nextSpeed(2), SPEEDS[0]);
    assert.equal(nextSpeed(1, -1), 0.75);
    // A rate nobody offered still steps from normal rather than answering undefined.
    assert.equal(nextSpeed(3.5), 1.25);
});

test("the shortcuts are the ones every player has", () => {
    assert.deepEqual(commandFor(" "), { type: "toggle" });
    assert.deepEqual(commandFor("k"), { type: "toggle" });
    assert.deepEqual(commandFor("ArrowRight"), { type: "seek", by: 5 });
    assert.deepEqual(commandFor("l"), { type: "seek", by: 10 });
    assert.deepEqual(commandFor("7"), { type: "seekTo", fraction: 0.7 });
    assert.deepEqual(commandFor("m"), { type: "mute" });
    assert.deepEqual(commandFor("f"), { type: "fullscreen" });
    assert.equal(commandFor("Tab"), null);
    assert.equal(commandFor("q"), null);
});

test("a key pressed inside a field belongs to the field", () => {
    assert.equal(isTypingTarget({ tagName: "INPUT" }), true);
    assert.equal(isTypingTarget({ tagName: "TEXTAREA" }), true);
    assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
    assert.equal(isTypingTarget({ tagName: "DIV" }), false);
    assert.equal(isTypingTarget(null), false);
});
