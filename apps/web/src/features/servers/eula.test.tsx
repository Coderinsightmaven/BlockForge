import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SERVER_OWNER_PERMISSIONS } from "@blockforge/contracts";
import { SERVER_ID, apiErrorBody, jsonResponse, makeServer } from "@/test/fixtures";
import { ThemeProvider } from "@/lib/theme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { acceptEulaContent, eulaAccepted, isEulaPrompt } from "./eula";
import { EulaBanner, acceptEula, eulaFollowUpAction, shouldShowEulaBanner } from "./eula-banner";

afterEach(() => vi.unstubAllGlobals());

const NOW = new Date("2026-10-12T10:00:00Z");
const fileBody = (content: string, sha = "sha-A") => ({
  path: "eula.txt",
  content,
  encoding: "utf8",
  sha256: sha,
  size: content.length,
  truncated: false,
  redacted: false,
});

describe("EULA helpers", () => {
  it("recognises Minecraft's refusal, with or without formatting", () => {
    expect(
      isEulaPrompt(
        "[12:00:00] [main/INFO]: You need to agree to the EULA in order to run the server. Go to eula.txt for more info.",
      ),
    ).toBe(true);
    expect(isEulaPrompt("\u001b[33m[12:00:00 WARN]: You need to agree to the EULA\u001b[0m")).toBe(true);
    expect(isEulaPrompt("<Steve> you need to agree to the eula lol")).toBe(true); // harmless: only offers a banner
    expect(isEulaPrompt('Done (3.2s)! For help, type "help"')).toBe(false);
  });

  it("reads eula.txt like Minecraft does", () => {
    expect(eulaAccepted("#By changing the setting below to TRUE…\n#Mon Oct 12\neula=true\n")).toBe(true);
    expect(eulaAccepted("eula=TRUE")).toBe(true);
    expect(eulaAccepted("eula = true")).toBe(true);
    expect(eulaAccepted("eula=false\n")).toBe(false);
    expect(eulaAccepted("#eula=true\n")).toBe(false);
    expect(eulaAccepted("")).toBe(false);
  });

  it("rewrites only the eula line, keeping comments and line endings", () => {
    expect(acceptEulaContent("#comment\r\neula=false\r\nfoo=bar\r\n", NOW)).toBe(
      "#comment\r\neula=true\r\nfoo=bar\r\n",
    );
    expect(acceptEulaContent("#only a comment", NOW)).toBe("#only a comment\neula=true\n");
    expect(acceptEulaContent(null, NOW)).toBe(
      "#Accepted through BlockForge on 2026-10-12T10:00:00.000Z (https://aka.ms/MinecraftEULA)\neula=true\n",
    );
  });

  it("decides when to show the banner", () => {
    expect(shouldShowEulaBanner("needed", false)).toBe(true);
    expect(shouldShowEulaBanner("unknown", true)).toBe(true);
    // An old prompt in the console history does not override an accepted file.
    expect(shouldShowEulaBanner("accepted", true)).toBe(false);
    expect(shouldShowEulaBanner("unknown", false)).toBe(false);
  });

  it("starts a stopped/crashed server and restarts a running one", () => {
    expect(eulaFollowUpAction({ state: "crashed", activeOperation: null })).toBe("start");
    expect(eulaFollowUpAction({ state: "stopped", activeOperation: null })).toBe("start");
    expect(eulaFollowUpAction({ state: "running", activeOperation: null })).toBe("restart");
    expect(eulaFollowUpAction({ state: "stopping", activeOperation: "stop" })).toBeNull();
  });
});

function stubFetch(responses: Response[]) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      const r = responses.shift();
      if (!r) throw new Error(`unexpected ${init.method} ${url}`);
      return r;
    }),
  );
  return calls;
}

describe("acceptEula", () => {
  it("writes eula=true with the file's sha, then starts the server", async () => {
    const calls = stubFetch([
      jsonResponse(fileBody("#generated\neula=false\n")),
      jsonResponse({ sha256: "sha-B", size: 20 }),
      jsonResponse({ jobId: "77777777-7777-4777-8777-777777777777" }, { status: 202 }),
    ]);
    await expect(acceptEula({ id: SERVER_ID, state: "crashed", activeOperation: null })).resolves.toEqual({
      started: true,
    });
    expect(calls[1]).toMatchObject({
      method: "PUT",
      body: { path: "eula.txt", content: "#generated\neula=true\n", baseSha256: "sha-A" },
    });
    expect(calls[2]).toMatchObject({
      method: "POST",
      url: `/api/v1/servers/${SERVER_ID}/actions`,
      body: { action: "start" },
    });
  });

  it("creates a missing eula.txt (baseSha256 null) and retries once on a conflict", async () => {
    const calls = stubFetch([
      jsonResponse(apiErrorBody("NOT_FOUND"), { status: 404 }),
      jsonResponse(apiErrorBody("CONFLICT", "changed"), { status: 409 }),
      jsonResponse(fileBody("eula=false\n", "sha-C")),
      jsonResponse({ sha256: "sha-D", size: 10 }),
      jsonResponse({ jobId: "77777777-7777-4777-8777-777777777777" }, { status: 202 }),
    ]);
    await acceptEula({ id: SERVER_ID, state: "stopped", activeOperation: null });
    expect((calls[1]!.body as { baseSha256: unknown }).baseSha256).toBeNull();
    expect(calls[3]!.body).toMatchObject({ content: "eula=true\n", baseSha256: "sha-C" });
  });

  it("does not start a server that cannot be started right now", async () => {
    const calls = stubFetch([jsonResponse(fileBody("eula=true\n"))]);
    await expect(acceptEula({ id: SERVER_ID, state: "stopping", activeOperation: "stop" })).resolves.toEqual({
      started: false,
    });
    expect(calls).toHaveLength(1); // already accepted: no write, no power action
  });
});

function renderBanner(server = makeServer({ state: "crashed" }), promptSeen = false) {
  return render(
    <ThemeProvider>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <EulaBanner server={server} promptSeen={promptSeen} onAccepted={() => {}} />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("EulaBanner", () => {
  it("offers acceptance when eula.txt says false", async () => {
    stubFetch([jsonResponse(fileBody("eula=false\n"))]);
    renderBanner();
    expect(await screen.findByText("Accept the Minecraft EULA")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Review & accept/ })).toBeTruthy();
  });

  it("explains instead of acting without file-write and power permissions", async () => {
    stubFetch([jsonResponse(fileBody("eula=false\n"))]);
    renderBanner(
      makeServer({
        state: "crashed",
        myPermissions: ["servers.view", "servers.files.read", "servers.console.view"],
      }),
    );
    expect(await screen.findByText(/Ask the server's owner/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Review & accept/ })).toBeNull();
  });

  it("shows from the console prompt alone when files are not readable, and never for non-Minecraft servers", async () => {
    renderBanner(
      makeServer({ state: "crashed", myPermissions: ["servers.view", "servers.console.view"] }),
      true,
    );
    expect(await screen.findByText("Accept the Minecraft EULA")).toBeTruthy();
    const { container } = renderBanner(
      makeServer({ game: "other", myPermissions: [...SERVER_OWNER_PERMISSIONS] }),
      true,
    );
    expect(container.textContent).toBe("");
  });
});
