import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const abstractLicense = `MIT License

Copyright © 2014 James Sumners james.sumners@gmail.com

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

it("normalizes GitHub shorthand and accepts only explicit remote source protocols", async () => {
  const compliance = import("../license-compliance.mjs");
  await expect(compliance).resolves.toHaveProperty("normalizeSourceUrl");
  const { normalizeSourceUrl } = await compliance;

  expect(normalizeSourceUrl("eemeli/yaml")).toBe("https://github.com/eemeli/yaml");
  expect(normalizeSourceUrl("github:eemeli/yaml")).toBe("https://github.com/eemeli/yaml");
  expect(normalizeSourceUrl("git://github.com/isaacs/inherits")).toBe(
    "https://github.com/isaacs/inherits"
  );
  expect(normalizeSourceUrl("git+ssh://git@github.com/pinojs/pino.git")).toBe(
    "https://github.com/pinojs/pino.git"
  );
  expect(normalizeSourceUrl("https://example.com/project.git")).toBe(
    "https://example.com/project.git"
  );

  for (const unsafe of [
    "../license",
    "./project",
    "/Users/alice/project",
    "C:\\Users\\alice\\project",
    "file:///tmp/project",
    "git+file:///tmp/project",
    "git:relative-project",
    "example.com/project"
  ]) {
    expect(() => normalizeSourceUrl(unsafe)).toThrow(/remote source URL/i);
  }
});

it("parses SPDX expressions with the real parser and extracts an explicit README License section", async () => {
  const {
    extractReadmeLicenseSection,
    validateAttributableLicenseText,
    validateSpdxExpression
  } = await import("../license-compliance.mjs");
  expect(validateSpdxExpression("MIT OR Apache-2.0")).toBe("MIT OR Apache-2.0");
  expect(() => validateSpdxExpression("MIT plus whatever")).toThrow(/SPDX/i);
  expect(validateAttributableLicenseText(abstractLicense, "fixture MIT license"))
    .toBe(abstractLicense);
  for (const incomplete of ["", "MIT", "See the license online."]) {
    expect(() => validateAttributableLicenseText(incomplete, "fixture license"))
      .toThrow(/complete.*license text/i);
  }

  const readme = [
    "# Package",
    "",
    "## License",
    "",
    "(MIT)",
    "",
    "Copyright (c) Example Author",
    "",
    "Permission is hereby granted, free of charge, to any person obtaining a copy.",
    "",
    "## Contributing",
    "Do not include this section."
  ].join("\n");
  expect(extractReadmeLicenseSection(readme, "README.md")).toEqual({
    kind: "readme",
    source: "README.md#License",
    text: [
      "(MIT)",
      "",
      "Copyright (c) Example Author",
      "",
      "Permission is hereby granted, free of charge, to any person obtaining a copy."
    ].join("\n")
  });
});

it("requires version-locked audited overrides with reason, remote source, full text, and exact use", async () => {
  const {
    assertNoUnusedLicenseOverrides,
    takeLicenseOverride,
    validateLicenseOverrides
  } = await import("../license-compliance.mjs");
  const valid = {
    schemaVersion: 1,
    packages: {
      "abstract-logging@2.0.1": {
        reason: "The published package links to a license page without including its text.",
        source: "https://jsumners.mit-license.org/",
        licenseText: abstractLicense
      }
    }
  };
  const overrides = validateLicenseOverrides(valid);
  const used = new Set();
  expect(takeLicenseOverride(overrides, "abstract-logging@2.0.1", used)).toMatchObject({
    kind: "override",
    source: "https://jsumners.mit-license.org/",
    reason: expect.stringContaining("published package"),
    text: expect.stringContaining("Copyright © 2014 James Sumners")
  });
  expect(() => assertNoUnusedLicenseOverrides(overrides, used)).not.toThrow();

  expect(() => assertNoUnusedLicenseOverrides(validateLicenseOverrides(valid), new Set()))
    .toThrow(/unused.*abstract-logging@2\.0\.1/i);
  const mismatched = validateLicenseOverrides(valid);
  const mismatchedUse = new Set();
  expect(takeLicenseOverride(mismatched, "abstract-logging@2.0.2", mismatchedUse))
    .toBeUndefined();
  expect(() => assertNoUnusedLicenseOverrides(mismatched, mismatchedUse))
    .toThrow(/unused.*abstract-logging@2\.0\.1/i);
  for (const missing of ["reason", "source"]) {
    const invalid = structuredClone(valid);
    delete invalid.packages["abstract-logging@2.0.1"][missing];
    expect(() => validateLicenseOverrides(invalid)).toThrow(new RegExp(missing, "i"));
  }
});

it("keeps the audited abstract-logging override reviewable in the repository", async () => {
  const path = fileURLToPath(new URL("../license-overrides.json", import.meta.url));
  const override = JSON.parse(await readFile(path, "utf8"))
    .packages["abstract-logging@2.0.1"];
  expect(override.reason).toMatch(/published package/i);
  expect(override.source).toBe("https://jsumners.mit-license.org/");
  expect(override.licenseText).toBe(abstractLicense);
});
