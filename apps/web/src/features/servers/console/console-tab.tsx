import type { Server } from "@blockforge/contracts";
import { ServerLiveStats } from "../server-common";
import { ConsolePanel } from "./console-panel";

/** The Console tab: live console + current stats. Its own chunk, preloaded when the server page mounts. */
export default function ConsoleTab({ server, onEulaPrompt }: { server: Server; onEulaPrompt: () => void }) {
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <ConsolePanel server={server} className="h-[60vh] min-h-80 lg:h-[34rem]" onEulaPrompt={onEulaPrompt} />
      <ServerLiveStats server={server} />
    </div>
  );
}
