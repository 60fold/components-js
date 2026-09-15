import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  PACKAGE_DIRECTORIES,
  assertPackageDirectory,
  assertReleaseVersion,
  findLocalDependencySpecifiers,
} from "./release-utils.mjs";
import { stampReleaseManifests, stampReleaseSuiteManifests } from "./stamp-release-manifests.mjs";
import { finalizeAngularPackage } from "./finalize-angular-package.mjs";

const tempRoot = await mkdtemp(path.join(tmpdir(), "sixtyfold-release-tools-test-"));

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

test("release versions are exact stable or RC versions", () => {
  assert.equal(assertReleaseVersion("1.0.0"), "1.0.0");
  assert.equal(assertReleaseVersion("1.0.0-rc.2"), "1.0.0-rc.2");
  assert.throws(() => assertReleaseVersion("latest"));
  assert.throws(() => assertReleaseVersion("1.0.0-beta.1"));
});

test("package directories are validated", () => {
  assert.equal(assertPackageDirectory("stock"), "stock");
  assert.throws(() => assertPackageDirectory("all"));
});

test("every publishable workspace package is covered by the release gates", async () => {
  const packagesRoot = path.resolve(import.meta.dirname, "../packages");
  for (const entry of await readdir(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = JSON.parse(
      await readFile(path.join(packagesRoot, entry.name, "package.json"), "utf8"),
    );
    assert.ok(
      manifest.private === true || PACKAGE_DIRECTORIES.includes(entry.name),
      `${manifest.name} must be private until it joins the release gates`,
    );
  }
});

test("packed manifests reject workspace and other local dependency protocols", () => {
  assert.deepEqual(
    findLocalDependencySpecifiers({
      dependencies: {
        "@sixtyfold/core": "workspace:^",
        fixture: "file:../fixture",
        local: "../local",
        zod: "4.4.3",
      },
      peerDependencies: {
        linked: "link:../../linked",
        react: ">=18 <20",
      },
    }),
    [
      {
        field: "dependencies",
        name: "@sixtyfold/core",
        specifier: "workspace:^",
      },
      {
        field: "dependencies",
        name: "fixture",
        specifier: "file:../fixture",
      },
      {
        field: "dependencies",
        name: "local",
        specifier: "../local",
      },
      {
        field: "peerDependencies",
        name: "linked",
        specifier: "link:../../linked",
      },
    ],
  );
});

test("renderer benchmark import maps resolve the public Core entry point", async () => {
  for (const chart of ["line", "stock"]) {
    const html = await readFile(path.resolve(`benchmarks/${chart}/index.html`), "utf8");
    const importMapSource = html.match(/<script type="importmap">\s*([\s\S]*?)\s*<\/script>/u)?.[1];

    assert.ok(importMapSource, `${chart} benchmark defines an import map`);
    const importMap = JSON.parse(importMapSource);
    assert.equal(importMap.imports["@sixtyfold/core"], "/packages/core/dist/index.js");
  }
});

test("release stamping changes only the selected package", async () => {
  const root = path.join(tempRoot, "stamp");
  for (const [index, directory] of PACKAGE_DIRECTORIES.entries()) {
    const packageDir = path.join(root, "packages", directory);
    await mkdir(packageDir, { recursive: true });
    await writeFile(
      path.join(packageDir, "package.json"),
      `${JSON.stringify({
        name: `@sixtyfold/${directory}`,
        version: directory === "stock" ? "1.3.1" : `1.${index}.0`,
      })}\n`,
    );
  }
  await stampReleaseManifests({
    root,
    directory: "stock",
    version: "1.3.1-rc.1",
  });
  for (const [index, directory] of PACKAGE_DIRECTORIES.entries()) {
    const manifest = JSON.parse(
      await readFile(path.join(root, "packages", directory, "package.json"), "utf8"),
    );
    if (directory === "stock") {
      assert.equal(manifest.version, "1.3.1-rc.1");
    } else {
      assert.equal(manifest.version, `1.${index}.0`);
    }
  }
});

test("suite release stamping applies one exact RC to every package", async () => {
  const root = path.join(tempRoot, "suite-stamp");
  for (const directory of PACKAGE_DIRECTORIES) {
    const packageDir = path.join(root, "packages", directory);
    await mkdir(packageDir, { recursive: true });
    await writeFile(
      path.join(packageDir, "package.json"),
      `${JSON.stringify({
        name: `@sixtyfold/${directory}`,
        version: "1.0.0",
        dependencies: directory === "line" ? { "@sixtyfold/core": "workspace:^" } : undefined,
      })}\n`,
    );
  }
  await stampReleaseSuiteManifests({
    root,
    version: "1.0.0-rc.1",
  });
  for (const directory of PACKAGE_DIRECTORIES) {
    const manifest = JSON.parse(
      await readFile(path.join(root, "packages", directory, "package.json"), "utf8"),
    );
    assert.equal(manifest.version, "1.0.0-rc.1");
  }
  const line = JSON.parse(await readFile(path.join(root, "packages/line/package.json"), "utf8"));
  assert.deepEqual(line.dependencies, { "@sixtyfold/core": "^1.0.0-rc.1" });
});

test("the public release workflow supports selected and resumable suite releases", async () => {
  const workflow = await readFile(path.resolve(".github/workflows/release.yml"), "utf8");
  const stampStep = workflow.match(
    /- name: Apply the suite release version[\s\S]*?\n\n      - name:/u,
  )?.[0];
  const packStep = workflow.match(
    /- name: Build and pack release artifacts[\s\S]*?\n\n      - name:/u,
  )?.[0];
  const availabilityStep = workflow.match(
    /- name: Check release version availability[\s\S]*?\n\n      - name:/u,
  )?.[0];
  const publishStep = workflow.match(
    /- name: Publish with npm trusted publishing[\s\S]*?\n\n  github-release:/u,
  )?.[0];
  const githubReleaseStep = workflow.match(
    /- name: Create the version tag and GitHub release[\s\S]*$/u,
  )?.[0];

  assert.match(workflow, /options:\s*\n\s+- all/u);
  assert.ok(stampStep, "release workflow contains the suite stamp step");
  assert.match(stampStep, /stamp-release-manifests\.mjs\s+--all/u);
  assert.doesNotMatch(stampStep, /--package/u);
  assert.ok(packStep, "release workflow contains the selected-package pack step");
  assert.match(packStep, /RELEASE_PACKAGE.*mcp.*pnpm run mcp:catalog/u);
  assert.match(
    packStep,
    /packages=\(core line stock ssr themes react vue angular svelte solid mcp\)/u,
  );
  assert.match(
    packStep,
    /build_packages=\(core line stock ssr themes react vue angular svelte solid\)/u,
  );
  assert.doesNotMatch(packStep, /pnpm -r/u);
  assert.match(
    packStep,
    /pnpm_config_verify_deps_before_run:\s*["']false["']/u,
    "post-stamp pnpm commands must not trigger an automatic frozen install",
  );
  assert.ok(availabilityStep, "release workflow checks exact npm versions");
  assert.match(availabilityStep, /already exists and will be skipped/u);
  assert.ok(publishStep, "release workflow contains the trusted publishing step");
  assert.match(
    publishStep,
    /packages=\(core line stock themes ssr react vue angular svelte solid mcp\)/u,
  );
  assert.match(publishStep, /Skipping existing/u);
  assert.match(publishStep, /grep -q ["']E409["']/u);
  assert.match(publishStep, /waiting before one safe retry/u);
  assert.ok(githubReleaseStep, "release workflow contains the GitHub release step");
  assert.match(githubReleaseStep, /Skipping existing GitHub release/u);
});

test("the dogfood release disables pnpm dependency revalidation after suite stamping", async () => {
  const workflow = await readFile(path.resolve(".github/workflows/release-dogfood.yml"), "utf8");
  const rebuildStep = workflow.match(
    /- name: Rebuild exact RC packages and MCP metadata[\s\S]*?\n\n      - name:/u,
  )?.[0];
  const packStep = workflow.match(
    /- name: Pack the complete RC suite[\s\S]*?\n\n      - name:/u,
  )?.[0];

  assert.ok(rebuildStep, "dogfood workflow contains the post-stamp rebuild step");
  assert.ok(packStep, "dogfood workflow contains the post-stamp pack step");
  for (const step of [rebuildStep, packStep]) {
    assert.match(step, /pnpm_config_verify_deps_before_run:\s*["']false["']/u);
  }
  assert.match(
    rebuildStep,
    /build_packages=\(core line stock ssr themes react vue angular svelte solid\)/u,
  );
  assert.doesNotMatch(rebuildStep, /pnpm -r/u);
});

test("stable install guidance does not point users to the prerelease channel", async () => {
  const readmes = [
    "README.md",
    ...PACKAGE_DIRECTORIES.map((directory) => `packages/${directory}/README.md`),
  ];

  for (const readme of readmes) {
    const source = await readFile(path.resolve(readme), "utf8");
    assert.doesNotMatch(source, /@sixtyfold\/[a-z]+@next\b/u, readme);
  }

  const rootReadme = await readFile(path.resolve("README.md"), "utf8");
  const mcpReadme = await readFile(path.resolve("packages/mcp/README.md"), "utf8");
  assert.match(rootReadme, /@sixtyfold\/mcp@1(?![0-9])/u);
  assert.match(mcpReadme, /@sixtyfold\/mcp@1(?![0-9])/u);
});

test("suite release stamping validates all manifests before writing any", async () => {
  const root = path.join(tempRoot, "suite-stamp-atomic");
  for (const directory of PACKAGE_DIRECTORIES) {
    const packageDir = path.join(root, "packages", directory);
    await mkdir(packageDir, { recursive: true });
    await writeFile(
      path.join(packageDir, "package.json"),
      `${JSON.stringify({
        name: `@sixtyfold/${directory}`,
        version: directory === "stock" ? "1.0.1" : "1.0.0",
      })}\n`,
    );
  }
  await assert.rejects(() =>
    stampReleaseSuiteManifests({
      root,
      version: "1.0.0-rc.1",
    }),
  );
  for (const directory of PACKAGE_DIRECTORIES) {
    const manifest = JSON.parse(
      await readFile(path.join(root, "packages", directory, "package.json"), "utf8"),
    );
    assert.equal(manifest.version, directory === "stock" ? "1.0.1" : "1.0.0");
  }
});

test("Angular packaging resolves each independent Sixtyfold peer version", async () => {
  const root = path.join(tempRoot, "angular");
  const versions = {
    core: "1.2.0",
    line: "1.4.3",
    stock: "2.0.0",
  };
  for (const [directory, version] of Object.entries(versions)) {
    const packageDir = path.join(root, "packages", directory);
    await mkdir(packageDir, { recursive: true });
    await writeFile(
      path.join(packageDir, "package.json"),
      `${JSON.stringify({ name: `@sixtyfold/${directory}`, version })}\n`,
    );
  }
  const angularDist = path.join(root, "packages/angular/dist");
  await mkdir(angularDist, { recursive: true });
  await writeFile(
    path.join(angularDist, "package.json"),
    `${JSON.stringify({
      name: "@sixtyfold/angular",
      version: "3.1.0",
      peerDependencies: {
        "@sixtyfold/core": "workspace:^",
        "@sixtyfold/line": "workspace:^",
        "@sixtyfold/stock": "workspace:^",
        "@angular/core": ">=20 <23",
      },
    })}\n`,
  );

  await finalizeAngularPackage(root);
  const manifest = JSON.parse(await readFile(path.join(angularDist, "package.json"), "utf8"));
  assert.deepEqual(manifest.peerDependencies, {
    "@sixtyfold/core": "^1.2.0",
    "@sixtyfold/line": "^1.4.3",
    "@sixtyfold/stock": "^2.0.0",
    "@angular/core": ">=20 <23",
  });
});
