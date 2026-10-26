// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Project instructions per repository: the instruction file from the target branch, files of the user's clone, and extra text.
// Each run reads the sources again and gets them in its prompt. The preview reads them the same way, with no network.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  CLONE_INSTRUCTION_FILES,
  EXTRA_INSTRUCTIONS_MAX,
  type GlobalInstructionsDto,
  type InstructionPreviewDto,
  type InstructionRepoDto,
  type InstructionsInput,
} from "../../shared/dto";
import { api } from "../api";
import { fullTime } from "../pr/Thread";
import { sizeText } from "../review/tasks";
import { read } from "../shell/data";
import { SaveStatus, TYPING_MS, useSaver } from "./autosave";

const reposKey = ["instructions"] as const;
const globalKey = ["instructions", "global"] as const;
const previewKey = (r: Pick<InstructionRepoDto, "project" | "repo">) => ["instructions", r.project, r.repo, "preview"] as const;
const name = (r: Pick<InstructionRepoDto, "project" | "repo">) => `${r.project}/${r.repo}`;
// UI code holds no product name (tests/ui/names.test.ts), so the file names come from the shared list.
const MAIN = CLONE_INSTRUCTION_FILES[0];
const TARGET_FILES = `${CLONE_INSTRUCTION_FILES[0]} and ${CLONE_INSTRUCTION_FILES[2]}`;

export function ProjectInstructions() {
  const q = useQuery({ queryKey: reposKey, queryFn: async () => read<InstructionRepoDto[]>(await api.api.instructions.$get()) });
  const list = q.data ?? [];
  return (
    <section aria-labelledby="h-instructions" className="mt-6 grid max-w-[86ch] gap-3 border-t pt-4">
      <div className="grid gap-0.5">
        <h2 id="h-instructions" tabIndex={-1} className="m-0 scroll-mt-4 text-[15px] font-bold outline-none">
          Project instructions
        </h2>
        <p className="m-0 text-xs text-muted-foreground">
          Changes save as you make them. Text saves when you leave the field or stop typing.
        </p>
      </div>
      <p className="m-0 max-w-[72ch] text-sm text-ink-2">
        Each run reads these sources again and gets them in its prompt. They never change the safety rules: runs stay read-only and post
        nothing. {MAIN} files of the pull request head do not load as instructions.
      </p>
      <GlobalSwitch />
      {q.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : q.error ? (
        <p className="m-0 flex items-start gap-1.5 text-sm text-destructive">
          <CircleAlert aria-hidden className="mt-0.5 size-[15px] shrink-0" />
          Cannot read the project instructions. {q.error.message}
        </p>
      ) : list.length ? (
        <ul className="m-0 grid list-none rounded-md border p-0">
          {list.map((r) => (
            <RepoRow key={name(r)} r={r} />
          ))}
        </ul>
      ) : (
        <p className="m-0 text-sm text-muted-foreground">
          No repository yet. A repository shows here after the inbox loads one of its pull requests or a task uses it.
        </p>
      )}
    </section>
  );
}

// One switch for every repository. The app config stores it.
function GlobalSwitch() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: globalKey, queryFn: async () => read<GlobalInstructionsDto>(await api.api.instructions.global.$get()) });
  const [problem, setProblem] = useState<string | null>(null);
  const set = async (on: boolean) => {
    setProblem(null);
    try {
      qc.setQueryData(globalKey, await read<GlobalInstructionsDto>(await api.api.instructions.global.$put({ json: { on } })));
      // Every preview reads the global file.
      void qc.invalidateQueries({ queryKey: reposKey });
    } catch (e) {
      setProblem((e as Error).message);
    }
  };
  if (q.isPending) return <Skeleton className="h-10 w-full" />;
  if (q.error)
    return (
      <p className="m-0 flex items-start gap-1.5 text-sm text-destructive">
        <CircleAlert aria-hidden className="mt-0.5 size-[15px] shrink-0" />
        Cannot read the global switch. {q.error.message}
      </p>
    );
  return (
    <Field orientation="horizontal" data-instructions-global>
      <Switch id="instr-global" aria-describedby="instr-global-help" checked={q.data.on} onCheckedChange={(on) => void set(on)} />
      <div className="grid gap-px">
        <FieldLabel htmlFor="instr-global">Use your global {MAIN}</FieldLabel>
        <FieldDescription id="instr-global-help">
          For all repositories. Runs read{" "}
          <code translate="no" className="font-mono text-xs [overflow-wrap:anywhere]">
            {q.data.path}
          </code>{" "}
          and its imports before the other sources.
        </FieldDescription>
        {problem && (
          <p role="alert" className="m-0 flex items-start gap-1.5 text-xs text-destructive">
            <CircleAlert aria-hidden className="mt-px size-[13px] shrink-0" />
            Cannot save the switch. {problem}
          </p>
        )}
      </div>
    </Field>
  );
}

