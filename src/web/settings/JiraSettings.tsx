// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Issue tracker settings (plan r2, task context UI): the base URL, the Cloud account email, the token, and the CA file.
// The server checks the token with the tracker before it saves. PR Review Inbox calls the tracker only on this save and on a Fetch click.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { JiraSettingsInput, SettingsDto } from "../../shared/dto";
import { api } from "../api";
import { useMeta } from "../meta";
import { type Tracker, trackerOf } from "../review/tasks";
import { read, useSaveSettings } from "../shell/data";

// No tracker in meta: no section.
export function JiraSettings({ settings }: { settings: SettingsDto }) {
  const meta = useMeta().data;
  const tracker = meta && trackerOf(meta);
  return tracker ? <TrackerSettings tracker={tracker} runner={meta.runner.short} settings={settings} /> : null;
}

function TrackerSettings({ tracker, runner, settings }: { tracker: Tracker; runner: string; settings: SettingsDto }) {
  const qc = useQueryClient();
  const { name } = tracker;
  const { baseUrl, caFile, email, tokenStored } = settings[tracker.id];
  // The token lives only in this field until submit. The server never sends it back.
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState<"saved" | "disconnected" | null>(null);
  const [confirm, setConfirm] = useState(false);
  const focusUrl = useRef(false);
  const save = useMutation({
    mutationFn: async (input: JiraSettingsInput) => read<SettingsDto>(await api.api.settings[tracker.id].$put({ json: input })),
    onSuccess: (dto, input) => {
      qc.setQueryData(["settings"], dto);
      // Meta tells the brief whether the tracker is set up.
      void qc.invalidateQueries({ queryKey: ["meta"] });
      setToken("");
      setConfirm(false);
      setSaved(input.baseUrl ? "saved" : "disconnected");
      focusUrl.current = !input.baseUrl;
    },
  });
  // Disconnect takes its own buttons away. The form gets a new key, so focus moves after that render.
  useEffect(() => {
    if (baseUrl !== null || !focusUrl.current) return;
    focusUrl.current = false;
    document.getElementById("tracker-url")?.focus();
  }, [baseUrl]);
  const cancel = () => {
    setConfirm(false);
    requestAnimationFrame(() => document.getElementById("tracker-off")?.focus());
  };
  const memory = settings.tokenStorage === "memory";

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setSaved(null);
    // The server keeps no email it does not get, so the save always sends the field.
    save.mutate({
      baseUrl: String(f.get("baseUrl") ?? ""),
      token,
      caFile: String(f.get("caFile") ?? ""),
      email: String(f.get("email") ?? ""),
    });
  }

  return (
    <section aria-labelledby="h-tracker" className="mt-6 grid max-w-[560px] gap-3 border-t pt-4">
      <div className="grid gap-0.5">
        <h2 id="h-tracker" tabIndex={-1} className="m-0 scroll-mt-4 text-[15px] font-bold outline-none">
          {name}
        </h2>
        <p className="m-0 text-xs text-muted-foreground">
          Press Save {name} settings to keep the changes. The save tests the token with {name} first, so it does not save by itself.
        </p>
      </div>
      <p className="m-0 text-sm text-ink-2">
        {baseUrl === null
          ? `Connect ${name} to fetch the task text into the review brief.`
          : `Connected. The review brief can fetch the task text from ${name}.`}{" "}
        PR Review Inbox calls {name} only when you save here or click Fetch.
      </p>
      {baseUrl !== null && !tokenStored && (
        <p className="m-0 text-sm">The service restarted, and the token was in memory only. Enter the token again.</p>
      )}
      <form className="grid gap-4" onSubmit={submit} key={baseUrl ?? ""}>
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="tracker-url">{name} URL</FieldLabel>
            <Input
              id="tracker-url"
              name="baseUrl"
              type="url"
              required
              defaultValue={baseUrl ?? ""}
              placeholder="https://tracker.example.com"
              autoComplete="url"
              spellCheck={false}
            />
            <FieldDescription>
              The base URL only. Include the context path if your server has one. {name} Cloud: https://example.atlassian.net
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="tracker-email">Atlassian account email ({name} Cloud only)</FieldLabel>
            <Input
              id="tracker-email"
              name="email"
              type="email"
              defaultValue={email ?? ""}
              placeholder="name@example.com"
              autoComplete="email"
              spellCheck={false}
            />
            <FieldDescription>
              {name} Cloud: enter your email and an API token without scopes. Server or Data Center: leave the email empty and use a
              personal access token.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="tracker-token">Personal access token or API token</FieldLabel>
            <Input
              id="tracker-token"
              name="token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={tokenStored ? "Stored. Leave empty to keep it." : "Token…"}
            />
            <FieldDescription>
              {memory
                ? "Token kept in memory only. Enter it again after a restart."
                : "Token kept in the system credential store on this machine."}
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="tracker-ca">{name} CA file (optional)</FieldLabel>
            <Input
              id="tracker-ca"
              name="caFile"
              type="text"
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
              defaultValue={caFile ?? ""}
              placeholder="C:\certs\company-ca.pem"
            />
            <FieldDescription>A PEM file for a server certificate from a private CA.</FieldDescription>
          </Field>
          {save.error && !(save.error instanceof TypeError) && <FieldError>{save.error.message}</FieldError>}
        </FieldGroup>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending && !confirm ? "Checking…" : `Save ${name} settings`}
          </Button>
          <p role="status" className="m-0 text-sm text-ink-2">
            {saved === "saved"
              ? `Saved. ${name} accepted the token.`
              : saved === "disconnected"
                ? `Disconnected. The token is deleted.`
                : ""}
          </p>
          {baseUrl !== null && (
            <Button
              id="tracker-off"
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto text-ink-2"
              aria-expanded={confirm}
              disabled={save.isPending}
              onClick={() => setConfirm(true)}
            >
              Disconnect
            </Button>
          )}
        </div>
      </form>
      {confirm && (
        <DisconnectConfirm name={name} pending={save.isPending} onDisconnect={() => save.mutate({ baseUrl: "" })} onCancel={cancel} />
      )}
      <AskSwitch name={name} runner={runner} settings={settings} />
    </section>
  );
}

