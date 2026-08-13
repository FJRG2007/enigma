# @enigmax/utils

Headless application utilities. No UI, no styles: the parts that are always rewritten by hand and always come out subtly wrong.

## Install

```sh
npm install @enigmax/utils
# or, to copy the source in and own it:
enigma add cache notifications --copy
```

## Cache

A short-TTL read cache whose point is the **in-flight deduplication**: two components mounting in the same tick ask for one key once, so a rate limit sees one request instead of five. The TTL then keeps the answer around long enough that a remount paints from cache instead of flashing a skeleton over data the app already has.

```ts
import { createCache } from "@enigmax/utils";

const cache = createCache({ namespace: "app", ttl: 30_000, storage: "session" });

const user = await cache.read(`user:${id}`, () => api.getUser(id));
cache.invalidate("user:*");   // after a write
```

React:

```tsx
import { useCached } from "@enigmax/utils/react";

const { data, loading, validating, refresh } = useCached(`user:${id}`, () => api.getUser(id));
```

`loading` is true only when there is nothing to render yet. `validating` is true while a value already on screen is being revalidated, which is the flag a spinner in the corner should use - not the one that blanks the view.

A rejection is never cached, and a full storage quota never takes the read path down with it.

## Notifications

Ordering, dedupe, eviction and timers. Rendering is yours.

```ts
import { createNotifications } from "@enigmax/utils";

const queue = createNotifications({ max: 4, duration: 5000 });
queue.notify({ key: "sync", title: "Retrying", tone: "warning" });
```

React:

```tsx
import { useNotifications } from "@enigmax/utils/react";

const { items, notify, dismiss, pause, resume } = useNotifications();
```

The behaviour that is worth not rewriting:

- A repeated `key` replaces in place, so a retry loop does not build a wall of identical messages.
- Errors stay until dismissed by default; everything else self-dismisses.
- Over `max`, the oldest **dismissable** notification makes room. A sticky error is never silently evicted.
- `pause()` holds the remaining time rather than running it, and a hidden tab pauses automatically - a timer that keeps counting while the tab is in the background fires the moment the visitor comes back, and they never see the message.

## Tests

```sh
npm test
```

Covers the dedupe, TTL expiry, uncached rejections, prefix invalidation, key replacement, sticky errors, eviction order and the held timer.
