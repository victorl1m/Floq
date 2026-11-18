import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { installAndRestart, startUpdateScheduler, useUpdateState } from "@/lib/updater";
import { releaseNotesUrl } from "@/lib/updater-logic";
import { openExternal } from "@/lib/open-external";

const TOAST_ID = "app-update-ready";

/** Headless: starts the update scheduler and shows "Floq X is ready" once the update is downloaded. */
export function UpdateHost() {
  const update = useUpdateState();
  const announced = useRef<string | null>(null);

  useEffect(() => startUpdateScheduler(), []);

  useEffect(() => {
    if (update.status !== "ready" || !update.version || announced.current === update.version) return;
    announced.current = update.version;
    const version = update.version;
    toast.success(`Floq ${version} is ready`, {
      id: TOAST_ID,
      description: (
        <span>
          Restart to finish updating. If you choose Later, Floq offers it again the next time it starts.{" "}
          <button type="button" className="underline underline-offset-2" onClick={() => void openExternal(releaseNotesUrl(version))}>
            Release notes
          </button>
        </span>
      ),
      duration: Infinity,
      action: { label: "Restart now", onClick: () => void installAndRestart() },
      cancel: { label: "Later", onClick: () => undefined },
      closeButton: false,
    });
  }, [update.status, update.version]);

  return null;
}