function RepoRow({ r }: { r: InstructionRepoDto }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [s, setS] = useState<InstructionsInput>(r.settings);
  const latest = useRef(s);
  const saved = useRef(r.settings);
  // A DOM ID from the repository key. Project keys and slugs hold no space.
  const id = `instr-${r.project}-${r.repo}`.replace(/[^A-Za-z0-9_-]/g, "_");
  const param = { project: r.project, repo: r.repo };
  const { state, saver } = useSaver(
    () => (JSON.stringify(latest.current) === JSON.stringify(saved.current) ? null : latest.current),
    async (input: InstructionsInput) => {
      saved.current = await read<InstructionsInput>(await api.api.repos[":project"][":repo"].instructions.$put({ param, json: input }));
      void qc.invalidateQueries({ queryKey: reposKey });
      void qc.invalidateQueries({ queryKey: previewKey(r) });
    },
  );
  const change = (patch: Partial<InstructionsInput>, delay = 0) => {
    latest.current = { ...latest.current, ...patch };
    setS(latest.current);
    saver.request(delay);
  };
  const preview = useQuery({
    queryKey: previewKey(r),
    enabled: open,
    queryFn: async () => read<InstructionPreviewDto>(await api.api.repos[":project"][":repo"].instructions.preview.$get({ param })),
  });
  const p = preview.data;
  // Ticked files that the clone does not have now.
  const missing = r.clone && p ? s.local.filter((f) => !p.found.includes(f)) : [];
  // The detected files, and ticked files that are gone.
  const shown = CLONE_INSTRUCTION_FILES.filter((f) => p?.found.includes(f) || s.local.includes(f));
  const summary = [
    p?.files.some((f) => f.source === "global") && "global file",
    s.target && "target branch",
    s.local.length > 0 && `${s.local.length} clone ${s.local.length > 1 ? "files" : "file"}`,
    s.extra.trim() && "your text",
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <li data-instructions={name(r)} className="border-b last:border-b-0">
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2">
          <span translate="no" className="font-mono text-sm font-semibold [overflow-wrap:anywhere]">
            {name(r)}
          </span>
          <span className="text-xs text-muted-foreground">{summary || "No instructions"}</span>
        </summary>
        <div className="grid gap-3 px-3 pb-3">
          <SaveStatus
            id={`${id}-status`}
            state={state}
            problem={null}
            saved="Saved. The next run uses it."
            onRetry={() => saver.request(0)}
          />
          <Field orientation="horizontal">
            <Switch
              id={`${id}-target`}
              aria-describedby={`${id}-target-help`}
              checked={s.target}
              onCheckedChange={(target) => change({ target })}
            />
            <div className="grid gap-px">
              <FieldLabel htmlFor={`${id}-target`}>Committed {MAIN} from the target branch</FieldLabel>
              <FieldDescription id={`${id}-target-help`}>
                The run reads {TARGET_FILES} at the target branch head, never from the pull request head.
              </FieldDescription>
            </div>
          </Field>
          <fieldset className="m-0 grid gap-1.5 border-0 p-0">
            <legend className="mb-1 text-sm font-medium">Local files from your clone</legend>
            {r.clone ? (
              <>
                <code translate="no" className="font-mono text-xs text-ink-2 [overflow-wrap:anywhere]">
                  {r.clone}
                </code>
                {!p ? (
                  <Skeleton className="h-5 w-48" />
                ) : shown.length ? (
                  shown.map((f) => (
                    <label key={f} className="flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="size-4 shrink-0 accent-primary"
                        checked={s.local.includes(f)}
                        onChange={(e) => change({ local: e.target.checked ? [...s.local, f] : s.local.filter((x) => x !== f) })}
                      />
                      <span translate="no" className="font-mono">
                        {f}
                      </span>
                    </label>
                  ))
                ) : (
                  <p className="m-0 text-sm text-muted-foreground">
                    The clone has none of these files: {CLONE_INSTRUCTION_FILES.join(", ")}.
                  </p>
                )}
                {missing.length > 0 && (
                  <p data-instructions-missing className="m-0 flex items-start gap-1.5 text-xs text-destructive">
                    <CircleAlert aria-hidden className="mt-px size-[13px] shrink-0" />
                    The clone does not have {missing.join(", ")}. Runs leave it out.
                  </p>
                )}
              </>
            ) : (
              <p className="m-0 text-sm text-muted-foreground">Set a clone path to use local files.</p>
            )}
          </fieldset>
          <Field>
            <FieldLabel htmlFor={`${id}-extra`}>Extra text (optional)</FieldLabel>
            <Textarea
              id={`${id}-extra`}
              rows={3}
              maxLength={EXTRA_INSTRUCTIONS_MAX}
              value={s.extra}
              onChange={(e) => change({ extra: e.target.value }, TYPING_MS)}
              onBlur={() => void saver.flush()}
            />
          </Field>
          <Preview p={p} error={preview.error} />
        </div>
      </details>
    </li>
  );
}

function Preview({ p, error }: { p: InstructionPreviewDto | undefined; error: Error | null }) {
  if (error)
    return (
      <p className="m-0 flex items-start gap-1.5 text-sm text-destructive">
        <CircleAlert aria-hidden className="mt-0.5 size-[15px] shrink-0" />
        Cannot read the preview. {error.message}
      </p>
    );
  if (!p) return <Skeleton className="h-10 w-full" />;
  return (
    <div data-instructions-preview className="grid gap-1.5">
      <p className="m-0 text-sm text-ink-2">
        A run gets{" "}
        {p.files.length
          ? `${sizeText(p.bytes)} from ${p.files.length} ${p.files.length > 1 ? "sources" : "source"}`
          : "no project instructions"}
        . <span className="text-muted-foreground">Read at {fullTime(p.readAt)}.</span>
      </p>
      {p.target === "no-cache" && (
        <p className="m-0 text-xs text-muted-foreground">The target branch {MAIN} shows after the first run fetches the repository.</p>
      )}
      {p.notLoaded.map((g) => (
        <p key={g} className="m-0 flex items-start gap-1.5 text-xs text-destructive">
          <CircleAlert aria-hidden className="mt-px size-[13px] shrink-0" />
          Not loaded: {g}
        </p>
      ))}
      {p.text && (
        <details>
          <summary className="cursor-pointer text-sm font-medium text-pen">Show the text</summary>
          <pre className="m-0 mt-1.5 max-h-80 overflow-auto rounded-md border bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
            {p.text}
          </pre>
        </details>
      )}
    </div>
  );
}
