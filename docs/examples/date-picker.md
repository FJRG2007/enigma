# Date Picker

**Task:** "Add a date picker to this form."

## Without enigma

```bash
npm install flatpickr
```

```jsx
import flatpickr from "flatpickr";
import "flatpickr/dist/flatpickr.min.css";
import { useEffect, useRef } from "react";

export default function DatePicker({ value, onChange, minDate, maxDate }) {
  const inputRef = useRef(null);
  const instanceRef = useRef(null);

  useEffect(() => {
    instanceRef.current = flatpickr(inputRef.current, {
      defaultDate: value,
      minDate,
      maxDate,
      dateFormat: "Y-m-d",
      onChange: ([date]) => onChange(date),
    });
    return () => instanceRef.current?.destroy();
  }, []);

  useEffect(() => {
    instanceRef.current?.setDate(value, false);
  }, [value]);

  return <input ref={inputRef} className="date-picker" />;
}
```

One dependency, one wrapper component, two `useEffect` hooks, a cleanup function,
and a CSS import, to pick a date.

## With enigma

```html
<!-- enigma: browser has one -->
<input type="date">
```

**1 dependency + 30 lines -> 0 dependencies + 1 line.** Native, accessible,
localized, keyboard-navigable, mobile-friendly. Rung 3 of the ladder (native
platform feature) covers it, and accessibility - a "never simplify away" - comes
for free with the native element instead of being a wrapper's responsibility.
