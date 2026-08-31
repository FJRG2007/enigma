/**
 * Write a value the way a keystroke would.
 *
 * Assigning `input.value` directly is invisible to React: it tracks the last value it
 * rendered and skips the change event when the DOM disagrees with it. Going through the
 * prototype's setter and dispatching a bubbling `input` event makes a generated password or
 * a cleared search behave exactly like typing - which is what makes it work with a
 * controlled field, an uncontrolled one, and a form library, without knowing which it is in.
 *
 * Its own module because both the field and the per-type chunks write values, and a helper
 * imported from the field would tie a chunk back to the module that lazily loads it.
 */
export function writeValue(input: HTMLInputElement, next: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, next);
    else input.value = next;
    input.dispatchEvent(new Event("input", { bubbles: true }));
}
