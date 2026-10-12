import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SERVER_OWNER_PERMISSIONS } from "@blockforge/contracts";
import type { Permission } from "@blockforge/contracts";
import { SERVER_ID, apiErrorBody, jsonResponse, makeServer } from "@/test/fixtures";
import { makeClient } from "@/test/fake-socket";
import { makeOverview } from "@/test/phase4b-fixtures";
import { findLoadedDialog } from "@/test/lazy";
import { RealtimeProvider } from "@/lib/realtime/provider";
import { ThemeProvider } from "@/lib/theme";
import { TooltipProvider } from "@/components/ui/tooltip";
import PlayersTab from "./players-tab";

afterEach(() => vi.unstubAllGlobals());

type Call = { url: string; method: string; body: unknown };
type Reply = (call: Call) => Response | Promise<Response>;
function routeFetch(routes: Array<[string, RegExp, Reply | Reply[]]>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call = {
        url,
        method: init.method ?? "GET",
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const r = routes.find(([m, p]) => m === call.method && p.test(url));
      if (!r) return jsonResponse(apiErrorBody("NOT_FOUND"), { status: 404 });
      const reply = Array.isArray(r[2]) ? (r[2].length > 1 ? r[2].shift()! : r[2][0]!) : r[2];
      return reply(call);
    }),
  );
  return calls;
}
const ok =
  (body: unknown, status = 200) =>
  () =>
    jsonResponse(body, { status });
const emptySessions = ok({ items: [], nextCursor: null });

