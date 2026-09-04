import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SearchPalette } from "@/react/palette";
import { SelectionList } from "@/react/selection";
// The Next entry, with next/link aliased to a stub at bundle time.
import { Button as NextButton } from "@/next/index";
import { Select, type SelectItem } from "@/react/select";
// The React Router entry, with react-router aliased to a stub at bundle time.
import { Button as RouterButton } from "@/react-router/index";
import { ContextMenu, type ContextMenuNode } from "@/react/context-menu";
import { Button, Input, setLinkComponent, type BreachState, type PasswordStrengthReport } from "@/react/index";

/**
 * The React fixture: a registration form of the kind `<Input>` is for, wired the way a real
 * one is - a CONTROLLED field, a form that counts its own submissions, and a breach checker
 * that answers from a list instead of the network.
 */

interface FixtureWindow extends Window {
    __ready: boolean;
    __presses: number;
    __release: () => void;
    __unsetLink: () => void;
    __clickTarget: string;
    __submits: number;
    __value: string;
    __color: string;
    __strength: PasswordStrengthReport | null;
    __breach: BreachState | null;
    __breachCalls: string[];
    __selected: string;
    __country: string;
    __guard: string;
    __stack: string[];
    __renders: number;
    __rows: number;
    __chosen: string[];
    __commands: string[];
    __picked: string[];
    __menuLoads: number;
}

const fixture = window as unknown as FixtureWindow;
fixture.__submits = 0;
fixture.__value = "";
fixture.__color = "";
fixture.__strength = null;
fixture.__breach = null;
fixture.__breachCalls = [];
fixture.__selected = "";
fixture.__country = "";
fixture.__guard = "";
fixture.__stack = [];
fixture.__presses = 0;
fixture.__clickTarget = "";
fixture.__rows = 0;
fixture.__chosen = [];
fixture.__commands = [];
fixture.__picked = [];
fixture.__menuLoads = 0;

/**
 * Stands in for next/link: a component that renders an anchor and marks itself, so a test
 * can tell a registered router link from the plain fallback.
 */
function FakeLink({ href, children, ...rest }: { href?: string; children?: React.ReactNode; }) {
    return <a href={href} data-router-link="" {...rest}>{children}</a>;
}
setLinkComponent(FakeLink);

/** A tiny corpus with two groups, so the palette's grouping is exercised for real. */
const DOCS = [
    { title: "Marquee", section: "Components", href: "/marquee" },
    { title: "Input", section: "Components", href: "/input" },
    { title: "Flags", section: "Components", href: "/flags" },
    { title: "Installation", section: "Guides", href: "/install" }
];

/**
 * Nine options with a group, an icon, a description and one that cannot be chosen - every
 * shape the select has to draw, in the list the tests read.
 */
const COUNTRIES: SelectItem[] = [
    { value: "es", label: "Spain", group: "Europe", icon: <i data-flag="es" /> },
    { value: "fr", label: "France", group: "Europe" },
    { value: "de", label: "Germany", group: "Europe", disabled: true },
    { value: "pt", label: "Portugal", group: "Europe" },
    { value: "it", label: "Italy", group: "Europe" },
    { value: "us", label: "United States", group: "Americas", description: "USA" },
    { value: "mx", label: "Mexico", group: "Americas" },
    { value: "br", label: "Brazil", group: "Americas" },
    { value: "ar", label: "Argentina", group: "Americas" }
];

/**
 * Two hundred rows with an icon each - the case that made the panel slow to open, and the
 * one the list's window exists for.
 */
const MANY: SelectItem[] = Array.from({ length: 200 }, (_, index) => ({
    value: `row-${index}`,
    label: `Row ${index}`,
    icon: <i data-icon={index} />
}));

/** Ten files, the list the selection tests click through. */
const ROWS = Array.from({ length: 10 }, (_, index) => ({ id: `f${index}`, name: `File ${index}` }));

/**
 * What a row carries back to `onSelect`: here a node that points at its own parent, which is
 * what a real caller hands over when the row acts on something it found in the DOM.
 */
