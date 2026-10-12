import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiErrorBody, jsonResponse, makeServer } from "@/test/fixtures";
import { ApiError } from "@/lib/api/errors";
import { ThemeProvider } from "@/lib/theme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FileEditor } from "./file-editor";
import FilesTab, { entryTypeLabel, isOpenable, sortEntries, validateMode } from "./files-tab";
import { MAX_DROPPED_FILES, collectDrop, planUploads } from "./drop";
import {
  baseName,
  breadcrumbs,
  isArchive,
  isLikelyText,
  joinPath,
  languageFor,
  normalizePath,
  parentPath,
  validateName,
  validateRelativePath,
} from "./paths";
import { classifySaveError, saveFile } from "./save-file";
import { isSameOriginUrl } from "./upload";

// jsdom cannot lay out CodeMirror; the editor contract (value/onChange/readOnly) is what matters here.
vi.mock("./code-editor", () => ({
  default: (p: {
    value: string;
    onChange: (v: string) => void;
    readOnly: boolean;
    ariaLabel: string;
    onEscape?: () => void;
  }) => (
    <textarea
      aria-label={p.ariaLabel}
      value={p.value}
      readOnly={p.readOnly}
      onChange={(e) => p.onChange(e.target.value)}
      onKeyDown={(e) => e.key === "Escape" && p.onEscape?.()}
    />
  ),
}));

afterEach(() => vi.unstubAllGlobals());

describe("paths", () => {
  it("normalises, joins and splits relative paths", () => {
    expect(normalizePath("/plugins//./Essentials/")).toBe("plugins/Essentials");
    expect(joinPath("plugins", "config.yml")).toBe("plugins/config.yml");
    expect(joinPath("", "server.properties")).toBe("server.properties");
    expect(parentPath("plugins/a/b.yml")).toBe("plugins/a");
    expect(parentPath("eula.txt")).toBe("");
    expect(baseName("world/level.dat")).toBe("level.dat");
    expect(breadcrumbs("world/region")).toEqual([
      { name: "world", path: "world" },
      { name: "region", path: "world/region" },
    ]);
  });
  it("validates names and destinations", () => {
    expect(validateName("ok.txt")).toBeNull();
    expect(validateName("../x")).toMatch(/cannot contain/);
    expect(validateName("..")).toMatch(/reserved/);
    expect(validateRelativePath("plugins/new/foo.jar")).toBeNull();
    expect(validateRelativePath("/etc/passwd")).toMatch(/relative/);
    expect(validateRelativePath("a/../../b")).toMatch(/'\.\.'/);
    expect(validateRelativePath("./")).toMatch(/root/);
    expect(validateMode("755")).toBeNull();
    expect(validateMode("999")).toMatch(/octal/);
  });
  it("classifies files", () => {
    expect(isArchive("world.tar.gz")).toBe(true);
    expect(isLikelyText("server.properties")).toBe(true);
    expect(isLikelyText("paper.jar")).toBe(false);
    expect(languageFor("config.yml")).toBe("yaml");
    expect(languageFor("ops.json")).toBe("json");
    expect(languageFor("server.properties")).toBe("properties");
  });
  it("sorts folders first, then names naturally", () => {
    const e = (name: string, type: "file" | "dir") => ({ name, path: name, type, size: 0, modifiedAt: 0 });
    expect(
      sortEntries([e("b.txt", "file"), e("world", "dir"), e("a10.txt", "file"), e("a2.txt", "file")]).map(
        (x) => x.name,
      ),
    ).toEqual(["world", "a2.txt", "a10.txt", "b.txt"]);
  });
  it("only trusts same-origin transfer URLs", () => {
    expect(isSameOriginUrl("/api/v1/transfers/abc", "https://panel.example")).toBe(true);
    expect(isSameOriginUrl("https://evil.example/x", "https://panel.example")).toBe(false);
  });
});

describe("saveFile conflict handling", () => {
  it("sends the base sha, or null for new files, and omits it when forcing", async () => {
    const write = vi.fn(async () => ({ sha256: "new", size: 1 }));
    await saveFile(write, { path: "a", content: "x", baseSha256: "old" });
    await saveFile(write, { path: "b", content: "x", baseSha256: null });
    await saveFile(write, { path: "a", content: "x", baseSha256: "old", force: true });
    expect(write.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      { path: "a", content: "x", baseSha256: "old" },
      { path: "b", content: "x", baseSha256: null },
      { path: "a", content: "x" },
    ]);
  });
  it("classifies API errors", () => {
    const err = (code: ApiError["code"], message = "m") => new ApiError({ code, message, status: 400 });
    expect(classifySaveError(err("PRECONDITION_FAILED"))).toMatchObject({ kind: "conflict" });
    expect(classifySaveError(err("CONFLICT"))).toMatchObject({ kind: "conflict" });
    // Classification is by code, never by message text.
    expect(classifySaveError(err("REDACTED_CONTENT", "anything"))).toMatchObject({ kind: "redacted" });
    expect(classifySaveError(err("PATH_DENIED", "anything"))).toMatchObject({ kind: "denied" });
    expect(classifySaveError(err("FORBIDDEN", "File is redacted"))).toMatchObject({ kind: "denied" });
    expect(classifySaveError(new Error("boom"))).toMatchObject({ kind: "error" });
  });
});

