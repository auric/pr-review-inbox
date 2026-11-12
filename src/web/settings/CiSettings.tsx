// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// CI server settings (part-session.md section 2.15, package C2): the base URL, the user, the API token, and the CA file.
// Save and Test check the login with the CI server. The server never sends the token back.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { JenkinsSettingsInput, JenkinsTestDto, SettingsDto } from "../../shared/dto";
import { api } from "../api";
import { read } from "../shell/data";

export function CiSettings({ settings }: { settings: SettingsDto }) {
  const qc = useQueryClient();
  const { baseUrl, user, caFile, tokenStored } = settings.jenkins;
  // The token lives only in this field until submit.
  const [token, setToken] = useState("");
  const [status, setStatus] = useState("");
  const [confirm, setConfirm] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const values = (): JenkinsSettingsInput => {
    const f = new FormData(form.current ?? undefined);
    return { baseUrl: String(f.get("baseUrl") ?? ""), user: String(f.get("user") ?? ""), token, caFile: String(f.get("caFile") ?? "") };
  };
  const save = useMutation({
    mutationFn: async (input: JenkinsSettingsInput) => read<SettingsDto>(await api.api.settings.jenkins.$put({ json: input })),
    onSuccess: (dto, input) => {
      qc.setQueryData(["settings"], dto);
      setToken("");
      setConfirm(false);
      setStatus(input.baseUrl ? "Saved. The CI server accepted the login." : "Disconnected. The token is deleted.");
    },
  });
  const test = useMutation({
    mutationFn: async (input: JenkinsSettingsInput) => read<JenkinsTestDto>(await api.api.settings.jenkins.test.$post({ json: input })),
    onSuccess: (r) => setStatus(`Test passed. The CI server knows you as ${r.user}. Nothing is saved yet.`),
  });
  const pending = save.isPending || test.isPending;
  const error = [save.error, test.error].find((e) => e && !(e instanceof TypeError));
  const memory = settings.tokenStorage === "memory";

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("");
    test.reset();
    save.mutate(values());
  }

  return (
    <section aria-labelledby="h-ci" className="mt-6 grid max-w-[560px] gap-3 border-t pt-4">
      <div className="grid gap-0.5">
        <h2 id="h-ci" tabIndex={-1} className="m-0 scroll-mt-4 text-[15px] font-bold outline-none">
          CI server
        </h2>
        <p className="m-0 text-xs text-muted-foreground">
          Press Save CI server settings to keep the changes. The save tests the login first. Test checks the login and saves nothing.
        </p>
      </div>
      <p className="m-0 text-sm text-ink-2">
        {baseUrl === null ? "Connect the CI server for later build log reads. No feature reads build logs yet." : "Connected."} PR Review
        Inbox calls the CI server only with GET requests to this URL. AI runs never get this token.
      </p>
      {baseUrl !== null && !tokenStored && (
        <p className="m-0 text-sm">The service restarted, and the token was in memory only. Enter the token again.</p>
      )}
      <form ref={form} className="grid gap-4" onSubmit={submit} key={baseUrl ?? ""}>
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="ci-url">CI server URL</FieldLabel>
            <Input
              id="ci-url"
              name="baseUrl"
              type="url"
              required
              defaultValue={baseUrl ?? ""}
              placeholder="https://ci.example.com"
              autoComplete="url"
              spellCheck={false}
            />
            <FieldDescription>
              The base URL that the browser shows after login. Include the context path if your server has one. Plain http works only on
              localhost.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="ci-user">User name</FieldLabel>
            <Input id="ci-user" name="user" type="text" required defaultValue={user ?? ""} autoComplete="username" spellCheck={false} />
          </Field>
          <Field>
            <FieldLabel htmlFor="ci-token">API token</FieldLabel>
            <Input
              id="ci-token"
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
                : "Token kept in the system credential store on this machine."}{" "}
              A token works only on the server that made it. A new URL needs a new token.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="ci-ca">CI server CA file (optional)</FieldLabel>
            <Input
              id="ci-ca"
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
          {error && <FieldError>{error.message}</FieldError>}
        </FieldGroup>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button type="submit" disabled={pending}>
            {save.isPending && !confirm ? "Checking…" : "Save CI server settings"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => {
              if (!form.current?.reportValidity()) return;
              setStatus("");
              save.reset();
              test.mutate(values());
            }}
          >
            {test.isPending ? "Testing…" : "Test"}
          </Button>
          <p role="status" className="m-0 text-sm text-ink-2">
            {status}
          </p>
          {baseUrl !== null && (
            <Button
              id="ci-off"
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto text-ink-2"
              aria-expanded={confirm}
              disabled={pending}
              onClick={() => setConfirm(true)}
            >
              Disconnect
            </Button>
          )}
        </div>
      </form>
      {confirm && (
        <DisconnectConfirm
          pending={save.isPending}
          onDisconnect={() => save.mutate({ baseUrl: "" })}
          onCancel={() => {
            setConfirm(false);
            requestAnimationFrame(() => document.getElementById("ci-off")?.focus());
          }}
        />
      )}
    </section>
  );
}

function DisconnectConfirm(props: { pending: boolean; onDisconnect: () => void; onCancel: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => cancel.current?.focus(), []);
  return (
    // Esc closes the settings everywhere else. Here it closes only the question.
    <fieldset
      aria-labelledby="ci-off-q"
      className="grid min-w-0 gap-2.5 rounded-lg bg-pane-2 p-3"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        props.onCancel();
      }}
    >
      <p id="ci-off-q" className="m-0 text-sm">
        Disconnect the CI server? PR Review Inbox deletes the stored token.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="destructive" size="sm" disabled={props.pending} onClick={props.onDisconnect}>
          {props.pending ? "Disconnecting…" : "Disconnect the CI server"}
        </Button>
        <Button ref={cancel} variant="outline" size="sm" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </fieldset>
  );
}
