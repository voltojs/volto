#!/usr/bin/env node
/**
 * The `volto` executable. All behaviour lives in `cli.ts`; this wrapper only
 * bridges the process (argv, exit code, signals) to it.
 */
import { main } from "./cli.js";

const code = await main(process.argv.slice(2));
process.exit(code);