function wrap(ui: ReactNode, client?: ReturnType<typeof makeClient>["client"]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const content = <TooltipProvider>{ui}</TooltipProvider>;
  render(
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        {client ? <RealtimeProvider client={client}>{content}</RealtimeProvider> : content}
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return qc;
}

const ALEX_UUID = "11111111-2222-4333-8444-555555555555";

const owner = (over: Parameters<typeof makeServer>[0] = {}) =>
  makeServer({ myPermissions: [...SERVER_OWNER_PERMISSIONS] as Permission[], ...over });

describe("Players tab", () => {
  it("renders unknown counts as unknown and list text from the server files as plain text", async () => {
    routeFetch([
      [
        "GET",
        /\/players$/,
        ok(
          makeOverview({
            online: { count: null, max: null, players: [], skipped: 0, source: null, at: null },
            listErrors: [{ file: "ops.json", message: "<b>entry 3</b> is not a valid UUID" }],
          }),
        ),
      ],
      ["GET", /\/players\/sessions/, emptySessions],
    ]);
    wrap(<PlayersTab server={owner({ state: "stopped" })} />);
    expect(await screen.findByLabelText("Players online")).toHaveProperty("textContent", "—");
    expect(screen.getByText(/Unknown — the server is not running/)).toBeTruthy();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(screen.getByText("<b>Server</b>")).toBeTruthy();
    expect(screen.getByText(/<b>entry 3<\/b> is not a valid UUID/)).toBeTruthy();
    expect(document.querySelector("main img, [role=alert] b")).toBeNull();
    expect(screen.getByText("Forever")).toBeTruthy();
    expect(screen.getByText("Players online")).toBeTruthy(); // count-over-time chart
  });

  it("offers only the available actions; operator changes also need console send", async () => {
    routeFetch([
      ["GET", /\/players$/, ok(makeOverview({ availableActions: ["ban", "op", "deop"] }))],
      ["GET", /\/players\/sessions/, emptySessions],
    ]);
    wrap(
      <PlayersTab
        server={makeServer({
          myPermissions: ["servers.view", "servers.players.view", "servers.players.manage"],
        })}
      />,
    );
    await screen.findByText(/From the server's player list/);
    const online = screen.getByText("Alex").closest("li")!;
    expect(within(online).queryByRole("button", { name: "Kick" })).toBeNull();
    expect((within(online).getByRole("button", { name: "Ban" }) as HTMLButtonElement).disabled).toBe(false);
    expect((within(online).getByRole("button", { name: "Op" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("bans from the online list (no expiry while running) and shows the server's reply as text", async () => {
    const calls = routeFetch([
      ["GET", /\/players$/, ok(makeOverview())],
      ["GET", /\/players\/sessions/, emptySessions],
      ["GET", /\/players\/lookup/, ok({ name: "Alex", uuid: ALEX_UUID, source: "mojang" })],
      [
        "POST",
        /\/players\/actions$/,
        ok({
          applied: "console",
          feedback: { ok: true, message: "<b>Banned player Alex</b>" },
          overview: null,
        }),
      ],
    ]);
    const user = userEvent.setup();
    wrap(<PlayersTab server={owner({ state: "running" })} />);
    const online = (await screen.findByText("Alex")).closest("li")!;
    await user.click(within(online).getByRole("button", { name: "Ban" }));
    const dialog = await findLoadedDialog();
    expect((within(dialog).getByLabelText("Expires") as HTMLInputElement).disabled).toBe(true);
    expect(within(dialog).getByText(/Only while the server is stopped/)).toBeTruthy();
    await user.type(within(dialog).getByLabelText("Reason"), "griefing");
    // A ban adds to a list: the account is looked up first, even from the online list.
    expect(await within(dialog).findByText(ALEX_UUID)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Ban" }));
    expect(await screen.findByText("<b>Banned player Alex</b>")).toBeTruthy();
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      action: "ban",
      name: "Alex",
      reason: "griefing",
    });
    // Console path: the lists are re-read.
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "GET" && c.url.endsWith("/players"))).toHaveLength(2),
    );
  });

  it("adding to the whitelist previews the looked-up account first", async () => {
    const calls = routeFetch([
      ["GET", /\/players$/, ok(makeOverview())],
      ["GET", /\/players\/sessions/, emptySessions],
      [
        "GET",
        /\/players\/lookup/,
        ok({ name: "Notch", uuid: "069a79f4-44e9-4726-a5be-fca90e38aaf5", source: "mojang" }),
      ],
      [
        "POST",
        /\/players\/actions$/,
        ok({ applied: "console", feedback: { ok: true, message: "Added Notch" }, overview: null }),
      ],
    ]);
    const user = userEvent.setup();
    wrap(<PlayersTab server={owner({ state: "running" })} />);
    await screen.findByText("Steve");
    await user.click(screen.getByRole("button", { name: "Add" }));
    const dialog = await findLoadedDialog();
    await user.type(within(dialog).getByLabelText("Player name"), "notch");
    const add = within(dialog).getByRole("button", { name: "Add" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Look up" }));
    expect(await within(dialog).findByText("069a79f4-44e9-4726-a5be-fca90e38aaf5")).toBeTruthy();
    expect(within(dialog).getByText(/Mojang account/)).toBeTruthy();
    expect(calls.find((c) => c.url.includes("/lookup"))!.url).toContain("name=notch");
    expect(add.disabled).toBe(false);
    await user.click(add);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({
        action: "whitelist-add",
        name: "notch",
      }),
    );
  });

  it("whitelisting from the online list goes through the lookup preview (no direct add)", async () => {
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((r) => (releaseLookup = r));
    const calls = routeFetch([
      ["GET", /\/players$/, ok(makeOverview({ whitelist: { ...makeOverview().whitelist, enabled: true } }))],
      ["GET", /\/players\/sessions/, emptySessions],
      [
        "GET",
        /\/players\/lookup/,
        async () => {
          await lookupGate;
          return jsonResponse({ name: "Alex", uuid: ALEX_UUID, source: "offline" });
        },
      ],
      ["POST", /\/players\/actions$/, ok({ applied: "file", feedback: null, overview: null })],
    ]);
    const user = userEvent.setup();
    wrap(<PlayersTab server={owner({ state: "stopped" })} />);
    const online = (await screen.findByText("Alex")).closest("li")!;
    await user.click(within(online).getByRole("button", { name: "Whitelist" }));
    // Nothing is sent from the row itself: a dialog opens and looks the name up.
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    const dialog = await findLoadedDialog();
    expect((within(dialog).getByLabelText("Player name") as HTMLInputElement).value).toBe("Alex");
    const add = within(dialog).getByRole("button", { name: "Add" }) as HTMLButtonElement;
    expect(await within(dialog).findByText("Looking up Alex…")).toBeTruthy();
    expect(add.disabled).toBe(true);
    await user.click(add);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    releaseLookup();
    expect(await within(dialog).findByText(ALEX_UUID)).toBeTruthy();
    expect(within(dialog).getByText(/offline-mode UUID/)).toBeTruthy();
    expect(calls.filter((c) => c.url.includes("/lookup")).map((c) => c.url)).toEqual([
      expect.stringContaining("name=Alex"),
    ]);
    expect(add.disabled).toBe(false);
    await user.click(add);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({ action: "whitelist-add", name: "Alex" }),
    );
  });

  it("the Op quick action looks the name up and warns when it resolves to another UUID", async () => {
    const calls = routeFetch([
      [
        "GET",
        /\/players$/,
        ok(
          makeOverview({
            online: {
              ...makeOverview().online,
              players: [{ name: "Alex", uuid: "11111111-2222-4333-8444-aaaaaaaaaaaa" }],
            },
          }),
        ),
      ],
      ["GET", /\/players\/sessions/, emptySessions],
      ["GET", /\/players\/lookup/, ok({ name: "Alex", uuid: ALEX_UUID, source: "mojang" })],
      [
        "POST",
        /\/players\/actions$/,
        ok({ applied: "console", feedback: { ok: true, message: "Opped" }, overview: null }),
      ],
    ]);
    const user = userEvent.setup();
    wrap(<PlayersTab server={owner({ state: "running" })} />);
    const online = (await screen.findByText("Alex")).closest("li")!;
    await user.click(within(online).getByRole("button", { name: "Op" }));
    const dialog = await findLoadedDialog();
    const submit = within(dialog).getByRole("button", { name: "Make operator" }) as HTMLButtonElement;
    expect(await within(dialog).findByText(ALEX_UUID)).toBeTruthy();
    expect(within(dialog).getByText(/Mojang account/)).toBeTruthy();
    expect(within(dialog).getByText(/resolves to a different UUID than the online player/)).toBeTruthy();
    expect(calls.find((c) => c.url.includes("/lookup"))!.url).toContain("name=Alex");
    expect(submit.disabled).toBe(false);
    await user.click(submit);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({ action: "op", name: "Alex" }),
    );
  });

  it("a failed lookup keeps every list add disabled", async () => {
    const calls = routeFetch([
      ["GET", /\/players$/, ok(makeOverview())],
      ["GET", /\/players\/sessions/, emptySessions],
      ["GET", /\/players\/lookup/, () => jsonResponse(apiErrorBody("NOT_FOUND", "unknown"), { status: 404 })],
    ]);
    const user = userEvent.setup();
    wrap(<PlayersTab server={owner({ state: "running" })} />);
    const online = (await screen.findByText("Alex")).closest("li")!;
    await user.click(within(online).getByRole("button", { name: "Ban" }));
    const dialog = await findLoadedDialog();
    await waitFor(() => expect(calls.some((c) => c.url.includes("/lookup"))).toBe(true));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    const ban = within(dialog).getByRole("button", { name: "Ban" }) as HTMLButtonElement;
    expect(ban.disabled).toBe(true);
    await user.click(ban);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("explains a command the server didn't confirm", async () => {
    routeFetch([
      ["GET", /\/players$/, ok(makeOverview())],
      ["GET", /\/players\/sessions/, emptySessions],
      [
        "POST",
        /\/players\/actions$/,
        () =>
          jsonResponse(
            apiErrorBody("UPSTREAM_ERROR", "timeout", "req-1", { reason: "no_feedback", sent: true }),
            { status: 504 },
          ),
      ],
    ]);
    const user = userEvent.setup();
    wrap(<PlayersTab server={owner({ state: "running" })} />);
    const online = (await screen.findByText("Alex")).closest("li")!;
    await user.click(within(online).getByRole("button", { name: "Kick" }));
    await user.click(within(await findLoadedDialog()).getByRole("button", { name: "Kick" }));
    expect(await screen.findByText("Sent, but the server didn't confirm")).toBeTruthy();
    expect(screen.getByText(/Check the console/)).toBeTruthy();
  });

  it("on a stopped server sets operator level and uses the returned lists", async () => {
    const after = makeOverview({
      ops: [
        { uuid: "11111111-2222-4333-8444-777777777777", name: "Admin", level: 4, bypassesPlayerLimit: false },
        { uuid: "11111111-2222-4333-8444-999999999999", name: "Helper", level: 2, bypassesPlayerLimit: true },
      ],
    });
    const calls = routeFetch([
      ["GET", /\/players$/, ok(makeOverview())],
      ["GET", /\/players\/sessions/, emptySessions],
      [
        "GET",
        /\/players\/lookup/,
        ok({ name: "Helper", uuid: "11111111-2222-4333-8444-999999999999", source: "offline" }),
      ],
      ["POST", /\/players\/actions$/, ok({ applied: "file", feedback: null, overview: after })],
    ]);
    const user = userEvent.setup();
    wrap(<PlayersTab server={owner({ state: "stopped" })} />);
    await user.click(await screen.findByRole("button", { name: "Add operator" }));
    const dialog = await findLoadedDialog();
    await user.type(within(dialog).getByLabelText("Player name"), "Helper");
    await user.click(within(dialog).getByRole("button", { name: "Look up" }));
    expect(await within(dialog).findByText(/offline-mode UUID/)).toBeTruthy();
    await user.click(within(dialog).getByRole("switch", { name: "May join when the server is full" }));
    await user.click(within(dialog).getByRole("button", { name: "Make operator" }));
    expect(await screen.findByText("Saved to the server's list files")).toBeTruthy();
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      action: "op",
      name: "Helper",
      level: 4,
      bypassesPlayerLimit: true,
    });
    expect(screen.getByText("Helper")).toBeTruthy();
    expect(calls.filter((c) => c.method === "GET" && c.url.endsWith("/players"))).toHaveLength(1);
  });

  it("live joins and leaves update the online list and the session history", async () => {
    routeFetch([
      ["GET", /\/players$/, ok(makeOverview())],
      ["GET", /\/players\/sessions/, emptySessions],
    ]);
    const { client, last } = makeClient();
    wrap(<PlayersTab server={owner({ state: "running" })} />, client);
    await screen.findByText("No sessions recorded yet");
    act(() => last().open());
    const send = (type: string, data: unknown) =>
      act(() => last().receive({ op: "event", topic: `server:${SERVER_ID}`, type, ts: 1, data }));
    send("player.joined", {
      serverId: SERVER_ID,
      name: "Steve",
      uuid: null,
      at: 1_760_000_500_000,
      sessionId: "d0000000-0000-4000-8000-000000000009",
    });
    send("player.left", {
      serverId: SERVER_ID,
      name: "Alex",
      uuid: null,
      at: 1_760_000_600_000,
      sessionId: null,
      reason: null,
    });
    await waitFor(() => expect(screen.getByLabelText("Players online").textContent).toBe("1 / 20"));
    const online =
      screen.getByText(/From the server's player list/).closest("[class*=card]") ?? document.body;
    expect(within(online as HTMLElement).queryByText("Alex")).toBeNull();
    const sessionRow = (await screen.findAllByText("Steve")).find((el) => el.closest("tr"))!.closest("tr")!;
    expect(within(sessionRow).getByText("Online")).toBeTruthy();
  });

  it("filters the session history by name", async () => {
    const calls = routeFetch([
      ["GET", /\/players$/, ok(makeOverview())],
      ["GET", /\/players\/sessions/, emptySessions],
    ]);
    const user = userEvent.setup();
    wrap(<PlayersTab server={owner()} />);
    await user.type(await screen.findByLabelText("Filter sessions by player name"), "Alex");
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("/sessions") && c.url.includes("name=Alex"))).toBe(true),
    );
    await user.type(screen.getByLabelText("Filter sessions by player name"), "!");
    expect(screen.getByText(/1–16 letters/)).toBeTruthy();
  });
});
