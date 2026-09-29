import esbuild from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import process from "process";

const args = process.argv.slice(2);
const watch = args.includes("--watch");
const tests = args.includes("--tests");

mkdirSync("dist", { recursive: true });
mkdirSync("build", { recursive: true });

if (tests) {
  await esbuild.build({
    entryPoints: ["tests/run.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    logLevel: "info",
    outfile: "build/tests.js",
  });
  process.exit(0);
}

// The plugin sandbox code. Figma loads it as a plain script, so it is bundled
// as an IIFE with no imports left.
const codeOptions = {
  entryPoints: ["src/code.ts"],
  bundle: true,
  format: "iife",
  target: "es2018",
  logLevel: "info",
  outfile: "dist/code.js",
  sourcemap: false,
};

// The UI runs in an iframe and is inlined into one HTML file, which is what the
// manifest's `ui` field expects.
const uiOptions = {
  entryPoints: ["src/ui.ts"],
  bundle: true,
  format: "iife",
  target: "es2018",
  logLevel: "warning",
  write: false,
  sourcemap: false,
};

async function buildOnce() {
  await esbuild.build(codeOptions);
  const ui = await esbuild.build(uiOptions);
  const script = ui.outputFiles[0].text;
  const template = readFileSync("src/ui.html", "utf8");
  const html = template.replace("<!-- ui script -->", "<script>" + script + "</script>");
  writeFileSync("dist/ui.html", html);
  console.log("wrote dist/code.js and dist/ui.html");
}

if (watch) {
  const context = await esbuild.context(codeOptions);
  await context.watch();
  await buildOnce();
  console.log("watching...");
} else {
  await buildOnce();
}