function renderEditor(path: string, server = makeServer(), onDirtyChange?: (dirty: boolean) => void) {
  return render(
    <ThemeProvider>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <FileEditor
            server={server}
            path={path}
            isNew={false}
            onClose={() => {}}
            onDirtyChange={onDirtyChange}
          />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

const contents = (over: Record<string, unknown> = {}) => ({
  path: "server.properties",
  content: "motd=hello\n",
  encoding: "utf8",
  sha256: "sha-A",
  size: 11,
  truncated: false,
  redacted: false,
  ...over,
});

describe("FileEditor", () => {
  it("saves with baseSha256, shows the conflict dialog on CONFLICT, and can overwrite", async () => {
    const calls: Array<{ method: string; body: unknown }> = [];
    const responses = [
      jsonResponse(contents()),
      jsonResponse(apiErrorBody("CONFLICT", "File changed since it was read"), { status: 409 }),
      jsonResponse({ sha256: "sha-B", size: 12 }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push({
          method: init.method ?? "GET",
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        return responses.shift()!;
      }),
    );
    const user = userEvent.setup();
    renderEditor("server.properties");
    const editor = (await screen.findByLabelText("Editing server.properties")) as HTMLTextAreaElement;
    expect(editor.value).toBe("motd=hello\n");
    await user.clear(editor);
    await user.type(editor, "motd=mine");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("The file changed on disk")).toBeTruthy();
    expect(calls[1]).toEqual({
      method: "PUT",
      body: { path: "server.properties", content: "motd=mine", baseSha256: "sha-A" },
    });

    await user.click(screen.getByRole("button", { name: "Overwrite with mine" }));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]!.body).toEqual({ path: "server.properties", content: "motd=mine" });
    await waitFor(() => expect(screen.queryByText("The file changed on disk")).toBeNull());
    expect(screen.queryByText("Unsaved")).toBeNull();
  });

  it("opens redacted files read-only without a save button", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(contents({ path: "forwarding.secret", content: "••••", redacted: true })),
      ),
    );
    renderEditor("forwarding.secret");
    const editor = (await screen.findByLabelText("Editing forwarding.secret")) as HTMLTextAreaElement;
    expect(editor.readOnly).toBe(true);
    expect(screen.getByText(/Secret values in this file are masked/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("is read-only without files.write and shows denylist errors on open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(contents())),
    );
    renderEditor("server.properties", makeServer({ myPermissions: ["servers.view", "servers.files.read"] }));
    expect(
      ((await screen.findByLabelText("Editing server.properties")) as HTMLTextAreaElement).readOnly,
    ).toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(apiErrorBody("PATH_DENIED", "config/secret.cfg is on this server's file denylist"), {
          status: 403,
        }),
      ),
    );
    renderEditor("config/secret.cfg");
    expect(await screen.findByText(/file denylist/)).toBeTruthy();
    expect(screen.getByText("Protected by the server's template")).toBeTruthy();
  });
});

describe("FileEditor keyboard and dirty reporting (#9, #10)", () => {
  it("reports unsaved changes to the page and Escape leaves the editor for the Back button", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(contents())),
    );
    const onDirty = vi.fn();
    const user = userEvent.setup();
    const { unmount } = renderEditor("server.properties", makeServer(), onDirty);
    const editor = (await screen.findByLabelText("Editing server.properties")) as HTMLTextAreaElement;
    await user.type(editor, "x");
    expect(onDirty).toHaveBeenLastCalledWith(true);
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Files" }));
    expect(screen.getByText(/Tab indents · Esc leaves the editor/)).toBeTruthy();
    unmount();
    expect(onDirty).toHaveBeenLastCalledWith(false);
  });
});

// -------------------------------------------------------------------------------------------------

const file = (name: string, content = "x") => new File([content], name);

describe("upload planning (#7)", () => {
  it("creates folders parents-first and uploads into them", () => {
    const plan = planUploads([
      { path: "world/region/r.0.0.mca", file: file("r.0.0.mca") },
      { path: "world/level.dat", file: file("level.dat") },
      { path: "ops.json", file: file("ops.json") },
    ]);
    expect(plan.errors).toEqual([]);
    expect(plan.dirs).toEqual(["world", "world/region"]);
    expect(plan.files.map((f) => [f.relativeDir, f.file.name])).toEqual([
      ["world/region", "r.0.0.mca"],
      ["world", "level.dat"],
      ["", "ops.json"],
    ]);
  });

  it("rejects traversal and separators in any segment (picker names included)", () => {
    const plan = planUploads([
      { path: "../escape.txt", file: file("escape.txt") },
      { path: "a/../../b.txt", file: file("b.txt") },
      { path: "evil\\..\\x", file: file("x") },
      { path: "ok.txt", file: file("ok.txt") },
    ]);
    expect(plan.files.map((f) => f.file.name)).toEqual(["ok.txt"]);
    expect(plan.dirs).toEqual([]);
    expect(plan.errors).toHaveLength(3);
  });
});

