import { describe, expect, it } from "vitest";
import { memoryFs } from "./memory-fs.js";

describe("memory filesystem promise failures", () => {
  it("rejects missing-file reads with ENOENT instead of throwing synchronously", async () => {
    const fs = memoryFs();
    const read = fs.promises.readFile("/missing");
    expect(read).toBeInstanceOf(Promise);
    await expect(read).rejects.toMatchObject({
      code: "ENOENT",
      message: "ENOENT: /missing",
    });
    await expect(fs.promises.stat("/missing")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects directory operations on files with ENOTDIR", async () => {
    const fs = memoryFs();
    await fs.promises.writeFile("/file", "contents");
    const listing = fs.promises.readdir("/file");
    expect(listing).toBeInstanceOf(Promise);
    await expect(listing).rejects.toMatchObject({
      code: "ENOTDIR",
      message: "ENOTDIR: /file",
    });
    await expect(
      fs.promises.writeFile("/file/child", "data"),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(await fs.promises.readFile("/file", "utf8")).toBe("contents");
  });
});
