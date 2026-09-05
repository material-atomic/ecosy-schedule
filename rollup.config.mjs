import esbuild from "rollup-plugin-esbuild";
import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import path from "path";
import { glob } from "glob";

/* Every module is its own entry, so a subpath import pulls in that file and
   its imports rather than the whole package.

   Declarations come from `tsc --emitDeclarationOnly` in the build script;
   esbuild does the JavaScript. Keeping the two apart is what lets this build
   work whatever TypeScript version the package is on — @rollup/plugin-typescript
   is pinned to the compiler's internals and breaks on a major upgrade. */
const inputFiles = glob.sync("src/**/*.ts", {
  ignore: ["src/**/*.test.ts", "src/**/*.spec.ts"],
});

const input = inputFiles.reduce((acc, file) => {
  const relativePath = path.relative("src", file);
  acc[relativePath.replace(path.extname(relativePath), "")] = file;
  return acc;
}, {});

const external = [/^node:/];

const plugins = () => [resolve(), commonjs(), esbuild({ target: "es2020", minify: true })];

const shared = { input, external, plugins: plugins() };

export default [
  {
    ...shared,
    output: {
      dir: "dist",
      format: "cjs",
      entryFileNames: "[name].js",
      chunkFileNames: "[name]-[hash].js",
      exports: "named",
      preserveModules: true,
      preserveModulesRoot: "src",
      interop: "auto",
      sourcemap: true,
    },
  },
  {
    ...shared,
    plugins: plugins(),
    output: {
      dir: "dist",
      format: "esm",
      entryFileNames: "[name].mjs",
      chunkFileNames: "[name]-[hash].mjs",
      exports: "named",
      preserveModules: true,
      preserveModulesRoot: "src",
      interop: "auto",
      sourcemap: true,
      generatedCode: { symbols: true },
    },
  },
];