// Minimal File System Entry fakes (what browsers hand out from webkitGetAsEntry).
type FakeEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (f: File) => void, fail: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (e: FakeEntry[]) => void, fail: (e: unknown) => void) => void };
};
const fileEntry = (name: string): FakeEntry => ({
  isFile: true,
  isDirectory: false,
  name,
  file: (ok) => ok(file(name)),
});
const dirEntry = (name: string, children: FakeEntry[] | "unreadable", batch = 2): FakeEntry => ({
  isFile: false,
  isDirectory: true,
  name,
  createReader: () => {
    let offset = 0;
    return {
      readEntries: (ok, fail) => {
        if (children === "unreadable") return fail(new Error("NotReadableError"));
        const next = children.slice(offset, offset + batch);
        offset += next.length;
        ok(next);
      },
    };
  },
});
const dataTransfer = (entries: FakeEntry[]) =>
  ({
    items: entries.map((e) => ({ kind: "file", webkitGetAsEntry: () => e, getAsFile: () => null })),
    files: [],
  }) as unknown as DataTransfer;

describe("folder drops (#7)", () => {
  it("walks nested folders (all readEntries batches) and keeps relative paths", async () => {
    const dt = dataTransfer([
      dirEntry("plugins", [
        fileEntry("a.jar"),
        fileEntry("b.jar"),
        fileEntry("c.jar"),
        dirEntry("Essentials", [fileEntry("config.yml")]),
      ]),
      fileEntry("server.properties"),
    ]);
    const { items, errors } = await collectDrop(dt);
    expect(errors).toEqual([]);
    expect(items.map((i) => i.path).sort()).toEqual([
      "plugins/Essentials/config.yml",
      "plugins/a.jar",
      "plugins/b.jar",
      "plugins/c.jar",
      "server.properties",
    ]);
    expect(planUploads(items).dirs).toEqual(["plugins", "plugins/Essentials"]);
  });

  it("reports unreadable folders and files instead of silently uploading nothing", async () => {
    const broken: FakeEntry = {
      isFile: true,
      isDirectory: false,
      name: "locked.bin",
      file: (_ok, fail) => fail(new Error("denied")),
    };
    const { items, errors } = await collectDrop(dataTransfer([dirEntry("secret", "unreadable"), broken]));
    expect(items).toEqual([]);
    expect(errors).toEqual(["secret/: the folder could not be read.", "locked.bin: could not be read."]);
  });

  it("stops expanding a drop at the file cap", async () => {
    const many = Array.from({ length: MAX_DROPPED_FILES + 5 }, (_, i) => fileEntry(`f${i}.txt`));
    const { items, errors } = await collectDrop(dataTransfer([dirEntry("big", many, 1000)]));
    expect(items).toHaveLength(MAX_DROPPED_FILES);
    expect(errors).toEqual([`Only the first ${MAX_DROPPED_FILES} files were taken.`]);
  });
});

describe("file list rows (#8, #17)", () => {
  it("links and special files are labelled, not dead buttons; select-all names its scope", async () => {
    const entry = (name: string, type: string) => ({ name, path: name, type, size: 1, modifiedAt: 1 });
    // jsdom has no layout: give the virtualised table a viewport so its rows render.
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          path: "",
          truncated: true,
          entries: [
            entry("world", "dir"),
            entry("server.properties", "file"),
            entry("latest", "symlink"),
            entry("pipe", "other"),
          ],
        }),
      ),
    );
    render(
      <ThemeProvider>
        <QueryClientProvider client={new QueryClient()}>
          <TooltipProvider>
            <FilesTab server={makeServer()} path="" editing={null} onNavigate={() => {}} onEdit={() => {}} />
          </TooltipProvider>
        </QueryClientProvider>
      </ThemeProvider>,
    );
    expect(await screen.findByRole("button", { name: "server.properties" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "world" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^latest/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^pipe/ })).toBeNull();
    expect(screen.getByText("symlink — not followed")).toBeTruthy();
    expect(screen.getByText("special file")).toBeTruthy();
    expect(
      screen.getByRole("checkbox", { name: "Select all 4 loaded rows (the listing is truncated)" }),
    ).toBeTruthy();
    expect(isOpenable({ type: "symlink" })).toBe(false);
    expect(isOpenable({ type: "file" })).toBe(true);
    expect(entryTypeLabel({ type: "dir" })).toBe("dir");
    height.mockRestore();
    width.mockRestore();
  });
});
