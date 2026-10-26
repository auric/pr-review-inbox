// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The company AI policy question before the runner reads a task attachment (plan r3 S-ATT). The PR brief and the Build task form use
// it (docs/plans/review-v2/spec.md section 6.17). The Settings field askAttachments keeps the answer: a confirm turns the question
// off, and the tracker section of Settings turns it on again. The dialog opens with focus on the policy box.
import { ShieldAlert } from "lucide-react";
import { useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { dialogKeys } from "../fix/CloneDialog";
import { useSaveSettings, useSettings } from "../shell/data";

// A tick asks first until the user answers once. Unknown settings ask.
export const mustAsk = (askAttachments: boolean | undefined) => askAttachments !== false;

export function PolicyDialog(props: {
  open: boolean;
  title: string;
  description: string;
  // The words of the confirm button, such as "Include in runs".
  action: string;
  runner: string;
  // The tracker name of the Settings section, from meta.
  source: string;
  finalFocus: () => HTMLElement | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [allowed, setAllowed] = useState(false);
  // Each open starts with the box clear (React docs, "Storing information from previous renders").
  const [wasOpen, setWasOpen] = useState(props.open);
  if (props.open !== wasOpen) {
    setWasOpen(props.open);
    if (props.open) setAllowed(false);
  }
  const allow = useRef<HTMLInputElement>(null);
  const settings = useSettings().data;
  const save = useSaveSettings();
  const confirm = () => {
    if (!allowed) return;
    props.onConfirm();
    if (settings?.askAttachments)
      save.mutate(
        { baseUrl: settings.baseUrl ?? "", caFile: settings.caFile ?? "", askAttachments: false },
        { onError: (e) => toast.add({ title: `The policy answer was not saved: ${e.message}` }) },
      );
  };
  return (
    <Dialog open={props.open} onOpenChange={(on) => !on && props.onClose()}>
      <DialogContent className="sm:max-w-[480px]" initialFocus={allow} finalFocus={props.finalFocus} onKeyDown={dialogKeys(props.onClose)}>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        <Alert role="note">
          <ShieldAlert aria-hidden />
          <AlertTitle>Company AI policy</AlertTitle>
          <AlertDescription>
            {props.runner} sends the content of the files that it reads to its AI model. Check that your company AI policy allows this for
            task attachments.
          </AlertDescription>
        </Alert>
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            ref={allow}
            type="checkbox"
            className="mt-0.5 size-4 shrink-0 accent-primary"
            checked={allowed}
            onChange={(e) => setAllowed(e.target.checked)}
          />
          <span>My company AI policy allows sending task attachments to an AI service.</span>
        </label>
        <p className="m-0 text-xs text-muted-foreground">
          PR Review Inbox asks this only once. The {props.source} section in Settings turns the question back on.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={!allowed} onClick={confirm}>
            {props.action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
