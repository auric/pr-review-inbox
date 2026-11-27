// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Built-in checklists for the languages of a change. Only review runs of a profile with languageChecks get them.
import { posix } from "node:path";
import type { AgentSpec } from "./claude";
import type { DiffFile } from "./diffmap";

// Item form: "<category>: <sentences> [<usual severity>]". tests/review/languages.test.ts checks the form and the sentence length.
// skip: the common false positives of the language. docs/eval/results.md: a longer prompt cost recall, so each list stays short.
export const CHECKLISTS = {
  cpp: {
    title: "C++",
    items: [
      "lifetime: Check that no reference, pointer, iterator, string_view, span, or captured reference outlives its object. [major]",
      "ownership: Check that each resource has one owner that frees it on every path, also on early return or throw. [major]",
      "exceptions: Check that a throw leaves each object valid and frees what it took. Destructors, moves, and swap must not throw. [major]",
      "ub: Check for undefined behavior: out-of-bounds access, null dereference, signed overflow, uninitialized reads, bad casts, and aliasing breaks. [major]",
      "integers: Check signed and unsigned mixes, narrowing, size_t to int, and overflow in size or index math. A real input must reach it. [major]",
      "iterators: Check that no code uses an iterator, pointer, or reference into a container after an insert, erase, or reallocation. [major]",
      "move: Check that no code reads a moved-from object. A std::move that copies or blocks copy elision is minor. [major]",
      "copy: Check that a class that owns a resource defines or deletes copy and move. A shallow copy of an owner is a finding. [major]",
      "inheritance: Check for object slicing, and for a base without a virtual destructor that code deletes through a base pointer. [major]",
      "races: Check that each shared mutable object has one lock or atomic rule, and that every access follows it. [major]",
      "atomics: Check that each memory order weaker than seq_cst has a release and acquire pair on the same object. [major]",
      "locks: Check the lock order across mutexes, callbacks under a lock, and condition waits without a predicate loop. [major]",
      "threads: Check that each thread joins on every path. No object may end while another thread still uses it. [major]",
      "abi: When a header or an exported type changes, Grep its users. A layout, signature, or default change that breaks them is a finding. [major]",
      "templates: Check templates with the types that callers pass: a wrong overload by ADL, a silent conversion, or a missing constraint. [minor]",
      "const: Report a missing const only when code can change shared state through it, or a const caller breaks. [minor]",
      "windows: Check each handle against the correct failure value, INVALID_HANDLE_VALUE or NULL, and CloseHandle on every path. Read GetLastError at once after the failed call. [major]",
      "windows-types: On Windows, long is 32 bits. Check truncation of size_t and pointers to DWORD, LONG, or int. Free memory in the module that allocated it. [major]",
    ],
    skip: [
      "a raw pointer or reference that owns nothing, as a request for a smart pointer",
      "a pass by value of a cheap type, such as string_view, span, or an int",
      "a missing noexcept, override, or [[nodiscard]] that changes no behavior",
    ],
  },
  c: {
    title: "C",
    items: [
      "memory: Check that each allocation has one free on every path, also on error paths. Check for use after free and double free. [major]",
      "bounds: Check each index and copy length against the buffer size. Check for off-by-one errors and for a VLA with a size from outside input. [major]",
      "strings: Check strcpy, strcat, sprintf, and gets for overflow. Check that each string has its terminator. strncpy adds none when the source is too long. Use snprintf or another bounded function, and check the result for truncation. [major]",
      "integers: Check size math before malloc for overflow. Check signed and unsigned mixes, and integer promotion that changes a result. [major]",
      "pointers: Check for a missing null check after an allocation. Check for aliasing breaks and casts that drop const or volatile. [major]",
      "errors: Check that the code tests each return value that can show a failure. Read errno at once after the failed call. [major]",
      "races: Check that each shared mutable object has one lock or atomic rule, and that every access follows it. A signal handler may call only async-signal-safe functions. [major]",
      "format: Check for outside input that the code passes as the format string of printf or a similar function. [blocker]",
      "macros: Check that a macro puts parentheses around each argument and around its body. Check for an argument with side effects that the macro uses twice. [major]",
    ],
    skip: ["a goto to a cleanup label on an error path", "a cast of the malloc result, or a missing cast"],
  },
  python: {
    title: "Python",
    items: [
      "defaults: Check for a mutable default argument that a call changes. The state then leaks between calls. [major]",
      "exceptions: Check for a bare except or a broad except that hides an error and goes on with a wrong result. [major]",
      "finally: Check for a return, break, or continue in a finally block. It drops the active exception. [major]",
      "resources: Check that each file, socket, lock, and connection closes on every path. Expect a with block or try and finally. [minor]",
      "typing: Check that annotations match the runtime values, for example a missing None check for an Optional. Missing hints are not findings. [minor]",
      "async-blocking: Check for a blocking call in a coroutine: time.sleep, requests, or file, database, or subprocess work without await. [major]",
      "async-tasks: Check for a coroutine that nobody awaits, a task with no kept reference, and state that changes across an await. [major]",
      "closures: Check for a lambda or an inner function in a loop that reads the loop variable later. Each one sees the last value. [major]",
      "iteration: Check for a change to a list, dict, or set during iteration over it. Check for an iterator that code reads twice. [major]",
      "threads: Check shared state across threads. The GIL does not make a read-modify-write step atomic. [major]",
      "imports: Check that an import does no I/O, network call, or global state change, and that it adds no import cycle. [minor]",
      "packaging: Check that each new import has a declared dependency. Check version bounds and moved modules that can break users. [major]",
      "injection: Check subprocess calls with shell=True or one command string, and os.system, with outside input. Pass a list of arguments. [blocker]",
      "deserialization: Check pickle, marshal, shelve, and yaml.load without SafeLoader on data from outside the process. [blocker]",
      "sql: Check SQL text that f-strings, format, %, or + build from variables. Outside input in that text is a finding. Use query parameters. [blocker]",
      "unsafe-calls: Check eval and exec on outside input, file paths from user input without a check, tempfile.mktemp, and verify=False. [major]",
      "truth: Check for is used for value equality. Check truth tests where 0, an empty string, or an empty list is valid. [minor]",
    ],
    skip: [
      "an f-string or % format in a log call",
      "a broad except in a top-level handler that logs the error and stops or retries",
      "a missing type hint or docstring",
    ],
  },
  csharp: {
    title: "C#",
    items: [
      "async-void: Check for async void outside event handlers. No caller can await it, and its exception ends the process. [major]",
      "blocking: Check for .Result, .Wait(), or GetAwaiter().GetResult() on a task. With a synchronization context, the call can deadlock. [major]",
      "tasks: Check for a task that nobody awaits or observes. Its exception gets lost, and its work can outlive the caller. [major]",
      "cancellation: Check that each received CancellationToken goes to the async calls below it. A dropped token stops cancel and timeout. [minor]",
      "configure-await: Where library code uses ConfigureAwait(false), check that each new await in it does the same. [minor]",
      "dispose: Check that each IDisposable that the code creates and owns gets a using or a Dispose call on every path. [major]",
      "nulls: Check for a possible null at a dereference, also after the null-forgiving operator. The ! hides the warning, not the null. [major]",
      "linq: Check for an IEnumerable that code enumerates twice. Check for a deferred query that runs after its source or captured state changes. [major]",
      "exceptions: Check for a catch that hides an error and goes on with a wrong result. Check for throw ex, which drops the stack trace. [major]",
      "races: Check that each shared mutable field, also a static one, has one lock or atomic rule. Every access must follow it. [major]",
      "equality: Check that a type that overrides Equals also overrides GetHashCode on the same fields. Check for a mutable hash key. [major]",
      "strings: Check compare, sort, ToUpper, and ToLower for culture. Keys, identifiers, and protocol text need StringComparison.Ordinal or the invariant culture. [major]",
      "time: Check for DateTime.Now in stored, sent, or compared times. Use DateTime.UtcNow or DateTimeOffset, and check DateTimeKind on parse. [major]",
      "structs: Check for a change to a copy of a mutable struct: a property, a readonly field, or a foreach variable. [major]",
      "queries: Check IQueryable and EF Core code for a query in a loop (N+1). Check for client evaluation over a large table. [major]",
      "events: Check that each += on a long-lived publisher has a -= when the subscriber ends. Else the handler keeps the subscriber alive. [major]",
      "unity: In Unity code, check for ?., ??, or is null on a UnityEngine.Object. They skip the destroyed-object check of ==. [major]",
    ],
    skip: [
      "var or an explicit type, and an expression body or a block body",
      "a missing ConfigureAwait(false) in application code, or in a library that does not use it",
      "a missing sealed, readonly, or static modifier that changes no behavior",
    ],
  },
} as const;

