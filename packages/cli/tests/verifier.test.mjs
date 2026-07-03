import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";
import {
  parseTarEntries,
  verifyPackedArtifact
} from "./verify-packed-artifact.mjs";

function writeOctal(target, offset, length, value) {
  target.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function tarHeader({ name, type = "0", content = Buffer.alloc(0), linkName = "" }) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, type === "5" ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, content.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write(linkName, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function tar(entries, { endBlocks = 2, trailing = Buffer.alloc(0) } = {}) {
  const blocks = [];
  for (const input of entries) {
    const content = Buffer.isBuffer(input.content)
      ? input.content
      : Buffer.from(input.content ?? "", "utf8");
    blocks.push(tarHeader({ ...input, content }), content);
    blocks.push(Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(512 * endBlocks), trailing);
  return gzipSync(Buffer.concat(blocks));
}

function paxRecord(key, value, ending = "\n") {
  const payload = `${key}=${value}${ending}`;
  let length = Buffer.byteLength(payload) + 2;
  while (`${length} ${payload}`.length !== length) {
    length = Buffer.byteLength(payload) + `${length} `.length;
  }
  return `${length} ${payload}`;
}

async function trustedFiles() {
  return {
    "package/LICENSE": await readFile(new URL("../LICENSE", import.meta.url)),
    "package/README.md": await readFile(new URL("../README.md", import.meta.url)),
    "package/dist/THIRD_PARTY_NOTICES.txt": await readFile(
      new URL("../dist/THIRD_PARTY_NOTICES.txt", import.meta.url)
    ),
    "package/dist/third-party-manifest.json": await readFile(
      new URL("../dist/third-party-manifest.json", import.meta.url)
    ),
    "package/package.json": await readFile(new URL("../package.json", import.meta.url))
  };
}

async function writeArtifact(files) {
  const directory = await mkdtemp(join(tmpdir(), "steward-verifier-"));
  const artifact = join(directory, "artifact.tgz");
  await writeFile(
    artifact,
    tar(Object.entries(files).map(([name, content]) => ({ name, content })))
  );
  return artifact;
}

it("rejects self-consistent false metadata instead of trusting the tarball's own claims", async () => {
  const files = await trustedFiles();
  files["package/dist/third-party-manifest.json"] = Buffer.from(
    '{"schemaVersion":1,"packages":[]}\n'
  );
  files["package/dist/THIRD_PARTY_NOTICES.txt"] = Buffer.from("# Third-Party Notices\n");
  await expect(verifyPackedArtifact(await writeArtifact(files))).rejects.toThrow(/trusted|expected/i);
});

it("rejects heading-only notices even when the dependency manifest remains plausible", async () => {
  const files = await trustedFiles();
  files["package/dist/THIRD_PARTY_NOTICES.txt"] = Buffer.from("# Third-Party Notices\n");
  await expect(verifyPackedArtifact(await writeArtifact(files))).rejects.toThrow(/trusted|expected/i);
});

it.each([
  ["package/README.md", "# Fake package\n"],
  ["package/LICENSE", "Fake license\n"]
])("rejects a packed %s that differs from the trusted repository file", async (path, content) => {
  const files = await trustedFiles();
  files[path] = Buffer.from(content);
  await expect(verifyPackedArtifact(await writeArtifact(files))).rejects.toThrow(/trusted|expected/i);
});

it("rejects an empty trusted dependency baseline even when the tarball matches it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "steward-empty-trust-"));
  await mkdir(join(directory, "dist"));
  const files = await trustedFiles();
  files["package/dist/third-party-manifest.json"] = Buffer.from(
    '{"schemaVersion":1,"packages":[]}\n'
  );
  files["package/dist/THIRD_PARTY_NOTICES.txt"] = Buffer.from("# Third-Party Notices\n");
  await Promise.all([
    writeFile(join(directory, "LICENSE"), files["package/LICENSE"]),
    writeFile(join(directory, "README.md"), files["package/README.md"]),
    writeFile(
      join(directory, "dist", "third-party-manifest.json"),
      files["package/dist/third-party-manifest.json"]
    ),
    writeFile(
      join(directory, "dist", "THIRD_PARTY_NOTICES.txt"),
      files["package/dist/THIRD_PARTY_NOTICES.txt"]
    )
  ]);
  await expect(
    verifyPackedArtifact(await writeArtifact(files), { trustedPackageDirectory: directory })
  ).rejects.toThrow(/vite|commander|react|fastify|yaml|zod|trusted/i);
});

it("keeps global PAX paths persistent and local PAX paths single-use", () => {
  const globalDuplicate = tar([
    { name: "pax-global", type: "g", content: paxRecord("path", "package/duplicate") },
    { name: "package/first", content: "first" },
    { name: "package/second", content: "second" }
  ]);
  expect(() => parseTarEntries(globalDuplicate)).toThrow(/duplicate/i);

  const localOnce = parseTarEntries(tar([
    { name: "pax-local", type: "x", content: paxRecord("path", "package/renamed") },
    { name: "package/original", content: "first" },
    { name: "package/second", content: "second" }
  ]));
  expect([...localOnce.keys()]).toEqual(["package/renamed", "package/second"]);
});

it("requires strict PAX record lengths and newline terminators", () => {
  const malformed = tar([
    {
      name: "pax-local",
      type: "x",
      content: paxRecord("path", "package/renamed", "X")
    },
    { name: "package/original", content: "first" }
  ]);
  expect(() => parseTarEntries(malformed)).toThrow(/PAX.*newline|malformed PAX/i);
});

it("preserves whitespace in GNU long names instead of changing the verified path", () => {
  const files = parseTarEntries(tar([
    { name: "././@LongLink", type: "L", content: "package/name \0" },
    { name: "package/ignored", content: "value" }
  ]));
  expect([...files.keys()]).toEqual(["package/name "]);
});

it.each(["1", "2", "3", "4", "6", "7"])(
  "rejects unsupported tar entry type %s",
  (type) => {
    expect(() => parseTarEntries(tar([
      { name: "package/special", type, linkName: "../../escape" }
    ]))).toThrow(/unsupported.*type/i);
  }
);

it("tracks duplicate paths across directories and regular files", () => {
  expect(() => parseTarEntries(tar([
    { name: "package/duplicate", type: "5" },
    { name: "package/duplicate", content: "file" }
  ]))).toThrow(/duplicate/i);
});

it.each([
  ["one end block", { endBlocks: 1 }],
  ["non-zero data after end markers", { trailing: Buffer.from("not zero") }],
  ["partial trailing block", { trailing: Buffer.alloc(17) }]
])("rejects %s", (_label, ending) => {
  expect(() => parseTarEntries(tar([
    { name: "package/file", content: "value" }
  ], ending))).toThrow(/end marker|trailing/i);
});
