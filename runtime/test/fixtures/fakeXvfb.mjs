#!/usr/bin/env node
// A stand-in for Xvfb: announces display :99 on the -displayfd descriptor and stays up until killed.
import { writeSync } from "node:fs";
const args = process.argv.slice(2);
if (process.env.FAKE_XVFB_FAILS === "1") process.exit(1);
writeSync(Number(args[args.indexOf("-displayfd") + 1]), "99\n");
setInterval(() => {}, 1 << 30);