const CYCLIC: { name: string; self?: unknown; } = { name: "report.pdf" };
CYCLIC.self = CYCLIC;

/**
 * A menu with every shape in it: a shortcut, a second line, a disabled row, furniture, a
 * destructive row, a submenu known up front and one that has to be fetched.
 */
const MENU: ContextMenuNode[] = [
    { id: "open", label: "Open", shortcut: "Enter", icon: <i data-icon="open" />, data: CYCLIC },
    { id: "rename", label: "Rename", shortcut: "F2", description: "Give it another name" },
    { id: "locked", label: "Move", disabled: true },
    { type: "separator" },
    { id: "share", label: "Share", items: [
        { id: "link", label: "Copy link", shortcut: "Mod+C" },
        { id: "email", label: "Email" }
    ] },
    { id: "tags", label: "Tags", loadItems: async () => {
        fixture.__menuLoads++;
        // Slow enough that the loading state is a state and not a frame: the point of the
        // test is that a branch which takes a moment SAYS so rather than looking empty.
        await new Promise((resolve) => setTimeout(resolve, 250));
        return [{ id: "red", label: "Red" }, { id: "blue", label: "Blue" }];
    } },
    { type: "separator" },
    { id: "delete", label: "Delete", shortcut: "Delete", destructive: true }
];

/** One row of the caller's own, to prove the clipboard rows arrive ON TOP of them. */
const EDIT_MENU: ContextMenuNode[] = [{ id: "custom", label: "Do something" }];

/** Answers instantly and locally, so the test measures the component and not a network. */
const BREACHED = new Set(["password", "hunter2"]);

function checkBreach(password: string, { signal }: { signal: AbortSignal; }): Promise<{ breached: boolean; count: number; }> {
    fixture.__breachCalls.push(password);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            resolve(BREACHED.has(password) ? { breached: true, count: 3730471 } : { breached: false, count: 0 });
        }, 20);
        signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
        });
    });
}

let renders = 0;