export type Language = keyof typeof CHECKLISTS;
export const LANGUAGES = Object.keys(CHECKLISTS) as Language[];

// GCC "Options Controlling the Kind of Output" names .c, .h, and the C++ suffixes. .ipp, .inl, .tpp: included template code.
// .ixx: MSVC module units. .cppm: Clang module units. A .h file gets the C++ list. A change with .c files also gets the C list.
// .csx: C# scripts. Razor and cshtml markup files get no list.
const EXT: Record<string, Language> = {
  ".c": "c",
  ...Object.fromEntries(
    [".cpp", ".cc", ".cp", ".cxx", ".c++", ".h", ".hh", ".hp", ".hpp", ".hxx", ".h++", ".tcc", ".ipp", ".inl", ".tpp", ".ixx", ".cppm"].map(
      (e) => [e, "cpp"],
    ),
  ),
  ".py": "python",
  ".pyi": "python",
  ".pyw": "python",
  ".cs": "csharp",
  ".csx": "csharp",
};

// The languages of the text files in the diff, in LANGUAGES order. A deleted file counts by its old path.
export function languagesOf(files: DiffFile[]): Language[] {
  const found = new Set<Language | undefined>(
    files.filter((f) => !f.binary).map((f) => EXT[posix.extname(f.path ?? f.oldPath ?? "").toLowerCase()]),
  );
  return LANGUAGES.filter((l) => found.has(l));
}

export const LANGUAGE_INTRO = [
  "The change has files in the languages below. Check the changed code against each list.",
  "Use a point only where the code uses that feature. Use the word before the colon as the category.",
  "The level in brackets is the usual level. Lower it for a rare trigger or a small impact.",
];

export const SKIP_COMMON =
  "In each language, do not report linter or analyzer warnings, formatting, generated files, or speed-ups without a shown hot path.";

export function languageLines(langs: Language[]): string[] {
  if (!langs.length) return [];
  return [
    ...LANGUAGE_INTRO,
    ...langs.flatMap((l) => [
      `${CHECKLISTS[l].title} list:`,
      ...CHECKLISTS[l].items.map((i) => `- ${i}`),
      `Do not report in ${CHECKLISTS[l].title}:`,
      ...CHECKLISTS[l].skip.map((i) => `- ${i}`),
    ]),
    SKIP_COMMON,
  ];
}

// Adds the checklists to the prompt of an agent.
export const withLanguages = (a: AgentSpec, langs: Language[]): AgentSpec =>
  langs.length ? { ...a, prompt: [a.prompt, ...languageLines(langs)].join("\n") } : a;
