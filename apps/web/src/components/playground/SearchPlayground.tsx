import Fuse from "fuse.js";
import { useEffect, useState } from "react";
import { useSearch } from "@enigmax/primitives/react";
import { Playground, type Control } from "./Playground";

/**
 * The search playground. The engine is chosen at construction - it indexes the list once
 * rather than on every keystroke - so switching Fuse on or off remounts the field, and the
 * query is held here and replayed so nothing is lost when it does.
 */

interface Doc {
    title: string;
    kind: string;
}

const DOCS: Doc[] = [
    { title: "Convention guardrails", kind: "concept" },
    { title: "Quality gate", kind: "concept" },
    { title: "Code graph", kind: "concept" },
    { title: "Session recall", kind: "concept" },
    { title: "Autoskills", kind: "concept" },
    { title: "Verified completion", kind: "concept" },
    { title: "enigma add", kind: "command" },
    { title: "enigma compress", kind: "command" },
    { title: "enigma dashboard", kind: "command" },
    { title: "Draggable marquee", kind: "component" },
    { title: "Password breach check", kind: "component" }
];

interface Values extends Record<string, string | boolean> {
    fuse: boolean;
    debounce: string;
    minLength: string;
    limit: string;
}

const CONTROLS: Control<Values>[] = [
    { name: "fuse", label: "Fuse.js", type: "boolean", hint: "fuzzy, tolerates typos" },
    {
        name: "debounce", label: "Debounce", type: "select",
        options: [{ value: "0", label: "none" }, { value: "120", label: "120ms" }, { value: "400", label: "400ms" }]
    },
    {
        name: "minLength", label: "Min length", type: "select",
        options: [{ value: "0", label: "0" }, { value: "2", label: "2" }, { value: "3", label: "3" }]
    },
    {
        name: "limit", label: "Limit", type: "select",
        options: [{ value: "0", label: "none" }, { value: "3", label: "3" }, { value: "5", label: "5" }]
    }
];

const INITIAL: Values = { fuse: true, debounce: "120", minLength: "0", limit: "5" };

function code(values: Values): string {
    const options = ["items: docs", 'keys: ["title", "kind"]'];
    if (values.fuse) options.push("fuse: Fuse");
    if (values.debounce !== "120") options.push(`debounce: ${values.debounce}`);
    if (values.minLength !== "0") options.push(`minLength: ${values.minLength}`);
    if (values.limit !== "0") options.push(`limit: ${values.limit}`);

    const imports = values.fuse
        ? 'import Fuse from "fuse.js";\nimport { useSearch } from "@enigmax/primitives/react";'
        : 'import { useSearch } from "@enigmax/primitives/react";';

    return [
        imports,
        "",
        `const { inputRef, results } = useSearch({\n${options.map((option) => `    ${option}`).join(",\n")}\n});`,
        "",
        '<input ref={inputRef} type="search" placeholder="Search" />'
    ].join("\n");
}

function Field({ values, query, onQuery }: { values: Values; query: string; onQuery: (next: string) => void; }) {
    const { results, search, searchNow } = useSearch<Doc>({
        items: DOCS,
        keys: ["title", "kind"],
        fuse: values.fuse ? (Fuse as never) : undefined,
        debounce: Number(values.debounce),
        minLength: Number(values.minLength),
        limit: values.limit === "0" ? undefined : Number(values.limit)
    });

    // Replayed on mount: a control change remounts this to rebuild the engine, and the
    // reader should not have to retype what they were looking at.
    useEffect(() => {
        if (query) searchNow(query);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div className="pg-search">
            <input
                type="search"
                className="pg-text pg-search-in"
                placeholder='Try a typo: "guardrials"'
                value={query}
                onChange={(event) => { onQuery(event.target.value); search(event.target.value); }}
            />
            <ul className="pg-results">
                {results.map((match) => (
                    <li key={match.item.title}>
                        <span>{match.item.title}</span>
                        <span className="pg-kind">{match.item.kind}</span>
                        <span className="pg-score">{match.score.toFixed(2)}</span>
                    </li>
                ))}
                {!results.length && <li className="pg-none">{query ? "Nothing matches." : "Type to search."}</li>}
            </ul>
        </div>
    );
}

export function SearchPlayground() {
    const [query, setQuery] = useState("guardrials");

    return (
        <Playground<Values>
            controls={CONTROLS}
            initial={INITIAL}
            code={code}
            render={(values) => (
                <Field
                    // The engine indexes on construction, so any option that shapes it
                    // needs a fresh instance rather than a mutated one.
                    key={`${values.fuse}-${values.debounce}-${values.minLength}-${values.limit}`}
                    values={values}
                    query={query}
                    onQuery={setQuery}
                />
            )}
        />
    );
}