function Form(): React.ReactNode {
    // Every render of this tree, so a component that renders itself in a loop is a number
    // that keeps climbing rather than a page that merely feels slow.
    fixture.__renders = ++renders;
    const [password, setPassword] = useState("");
    const [country, setCountry] = useState("");
    const [guard, setGuard] = useState("");
    const [colour, setColour] = useState("#3b82f6");
    fixture.__color = colour;
    const [stack, setStack] = useState<string[]>([]);
    fixture.__country = country;
    fixture.__guard = guard;
    fixture.__stack = stack;
    const [, redraw] = useState(0);
    fixture.__value = password;

    // Dropping the registration has to be followed by a render: the component reads the
    // registered link while rendering, so nothing on screen changes on its own.
    fixture.__unsetLink = () => {
        setLinkComponent(null);
        redraw((count) => count + 1);
    };

    return (
        <form
            data-testid="form"
            onSubmit={(event) => {
                event.preventDefault();
                fixture.__submits++;
            }}
        >
            <Input
                data-testid="password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                generate={{ length: 24 }}
                strength={{ userInputs: ["ada@example.com"] }}
                breach={checkBreach}
                breachDelay={30}
                onStrengthChange={(report) => { fixture.__strength = report; }}
                onBreachChange={(state) => { fixture.__breach = state; }}
            />
            <button data-testid="submit" type="submit">Create account</button>

            {/* The short form: no hook, no spreading, no six lines per call site. */}
            <Button data-testid="save" onPress={() => { fixture.__presses++; }}>Save</Button>

            {/* onClick is the same thing under the name React already uses. */}
            <Button
                data-testid="save-click"
                cooldown={2000}
                onClick={(event) => { fixture.__presses++; fixture.__clickTarget = (event?.target as HTMLElement)?.tagName ?? ""; }}
            >Save</Button>

            {/* Async work, a cooldown after it, and a label that follows the state. */}
            <Button
                data-testid="send"
                cooldown={3000}
                pending="Sending..."
                onPress={() => new Promise<void>((resolve) => { fixture.__release = resolve; })}
            >
                {({ cooldown }) => (cooldown > 0 ? `Wait ${Math.ceil(cooldown / 1000)}s` : "Send")}
            </Button>

            {/* No `as`: the href alone picks up the link registered above. */}
            <Button data-testid="link" href="/settings">Settings</Button>

            {/* The Next entry: an href is next/link, with nothing at the call site. */}
            <NextButton data-testid="next-link" href="/settings">Settings</NextButton>
            <NextButton data-testid="next-button" onPress={() => { fixture.__presses++; }}>Save</NextButton>

            {/* The React Router entry: same href, translated to its `to`. */}
            <RouterButton data-testid="rr-link" href="/settings">Settings</RouterButton>

            {/* A shortcut on a labelled button shows its key; on an icon-only one it does not. */}
            <Button data-testid="hinted" shortcut="s" onPress={() => { fixture.__presses++; }}>Save</Button>
            <Button data-testid="icon-only" shortcut="i" aria-label="Save" onPress={() => { fixture.__presses++; }}>
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 4h16v16H4z" /></svg>
            </Button>

            {/* A search field: the same component, driven by its type. */}
            <Input
                data-testid="finder"
                type="search"
                placeholder="Search"
                items={DOCS}
                keys={["title"]}
                delay={0}
                renderResults={(matches, query) => (
                    <ul data-testid="finder-results" data-query={query}>
                        {matches.map((match) => <li key={match.item.title}>{match.item.title}</li>)}
                    </ul>
                )}
            />

            {/* A colour field: a text input holding the canonical string, a swatch that opens
                the picker, and the alpha rail turned on so the value carries eight digits. */}
            <div data-testid="colour">
                <Input
                    data-testid="colour-field"
                    type="color"
                    alpha
                    swatches={["#ef4444", "#22c55e", "#3b82f6"]}
                    value={colour}
                    onChange={(event) => setColour(event.target.value)}
                />
            </div>

            {/* One value, no filter: the keyboard and the typeahead are the whole interface. */}
            <div data-testid="country">
                <Select
                    options={COUNTRIES}
                    searchable={false}
                    clearable
                    value={country}
                    onValueChange={setCountry}
                    placeholder="Country"
                    name="country"
                />
            </div>

            {/* Many values: tags, a filter turned on by the option count, and a form name. */}
            <div data-testid="stack">
                <Select
                    multiple
                    options={COUNTRIES}
                    value={stack}
                    onValueChange={setStack}
                    placeholder="Anywhere"
                    name="markets"
                />
            </div>

            {/* Long list: what reaches the document is a window, not two hundred rows. */}
            <div data-testid="many">
                <Select options={MANY} placeholder="Pick a row" />
            </div>

            {/* Options built in the render, which is how they are usually written: a new
                array of new objects every time, and the component must not chase it. */}
            <div data-testid="inline">
                <Select
                    options={COUNTRIES.map((option) => ({ ...option }))}
                    placeholder="Inline"
                    searchable={false}
                />
            </div>

            {/* The filter's own props written inline: `searchKeys={[...]}` and
                `fuseOptions={{...}}` are a new object every render too. */}
            <div data-testid="filters">
                <Select
                    options={COUNTRIES}
                    searchable
                    searchKeys={["label"]}
                    fuseOptions={{ threshold: 0.3 }}
                    placeholder="Filtered"
                    // Counted rather than the whole tree's renders: a select that renders
                    // itself in a loop never reaches the component ABOVE it, so the number
                    // that has to stand still is one taken from inside the panel.
                    renderOption={(option) => { fixture.__rows++; return option.label; }}
                />
            </div>

            {/* Controlled, and the parent REFUSES one of the values: what it holds is what
                the select shows, which is the whole contract of a controlled component. */}
            <div data-testid="guarded">
                <Select
                    options={COUNTRIES}
                    searchable={false}
                    value={guard}
                    onValueChange={(next) => { if (next !== "fr") setGuard(next); }}
                    placeholder="Guarded"
                />
            </div>

            {/* Nothing to choose from: the trigger says so and never opens a panel holding
                one line of apology. */}
            <div data-testid="empty-select">
                <Select options={[]} placeholder="Country" />
            </div>

            {/* Still loading, which is a different thing from having nothing. */}
            <div data-testid="loading-select">
                <Select options={[]} loading placeholder="Country" />
            </div>

            {/* The right-click menu, over an area with a size to right-click on. */}
            <div data-testid="menu-area">
                <ContextMenu
                    title="report.pdf"
                    items={MENU}
                    onSelect={(item, path) => { fixture.__chosen.push(path.join("/")); }}
                    triggerProps={{ style: { width: 240, height: 120 } }}
                >
                    Right-click here
                </ContextMenu>
            </div>

            {/* The clipboard rows: a menu over something editable gets Copy, Cut and Paste
                on top of whatever the caller passed, and  gets none. */}
            <div data-testid="editor-area">
                <ContextMenu items={EDIT_MENU} onSelect={(item) => { fixture.__chosen.push(item.id); }}>
                    <textarea data-testid="notes" defaultValue="hello world" />
                </ContextMenu>
            </div>

            <div data-testid="plain-area">
                <ContextMenu items={EDIT_MENU} clipboard={false}>
                    <textarea data-testid="plain-notes" defaultValue="hello world" />
                </ContextMenu>
            </div>

            {/* A password never reaches the clipboard, and a read-only field takes nothing. */}
            <div data-testid="secret-area">
                <ContextMenu items={EDIT_MENU}>
                    {/* enigma:allow-raw-password-input - bare on purpose. What is under test
                        is that the clipboard rows refuse to copy a masked value, and <Input>
                        would bring a reveal toggle that has nothing to do with it. */}
                    <input data-testid="secret" type="password" defaultValue="hunter2" />
                </ContextMenu>
            </div>

            <div data-testid="frozen-area">
                <ContextMenu items={EDIT_MENU}>
                    <input data-testid="frozen" readOnly defaultValue="frozen text" />
                </ContextMenu>
            </div>

            {/* Not editable at all: a paragraph offers Copy over a selection and nothing else. */}
            <div data-testid="prose-area">
                <ContextMenu items={EDIT_MENU}>
                    <p data-testid="prose">Selectable prose</p>
                </ContextMenu>
            </div>

            {/* A menu with nothing in it: the press falls through to the browser's own. */}
            <div data-testid="empty-menu-area">
                <ContextMenu items={[]} triggerProps={{ style: { width: 120, height: 60 } }}>Nothing here</ContextMenu>
            </div>

            {/* The selection list, with one row that cannot be picked and rename rebound.
                The rows are narrower than the list on purpose: a rubber band starts on EMPTY
                space, and rows that fill the width leave none to start it on. */}
            <div data-testid="files">
                <style>{`
                    [data-testid="files"] [data-enigma-selection-list] { width: 320px; }
                    [data-testid="files"] [data-enigma-selection-item] { width: 160px; height: 20px; }
                `}</style>
                <SelectionList
                    items={ROWS}
                    getId={(row) => row.id}
                    disabled={(row) => row.id === "f3"}
                    shortcuts={{ rename: "F3", copy: false }}
                    onSelectionChange={(ids) => { fixture.__picked = ids; }}
                    onCommand={(event) => { fixture.__commands.push(event.command); }}
                >
                    {({ item }) => <span>{item.name}</span>}
                </SelectionList>
            </div>

            <SearchPalette
                items={DOCS}
                keys={["title"]}
                delay={0}
                labelOf={(doc) => doc.title}
                groupBy={(doc) => doc.section}
                recentsKey="test:palette"
                onSelect={(doc) => { fixture.__selected = doc.href; }}
            />
        </form>
    );
}

createRoot(document.getElementById("root")!).render(<Form />);
// One frame after the mount, so a test never reads a half-rendered tree.
requestAnimationFrame(() => { fixture.__ready = true; });