// Off records the company AI policy acknowledgement. On brings the question of "Include in runs" back. It saves at once.
function AskSwitch({ name, runner, settings }: { name: string; runner: string; settings: SettingsDto }) {
  const save = useSaveSettings();
  return (
    <Field orientation="horizontal" className="border-t pt-3">
      <Switch
        id="ask-attachments"
        aria-describedby="ask-attachments-help"
        checked={settings.askAttachments}
        disabled={save.isPending}
        onCheckedChange={(askAttachments) =>
          save.mutate({ baseUrl: settings.baseUrl ?? "", caFile: settings.caFile ?? "", askAttachments })
        }
      />
      <FieldContent>
        <FieldLabel htmlFor="ask-attachments">
          Ask before {runner} reads a {name} attachment
        </FieldLabel>
        <FieldDescription id="ask-attachments-help">
          When on, “Include in runs” asks you to confirm that your company AI policy allows sending task attachments to an AI service. Your
          first confirmation turns it off. Saves at once.
        </FieldDescription>
        {save.error && !(save.error instanceof TypeError) && <FieldError>{save.error.message}</FieldError>}
      </FieldContent>
    </Field>
  );
}

function DisconnectConfirm(props: { name: string; pending: boolean; onDisconnect: () => void; onCancel: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => cancel.current?.focus(), []);
  return (
    // Esc closes the settings everywhere else. Here it closes only the question.
    <fieldset
      aria-labelledby="tracker-off-q"
      className="grid min-w-0 gap-2.5 rounded-lg bg-pane-2 p-3"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        props.onCancel();
      }}
    >
      <p id="tracker-off-q" className="m-0 text-sm">
        Disconnect {props.name}? PR Review Inbox deletes the stored token. Fetched task text stays until you remove it in the brief.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="destructive" size="sm" disabled={props.pending} onClick={props.onDisconnect}>
          {props.pending ? "Disconnecting…" : `Disconnect ${props.name}`}
        </Button>
        <Button ref={cancel} variant="outline" size="sm" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </fieldset>
  );
}
