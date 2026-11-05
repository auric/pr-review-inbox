// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { ArrowLeft, type LucideIcon, Monitor, Moon, Sun, X } from "lucide-react";
import { type FormEvent, type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { CHECK_CHOICES, type PrRow, type SettingsDto } from "../../shared/dto";
import type { SettingsSection } from "../lib/route";
import { useForge, useMeta } from "../meta";
import { notifyPermission } from "../notify";
import { trackerOf } from "../review/tasks";
import { useSaveSettings } from "../shell/data";
import { Hint } from "../shell/Hint";
import { setTheme, type Theme, useTheme } from "../theme";
import { About } from "./About";
import { BranchPrefixes } from "./BranchPrefixes";
import { Clones } from "./Clones";
import { JiraSettings } from "./JiraSettings";
import { ProjectInstructions } from "./ProjectInstructions";
import { ReviewProfiles } from "./ReviewProfiles";
import { ReviewQuality } from "./ReviewQuality";
import { TaskCommands } from "./TaskCommands";
import { TaskRules } from "./TaskRules";

// The section links focus these headings, so each heading takes focus from script only.
const sectionTitle = "m-0 scroll-mt-4 text-[15px] font-bold outline-none";
const saveNote = "m-0 text-xs text-muted-foreground";
const AT_ONCE = "Changes save at once.";

// A section link focuses its heading. The shell pushes the section URL (plan pr-view-v4 section 5).
// A keyboard activation has detail 0. It scrolls at once, as keyboard actions do not animate.
function jump(e: MouseEvent<HTMLAnchorElement>, id: string) {
  e.preventDefault();
  const el = document.getElementById(id);
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el?.scrollIntoView({ block: "start", behavior: still || e.detail === 0 ? "auto" : "smooth" });
  el?.focus({ preventScroll: true });
}

// A modified click opens the section URL in a new tab or window.
const plainClick = (e: MouseEvent) => e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;

// The section that the URL names, and the heading of each section.
export type SettingsAt = { section: SettingsSection | null; profile: string | null; n: number };
const HEADINGS: Record<SettingsSection, string> = {
  connection: "h-connection",
  checks: "checks-title",
  notifications: "notify-title",
  posts: "mark-title",
  appearance: "h-appearance",
  profiles: "h-profiles",
  quality: "h-quality",
  "task-ids": "h-taskids",
  tracker: "h-tracker",
  tasks: "h-tasks",
  commands: "h-commands",
  clones: "h-clones",
  instructions: "h-instructions",
};

// A heading above this part of the pane height is in view. The line stays near the top, so a short section such as Checks also gets its turn.
const SPY_LINE = 0.1;
const USER_SCROLL = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

// The section in view: the last heading above the spy line, or the last section at the end of the pane.
// A link click sets its section at once. Pane changes then wait for the next user input, so a smooth scroll does not flicker.
function useSectionSpy(ids: string[]) {
  const pane = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const nav = useRef<HTMLUListElement>(null);
  const held = useRef(false);
  const [active, setActive] = useState<string | null>(null);
  const key = ids.join(" ");
  useEffect(() => {
    const root = pane.current;
    const tail = end.current;
    const list = key ? key.split(" ") : [];
    if (!root || !tail || !list.length) return;
    let atEnd = false;
    const pick = () => {
      if (held.current) return;
      if (atEnd && root.scrollTop > 0) return setActive(list[list.length - 1] ?? null);
      const line = root.getBoundingClientRect().top + root.clientHeight * SPY_LINE;
      let id = list[0] ?? null;
      for (const x of list) {
        const top = document.getElementById(x)?.getBoundingClientRect().top;
        if (top !== undefined && top <= line) id = x;
      }
      setActive(id);
    };
    // The root margin keeps the band above the spy line, so a heading that crosses the line calls pick.
    const heads = new IntersectionObserver(pick, { root, rootMargin: `0px 0px -${(1 - SPY_LINE) * 100}% 0px` });
    const bottom = new IntersectionObserver(
      ([e]) => {
        atEnd = !!e?.isIntersecting;
        pick();
      },
      { root },
    );
    for (const x of list) {
      const el = document.getElementById(x);
      if (el) heads.observe(el);
    }
    bottom.observe(tail);
    const release = () => {
      held.current = false;
    };
    for (const t of USER_SCROLL) root.addEventListener(t, release, { passive: true, capture: true });
    return () => {
      heads.disconnect();
      bottom.disconnect();
      for (const t of USER_SCROLL) root.removeEventListener(t, release, { capture: true });
    };
  }, [key]);
  const current = active ?? ids[0] ?? null;
  // The narrow nav scrolls sideways. The active link stays in view, also after the pane gets narrow.
  useEffect(() => {
    const ul = nav.current;
    const a = current && ul?.querySelector<HTMLElement>(`a[data-sec="${current}"]`);
    if (!ul || !a) return;
    const show = () => {
      const left = a.offsetLeft - 16;
      const right = a.offsetLeft + a.offsetWidth + 16 - ul.clientWidth;
      if (ul.scrollLeft > left) ul.scrollLeft = left;
      else if (ul.scrollLeft < right) ul.scrollLeft = right;
    };
    show();
    const resize = new ResizeObserver(show);
    resize.observe(ul);
    return () => resize.disconnect();
  }, [current]);
  const hold = useCallback((id: string) => {
    held.current = true;
    setActive(id);
  }, []);
  return { pane, end, nav, active: current, hold };
}

const checkText = (s: number) => (s < 60 ? `Every ${s} seconds` : s === 60 ? "Every minute" : `Every ${s / 60} minutes`);

export function Settings({
  settings,
  required,
  prs,
  selected,
  at,
  onSection,
  onBack,
  onSaved,
}: {
  settings: SettingsDto;
  required: boolean;
  // The task-rule preview runs on one of these.
  prs: PrRow[];
  selected: number | null;
  // The section or the profile to show, for example after "Edit profile…" or Back. n changes on each request.
  at: SettingsAt;
  // A section link was used. The shell puts the section into the URL.
  onSection: (section: SettingsSection) => void;
  onBack: () => void;
  onSaved: () => void;
}) {
  const save = useSaveSettings();
  const forge = useForge();
  const meta = useMeta().data;
  const tracker = meta ? trackerOf(meta) : null;
  // The token lives only in this field until submit. It is never read back from the server.
  const [token, setToken] = useState("");
  const memory = settings.tokenStorage === "memory";
  const missing = settings.baseUrl !== null && !settings.tokenStored;
  // The sections below Connection show only after the first connection.
  const sections: [SettingsSection, string][] =
    settings.baseUrl === null
      ? []
      : [
          ["connection", "Connection"],
          ["checks", "Checks"],
          ["notifications", "Notifications"],
          ["posts", "Posts"],
          ["appearance", "Appearance"],
          ["profiles", "Review profiles"],
          ["quality", "Review quality"],
          ["task-ids", "Task IDs"],
          ...(tracker ? ([["tracker", tracker.name]] as [SettingsSection, string][]) : []),
          ["tasks", "Tasks"],
          ["commands", "Commands"],
          ["clones", "Clones"],
          ["instructions", "Project instructions"],
        ];
  const spy = useSectionSpy(sections.map(([s]) => HEADINGS[s]));
  const { hold, pane } = spy;
  // ReviewProfiles scrolls to the profile on each new target, so the target changes only with at.
  const target = useMemo(() => (at.profile ? { id: at.profile, n: at.n } : null), [at.profile, at.n]);
  // The URL names a section: its heading takes the focus. No section: the pane starts at the top.
  useEffect(() => {
    if (at.profile) return;
    const id = at.section ? HEADINGS[at.section] : null;
    const el = id ? document.getElementById(id) : null;
    if (!id || !el) {
      pane.current?.scrollTo({ top: 0 });
      return;
    }
    hold(id);
    el.scrollIntoView({ block: "start" });
    el.focus({ preventScroll: true });
  }, [at, hold, pane]);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    save.mutate(
      { baseUrl: String(f.get("baseUrl") ?? ""), token, caFile: String(f.get("caFile") ?? "") },
      {
        onSuccess: () => {
          setToken("");
          onSaved();
        },
      },
    );
  }

  return (
    <>
      <header className="grid gap-1.5 border-b px-6 pt-3 pb-3.5 max-[759px]:px-4">
        <div className="flex min-h-7 items-center gap-2">
          {!required && (
            <button
              type="button"
              className="rl-m-only -ml-1.5 h-7 cursor-pointer items-center gap-1 rounded-md pr-2 pl-1 text-sm font-medium text-ink-2 hover:bg-hover"
              onClick={onBack}
            >
              <ArrowLeft aria-hidden className="size-[15px]" />
              Back to the list
            </button>
          )}
          {!required && (
            <Hint label="Close. Key: Esc">
              <button
                type="button"
                className="ml-auto inline-grid size-[30px] cursor-pointer place-items-center rounded-md text-ink-2 hover:bg-hover hover:text-foreground"
                aria-label="Close the settings"
                onClick={onBack}
              >
                <X aria-hidden className="size-[15px]" />
              </button>
            </Hint>
          )}
        </div>
        <h1 className="m-0 text-(length:--fs-title) leading-tight font-bold tracking-[-0.015em]">Settings</h1>
        {sections.length > 0 && (
          <nav aria-label="Settings sections" className="min-w-0">
            {/* The pill names the section in view, also by its shape. A narrow pane scrolls the links sideways. Its padding keeps the focus ring unclipped. */}
            <ul
              ref={spy.nav}
              className="relative -mx-2 flex list-none flex-wrap gap-x-1 gap-y-1 p-0 text-sm max-[759px]:-mx-3 max-[759px]:flex-nowrap max-[759px]:overflow-x-auto max-[759px]:p-1 max-[759px]:[scrollbar-width:thin]"
            >
              {sections.map(([section, label]) => {
                const id = HEADINGS[section];
                const on = spy.active === id;
                return (
                  <li key={id} className="shrink-0">
                    <a
                      href={`/settings/${section}`}
                      data-sec={id}
                      aria-current={on || undefined}
                      className={cn(
                        "block rounded-md px-2 py-0.5 font-medium whitespace-nowrap transition-colors duration-150",
                        on ? "bg-sel text-foreground" : "text-pen hover:bg-hover",
                      )}
                      onClick={(e) => {
                        if (!plainClick(e)) return;
                        hold(id);
                        jump(e, id);
                        onSection(section);
                      }}
                    >
                      {label}
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}
      </header>
      <div ref={spy.pane} className="@container relative flex-1 overflow-auto px-6 pt-[18px] pb-16 max-[759px]:px-4">
        <section aria-labelledby="h-connection" className="grid max-w-[560px] gap-3">
          <div className="grid gap-0.5">
            <h2 id="h-connection" tabIndex={-1} className={sectionTitle}>
              Connection
            </h2>
            <p className={saveNote}>
              Press Save to keep the changes. Save tests the connection to the server first, so it does not save by itself.
            </p>
          </div>
          <form className="grid gap-4" onSubmit={submit} key={settings.baseUrl ?? ""}>
            {settings.baseUrl === null && (
              <p className="m-0">Connect PR Review Inbox to your {forge} server. It checks your pull requests every minute.</p>
            )}
            {missing && <p className="m-0">The service restarted, and the token was in memory only. Enter the token again.</p>}
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor="set-url">{forge} URL</FieldLabel>
                <Input
                  id="set-url"
                  name="baseUrl"
                  type="url"
                  required
                  defaultValue={settings.baseUrl ?? ""}
                  placeholder="https://forge.example.com"
                  autoComplete="url"
                  spellCheck={false}
                />
                <FieldDescription>The base URL only. Include the context path if your server has one.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="set-token">Access token</FieldLabel>
                <Input
                  id="set-token"
                  name="token"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={settings.tokenStored ? "Stored. Leave empty to keep it." : "Personal access token…"}
                />
                <FieldDescription>
                  {memory
                    ? "Token kept in memory only. Enter it again after a restart."
                    : "Token kept in the system credential store on this machine."}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="set-ca">CA file (optional)</FieldLabel>
                <Input
                  id="set-ca"
                  name="caFile"
                  type="text"
                  className="font-mono"
                  autoComplete="off"
                  spellCheck={false}
                  defaultValue={settings.caFile ?? ""}
                  placeholder="C:\certs\company-ca.pem"
                />
                <FieldDescription>A PEM file for a server certificate from a private CA.</FieldDescription>
              </Field>
              {save.error && !(save.error instanceof TypeError) && <FieldError>{save.error.message}</FieldError>}
              {settings.user && (
                <p className="m-0 text-sm text-muted-foreground">
                  Signed in as{" "}
                  <span translate="no" className="font-mono">
                    {settings.user}
                  </span>
                  .
                </p>
              )}
            </FieldGroup>
            <div className="flex items-center gap-2">
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? "Checking…" : "Save"}
              </Button>
              {!required && (
                <Button type="button" variant="outline" onClick={onBack}>
                  Cancel
                </Button>
              )}
            </div>
          </form>
        </section>
        {settings.baseUrl !== null && <Checks settings={settings} />}
        {settings.baseUrl !== null && <Notifications settings={settings} />}
        {settings.baseUrl !== null && <AiMark settings={settings} />}
        {settings.baseUrl !== null && <Appearance />}
        {settings.baseUrl !== null && <ReviewProfiles settings={settings} target={target} />}
        {settings.baseUrl !== null && <ReviewQuality />}
        {settings.baseUrl !== null && <TaskRules settings={settings} prs={prs} selected={selected} />}
        {settings.baseUrl !== null && <JiraSettings settings={settings} />}
        {settings.baseUrl !== null && <BranchPrefixes settings={settings} />}
        {settings.baseUrl !== null && <TaskCommands />}
        {settings.baseUrl !== null && <Clones settings={settings} />}
        {settings.baseUrl !== null && <ProjectInstructions />}
        <About />
        <div ref={spy.end} aria-hidden className="h-px" />
      </div>
    </>
  );
}

function Checks({ settings }: { settings: SettingsDto }) {
  const save = useSaveSettings();
  const forge = useForge();
  // The select stays enabled, so the arrow keys can step through the choices. Each step saves.
  const value = (save.isPending && save.variables?.checkSeconds) || settings.checkSeconds;
  return (
    <section aria-labelledby="checks-title" className="mt-6 grid max-w-[560px] gap-2 border-t pt-4">
      <div className="grid gap-0.5">
        <h2 id="checks-title" tabIndex={-1} className={sectionTitle}>
          Checks
        </h2>
        <p className={saveNote}>{AT_ONCE}</p>
      </div>
      <Field>
        <FieldLabel htmlFor="check-every">Check for new activity</FieldLabel>
        <select
          id="check-every"
          aria-describedby="check-every-help"
          className="h-8 rounded-lg border border-input bg-pane px-2 text-sm text-foreground"
          value={value}
          onChange={(e) =>
            save.mutate({ baseUrl: settings.baseUrl ?? "", caFile: settings.caFile ?? "", checkSeconds: Number(e.target.value) })
          }
        >
          {CHECK_CHOICES.map((s) => (
            <option key={s} value={s}>
              {checkText(s)}
            </option>
          ))}
        </select>
        <FieldDescription id="check-every-help">
          PR Review Inbox asks {forge} for changes at this interval. A new interval starts after the next check.
        </FieldDescription>
      </Field>
      {save.error && !(save.error instanceof TypeError) && <FieldError>{save.error.message}</FieldError>}
    </section>
  );
}

const PERMISSION_NOTE: Partial<Record<ReturnType<typeof notifyPermission>, string>> = {
  denied:
    "This browser blocks notifications for PR Review Inbox. Allow them in the site settings. The inbox badges still show new activity.",
  unsupported: "This browser does not support notifications. The inbox badges still show new activity.",
};

function Notifications({ settings }: { settings: SettingsDto }) {
  const save = useSaveSettings();
  const [permission, setPermission] = useState(notifyPermission);
  const on = settings.notifications && permission === "granted";

  async function toggle() {
    let next = !on;
    if (next && permission !== "granted") {
      const p = permission === "default" ? await Notification.requestPermission() : permission;
      setPermission(p);
      next = p === "granted";
    }
    // Only the notifications flag changes, so the server saves without a forge request.
    if (next !== settings.notifications)
      save.mutate({ baseUrl: settings.baseUrl ?? "", caFile: settings.caFile ?? "", notifications: next });
  }

  const note = PERMISSION_NOTE[permission];
  return (
    <section aria-labelledby="notify-title" className="mt-6 grid max-w-[560px] gap-2 border-t pt-4">
      <div className="grid gap-0.5">
        <h2 id="notify-title" tabIndex={-1} className={sectionTitle}>
          Notifications
        </h2>
        <p className={saveNote}>{AT_ONCE}</p>
      </div>
      <label className="flex cursor-pointer items-center gap-2.5">
        <input
          type="checkbox"
          className="size-4 accent-primary"
          checked={on}
          disabled={save.isPending || permission === "unsupported"}
          onChange={() => void toggle()}
        />
        Show a desktop notification for new activity
      </label>
      <p className="m-0 text-sm text-muted-foreground">One notification per pull request. Several open tabs never repeat it.</p>
      {note && <p className="m-0 text-sm text-ink-2">{note}</p>}
      {save.error && !(save.error instanceof TypeError) && <FieldError>{save.error.message}</FieldError>}
    </section>
  );
}

function AiMark({ settings }: { settings: SettingsDto }) {
  const save = useSaveSettings();
  const runner = useMeta().data?.runner.short ?? "";
  return (
    <section aria-labelledby="mark-title" className="mt-6 grid max-w-[560px] gap-2 border-t pt-4">
      <div className="grid gap-0.5">
        <h2 id="mark-title" tabIndex={-1} className={sectionTitle}>
          Posts
        </h2>
        <p className={saveNote}>{AT_ONCE}</p>
      </div>
      <Field orientation="horizontal">
        <Switch
          id="mark-ai"
          aria-describedby="mark-ai-help"
          checked={settings.markAi}
          disabled={save.isPending}
          onCheckedChange={(markAi) => save.mutate({ baseUrl: settings.baseUrl ?? "", caFile: settings.caFile ?? "", markAi })}
        />
        <FieldContent>
          <FieldLabel htmlFor="mark-ai">Mark {runner}-drafted comments with 🤖</FieldLabel>
          <FieldDescription id="mark-ai-help">
            Comments and replies that {runner} drafted start with 🤖. Your own replies never do.
          </FieldDescription>
        </FieldContent>
      </Field>
      <Field orientation="horizontal">
        <Switch
          id="mark-severity"
          aria-describedby="mark-severity-help"
          checked={settings.markSeverity}
          disabled={save.isPending}
          onCheckedChange={(markSeverity) => save.mutate({ baseUrl: settings.baseUrl ?? "", caFile: settings.caFile ?? "", markSeverity })}
        />
        <FieldContent>
          <FieldLabel htmlFor="mark-severity">Add the severity to posted findings</FieldLabel>
          <FieldDescription id="mark-severity-help">
            Each finding starts with its severity in bold, such as <strong>Nit:</strong> at the start. Questions and replies get no
            severity.
          </FieldDescription>
        </FieldContent>
      </Field>
      {save.error && !(save.error instanceof TypeError) && <FieldError>{save.error.message}</FieldError>}
    </section>
  );
}

const THEMES: [Theme, string, LucideIcon][] = [
  ["system", "System", Monitor],
  ["light", "Light", Sun],
  ["dark", "Dark", Moon],
];

// theme.ts keeps the choice in this browser only. The theme button of the sidebar cycles the same value.
function Appearance() {
  const theme = useTheme();
  return (
    <section aria-labelledby="h-appearance" className="mt-6 grid max-w-[560px] gap-2 border-t pt-4">
      <div className="grid gap-0.5">
        <h2 id="h-appearance" tabIndex={-1} className={sectionTitle}>
          Appearance
        </h2>
        <p className={saveNote}>Changes save at once, in this browser only.</p>
      </div>
      <FieldSet className="gap-1.5">
        <FieldLegend variant="label">Theme</FieldLegend>
        <div className="flex w-fit flex-wrap gap-0.5 rounded-lg border bg-pane-2 p-0.5">
          {THEMES.map(([t, label, Icon]) => (
            <label
              key={t}
              className="flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-sm text-ink-2 hover:text-foreground has-checked:bg-pane has-checked:font-semibold has-checked:text-foreground has-checked:shadow-[inset_0_0_0_1px_var(--border)] has-focus-visible:outline-2 has-focus-visible:outline-ring"
            >
              <input type="radio" name="theme" value={t} className="sr-only" checked={theme === t} onChange={() => setTheme(t)} />
              <Icon aria-hidden className="size-[15px] shrink-0" />
              {label}
            </label>
          ))}
        </div>
        <FieldDescription>System follows the color scheme of your computer.</FieldDescription>
      </FieldSet>
    </section>
  );
}
